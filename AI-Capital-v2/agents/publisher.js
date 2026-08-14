'use strict';

/**
 * publisher.js — 記事生成エージェント（最終工程）
 * 参照: final_decisions, agent_votes, market_data, portfolio_status, candidate_assets, positions
 * LLM使用: YES（記事生成・X投稿文のみ）
 */

const fs            = require('fs');
const path          = require('path');
const { ask }       = require('../lib/ollama');
const sheets        = require('../lib/sheets');
const { saveDraft } = require('../lib/noteDraft');
const { generatePortfolioChart, generateFundHistoryChart } = require('../lib/chartGenerator');
const thumbGen      = require('../lib/thumbnailGenerator');
const { fgLabel, fgDisplay }     = require('../lib/marketUtils');
const { validateArticle }        = require('../lib/articleValidator');
const { recordQuality, buildProgressLog } = require('../lib/qualityTracker');
const { scoreArticle, PUBLISH_SCORE_THRESHOLD } = require('../lib/qualityScorer');
const { autoFixLayout } = require('../lib/articleAutoFix');
const { runEditorReview } = require('../lib/editorReview');
const { getDisplayCandidates } = require('../lib/candidateGroups');
const { appendFailLog } = require('../lib/failArticleLog');
const development = require('./development');

// 下書きエディタURL（editor.note.com/notes/xxxxx）を公開後の記事URL（note.com/{account}/n/xxxxx）に変換する
// note.comはID自体を下書き作成時に払い出すため、公開してもIDは変わらずドメイン/パスのみ変わる
function toPublicNoteUrl(editorUrl) {
  if (!editorUrl) return editorUrl;
  const m = editorUrl.match(/\/notes\/([a-zA-Z0-9]+)/);
  const noteId = m ? m[1] : null;
  const account = process.env.NOTE_ID;
  if (!noteId || !account) return editorUrl;
  return `https://note.com/${account}/n/${noteId}`;
}

// 部署別の日替わり視点ローテーション（日付ベースの決定的選定 = 過去日再生成時も同じ結果になる）
function pickRotation(dateStr, list) {
  const days = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 86400000);
  const idx = ((days % list.length) + list.length) % list.length;
  return list[idx];
}

const SHIN_ANGLES = [
  'テクニカル分析（チャートパターン・トレンドライン）',
  'センチメント分析（Fear & Greedに基づく市場心理）',
  'マクロ経済（金利・インフレ・雇用など背景要因）',
  '市場循環（強気/弱気サイクルの現在地）',
  '資金フロー（資金がどの資産クラスへ向かっているか）',
  'セクター比較（半導体・ハイテク・金など資産クラス間の相対強弱）',
  'トレンド分析（短期・中期モメンタムの方向）',
  '需給分析（買われすぎ・売られすぎのシグナル）',
  'モメンタム（変化率の勢い・加速度）',
];

const MISAKI_ANGLES = [
  '集中投資率（特定銘柄への偏り）',
  'ドル円（為替リスク）',
  'VIX（市場ボラティリティ指標）',
  '現金比率（守備力としての現金余力）',
  '流動性（換金のしやすさ）',
  'ボラティリティ（値動きの荒さ）',
  '相関性（保有銘柄同士の値動きの連動リスク）',
  'イベントリスク（決算・経済指標・地政学リスクなど予定材料）',
  '急落耐性（急落時にファンドがどれだけ耐えられるか）',
  '分散効果（銘柄数・資産クラスの分散度合い）',
];

const GAI_ANGLES = [
  '判断ロジック（結論に至る筋道が通っているか）',
  '証拠不足（主張を裏付ける数値・根拠は十分か）',
  'データ品質（使用した数値の出典・信頼度）',
  '説明責任（なぜその判断か説明しきれているか）',
  'ルール逸脱（AI Capitalの既定ルールから外れていないか）',
  '例外処理（通常と異なる状況への対応は妥当か）',
  '判断保留（結論を急ぎすぎていないか）',
  '整合性（部署間の主張に矛盾がないか）',
];

// 秘書室長所見（相沢レイ）②の締めの切り口ローテーション（日付ベースの決定的選定）。
// 「AI Capitalが今日学んだこと」という同じ骨格が毎日続くのを防ぐため、日替わりで視点を変える。
const REI_ANGLES = [
  '今日の議論から見えた課題',
  '明日以降の改善点',
  '組織として得た学び',
  '判断基準の変化（あれば。なければ「変化はなかった」と正直に書く）',
  '部署間の温度差から見えたこと',
  '次に検証すべき仮説',
];

// 10日以上前の画像ファイルを自動削除
function pruneOldImages() {
  const RETAIN_DAYS = 10;
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  const dirs = [
    path.join(__dirname, '../data/charts'),
    path.join(__dirname, '../data/thumbnails'),
  ];
  let removed = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(png|jpg|jpeg)$/i.test(file)) continue;
      const fp = path.join(dir, file);
      const mtime = fs.statSync(fp).mtimeMs;
      if (mtime < cutoff) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
  }
  if (removed > 0) console.log(`[publisher] 古い画像 ${removed}件 削除（${RETAIN_DAYS}日超）`);
}

// ── note.com 用システムプロンプト ────────────────────────────
// Phase1: lib/promptParts/ 配下（constitution/rules/templates/characters）に分割済み。
// Phase2: buildNoteSystemPrompt() で動的組み立てが可能に。
// Phase3: 当日 agent_recommendations に登場した部署だけを activeCharacters として渡す（characters動的ロード）。
//         実際の組み立ては publish() 内で行う（その日の recs が必要なため、モジュール読み込み時には確定できない）。
const { buildNoteSystemPrompt, ALL_CHARACTERS } = require('../lib/promptParts');

// 部署名（agent_recommendations.department の日本語表記）→ characters/*.js のキー
// 相沢レイ（rei）はどの部署の投票も持たない編集役のため、このマップには含めず常時有効とする。
const DEPT_TO_CHARACTER = {
  'マーケット分析部':     'shin',
  'リスク管理部':         'misaki',
  'ポートフォリオ管理部': 'aoi',
  '審査部':               'gai',
};

// その日実際に agent_recommendations へ登場した部署の character キー一覧を返す。
// 相沢レイは常に含める。recs が空/対応不明な場合は安全側で全部署を含める（既存の完全ロールバック相当の動作）。
function computeActiveCharacters(recs) {
  const fromRecs = [...new Set(
    (recs || []).map(r => DEPT_TO_CHARACTER[r.department]).filter(Boolean)
  )];
  if (fromRecs.length === 0) return ALL_CHARACTERS;
  return [...new Set([...fromRecs, 'rei'])];
}

// ── X（旧Twitter/SNS）用システムプロンプト ──────────────────────

const X_SYSTEM = `
あなたはAI Capital「広報・記録部」です。
今日のAI社員市場会議の内容から、X（旧Twitter）向けの投稿文を1つ作成してください。

【目的（最重要）】
X投稿は「記事の要約」ではなく、「AI会社の会議を覗き見したくなる予告編」です。
市場を解説するのではなく、「AI社員たちがどんな議論をして、どう決断したのか気になる」と思わせることだけを目指す。

【固定構成（この順番で必ず出力すること）】

① 冒頭（固定）
📊 AI Capital 市場会議

② 今日最も議論になったテーマを1つだけ（2項対立）
その日の会議で最も対立した論点を、テーマ1つ・選択肢2行で表現する。
意味の近い問いを2つ並べて重複させない。1つの対立軸だけに絞ること。
冒頭の導入フレーズは以下からその日の会議の雰囲気に合わせて選ぶ（毎回同じにしない）:
  ・「本日のテーマは──」
  ・「今日AI社員が最も議論したのは──」
  ・「会議が最も白熱したテーマは──」
  ・「今日の市場会議で意見が割れたのは──」
  ・「本日のAI Capital会議では──」

形式:
[導入フレーズ]

[絵文字A] [選択肢A（〜か）]
[絵文字B] [選択肢B（〜か）]

絵文字は対立する2択のキャラクターを直感的に示すもの（例: 📈 vs 💵、🟢 vs 🔴 など）を自由に選んでよい。

③ 最も対立した2部署の意見を1文ずつ抜粋
4部署全員を書く必要はない。対立が最も鮮明な2部署だけを選ぶ。
絵文字: マーケット分析部=📈、リスク管理部=🛡️、ポートフォリオ管理部=💼、審査部=🔍
形式:

[絵文字] [部署名]
「[実際の主張を20字以内で簡潔に]」

[絵文字] [部署名]
「[実際の主張を20字以内で簡潔に]」

④ 会議の結論を知りたくなる締め（疑問形1文）
「会議の続き・結論が気になる」と思わせる疑問を1文だけ書く。
市場の解説や自分の意見は書かない。以下のような結論志向の問いにする:
  ・「AI社員4部署はどんな議論を経て今日の結論を出したのか？」
  ・「最終的にAI会社はどの判断を採用したのか？」
  ・「会議ではどの部署の意見が採用されたのか？」
文言はその日の会議の流れに合わせて自由に変えてよい（毎回同じにしない）。
結論・銘柄名・金額・判断ラベルは書かない。

⑤ 固定フッター（この文章をそのまま使う）
AI社員たちが市場データをどう分析し、どんな議論を経て結論を出したのかを毎日公開しています。

続きはnote👇
[コンテキスト内の「【note URL】」に続くURLをそのまま貼る]

#AI投資記録
#AI観測プロジェクト

【禁止事項】
- 最終判断・買付銘柄・金額・シグナル名を書く
- 「観測ポジション構築」「見送り」「賛成4票」など結論そのものを書く
- 英語技術用語（WAIT/ACCUMULATE/BUY/DEFEND等）
- 投資推奨・断定表現
- 市場の解説・記事の要約
- ②の選択肢で意味の重複した2行を並べる

【制約】
- 投稿全体は300文字以内
- ハッシュタグは最後の2行にまとめて付ける

【出力】
投稿文のみ。ラベル・説明・番号・前置き一切不要。
`.trim();

// ── 部署見出し検出（###の有無・絵文字の有無どちらでも一致させる） ──────
// 品質改善ループの再生成では、直前の完全後処理済みテキスト（###除去済み・絵文字付与済み）を
// 「前回生成した記事全文」としてLLMに渡して修正させるため、2周目以降のLLM生の出力見出しが
// 「### 部署名（キャラ名）」ではなく「😎 部署名（キャラ名）」（###なし）になることがある
// （2026-08-13に判明。この形式ズレにより、以前は machine挿入が無言でスキップされていた）。
// note.indexOf() による厳密一致ではなく、### の有無・絵文字の有無を両方許容するregexで検出する。
const DEPT_HEADER_META = {
  'マーケット分析部':     { full: 'マーケット分析部（神谷シン）',     emoji: '😎' },
  'リスク管理部':         { full: 'リスク管理部（黒崎ミサキ）',       emoji: '🤨' },
  'ポートフォリオ管理部': { full: 'ポートフォリオ管理部（橘アオイ）', emoji: '🙂' },
  '審査部':               { full: '審査部（鬼塚ガイ）',               emoji: '🧐' },
};

function escapeRegExpPub(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 免責事項の開始位置を探す（fromIndex以降）。装飾付き `*...*`（初回生成直後）と
// 装飾なし平文3行版（後処理㉕通過後・品質改善ループ2周目以降）の両方にマッチする。
// 固定文字列 '\n*AI Capital' のみで検出すると2周目以降にヒットせず、▼CHART▼等の
// 挿入位置が末尾（既存免責事項のさらに後ろ）にずれる不具合があった（2026-08-14修正）。
function findDisclaimerIndex(note, fromIndex = 0) {
  const rest = note.slice(fromIndex);
  const m = rest.match(/\*?AI Capitalは投資助言サービスではありません/);
  return m ? fromIndex + m.index : -1;
}

function findDeptHeader(note, dept) {
  const meta = DEPT_HEADER_META[dept];
  if (!meta) return null;
  const re = new RegExp(`#{0,3}\\s*(?:${meta.emoji}\\s*)?${escapeRegExpPub(meta.full)}`);
  const m = re.exec(note);
  return m ? { index: m.index, length: m[0].length } : null;
}

// 部署セクションの終端（次の部署見出し・次のメジャーセクション見出しのいずれか手前）を求める。
// ### 有無・絵文字有無のどちらの状態でも対応する。
function findDeptSectionEnd(note, fromIndex) {
  const candidates = [
    note.indexOf('\n### ', fromIndex),
    note.indexOf('\n## ',  fromIndex),
  ];
  const emojiRe = /\n(?:😎|🤨|🙂|🧐|⚖️)/;
  const rest = note.slice(fromIndex);
  const emojiMatch = emojiRe.exec(rest);
  if (emojiMatch) candidates.push(fromIndex + emojiMatch.index);
  const valid = candidates.filter(p => p >= 0);
  return valid.length > 0 ? Math.min(...valid) : note.length;
}

// ── 【最終提案】ブロックを各部署セクションへ機械的に挿入 ──────
// LLMの出力形式に依存せず確実にフォーマットを統一する。
// 各部署見出しの末尾（次の見出しの直前）に挿入する。
function injectRecommendations(note, recs) {
  for (const rec of recs) {
    if (!DEPT_HEADER_META[rec.department]) continue;

    const header = findDeptHeader(note, rec.department);
    if (!header) continue;
    const headerIdx = header.index;

    // agent_recommendations は amount / department_recommendations は recommended_amount
    const amt = parseInt(rec.amount || rec.recommended_amount || 0);
    const action = rec.recommendation_type || rec.action || 'WAIT';
    const assetName = rec.asset_name || 'なし';

    let recLine;
    if (amt > 0 && assetName !== 'なし' && action !== 'WAIT' && action !== 'DEFEND') {
      recLine = `${assetName} ¥${amt.toLocaleString()}`;
    } else {
      recLine = '今回は見送ります';
    }

    // 次のセクション見出しの直前に挿入
    const afterHeader = headerIdx + header.length;
    const insertPos = findDeptSectionEnd(note, afterHeader);

    // 既に「推奨：」がある場合はスキップ（二重挿入防止）
    const sectionContent = note.slice(headerIdx, insertPos);
    if (sectionContent.includes('推奨：')) continue;

    // 要約末尾の余分な空行を除去し、推奨の後に空行を追加
    // 結果: "...要約\n推奨：\nrecLine\n\n### 次の部署"
    const trimmedBefore = note.slice(0, insertPos).trimEnd();
    note = trimmedBefore + `\n推奨：\n${recLine}\n` + note.slice(insertPos);
  }
  return note;
}

// ── ② 部署推奨額 + 最終判断 視覚ブロック ────────────────────
const DEPT_FIRST_NAME = {
  'マーケット分析部':     '神谷',
  'リスク管理部':         '黒崎',
  'ポートフォリオ管理部': 'アオイ',
  '審査部':               '鬼塚',
};
const DEPT_ORDER = ['マーケット分析部', 'リスク管理部', 'ポートフォリオ管理部', '審査部'];

function injectRecommendationSummary(note, recs, decision, pf) {
  // 「##」の有無・⚖️バリエーションセレクター(U+FE0F)の有無・空白の揺れをすべて許容する。
  // LLMは初回生成では「## ⚖️ 最終判断」形式で出力するが、品質改善ループの再生成（repair prompt）を
  // 経ると「##」を省略することがある（2026-07-27の▼HISTORY▼/▼CHART▼検出失敗と同根の問題）。
  const sectionRe    = /#{0,2}\s*⚖️?\s*最終判断/;
  const sectionMatch = sectionRe.exec(note);
  if (!sectionMatch || !decision) {
    console.log('[injectRecommendationSummary] skip: match=', !!sectionMatch, 'decision=', !!decision);
    return note;
  }
  const sectionIdx = sectionMatch.index;
  const sectionLen = sectionMatch[0].length;

  const signalLabel = SIGNAL_JA[decision.final_signal] || decision.final_signal;
  const finalAmt    = parseInt(decision.amount || 0);
  const assetName   = decision.target_asset || 'なし';

  // 全社判断（vote counts from recs）
  // シグナルがACCUMULATE等でも、具体的な銘柄・金額を伴わない提案（例：橘の「なし ¥0」）は
  // 実質的に「見送り」であり「賛成」に数えない（部署判断の表記を実際の議論内容と一致させる）
  const voteCount = { buy: 0, wait: 0, defend: 0 };
  for (const r of recs) {
    const action = (r.recommendation_type || r.action || 'WAIT').toUpperCase();
    const hasConcreteAsset = r.asset_name && r.asset_name !== 'なし' && parseInt(r.amount || 0) > 0;
    if (['BUY', 'ACCUMULATE'].includes(action) && hasConcreteAsset) voteCount.buy++;
    else if (['BUY', 'ACCUMULATE', 'WAIT'].includes(action)) voteCount.wait++;
    else voteCount.defend++;
  }
  const totalVotes = voteCount.buy + voteCount.wait + voteCount.defend;

  const voteParts = [];
  if (totalVotes > 0) {
    voteParts.push(`${totalVotes}部署中`);
    if (voteCount.buy    > 0) voteParts.push(`買付支持${voteCount.buy}`);
    if (voteCount.wait   > 0) voteParts.push(`見送り${voteCount.wait}`);
    if (voteCount.defend > 0) voteParts.push(`反対${voteCount.defend}`);
  }

  const lines = [
    `シグナル：${signalLabel}`,
    `対象：${assetName}`,
    `金額：${finalAmt > 0 ? `¥${finalAmt.toLocaleString()}` : 'なし'}`,
    `部署判断：${voteParts.length > 0 ? voteParts.join(' ') : 'データなし'}`,
  ];

  // 採用経路（どの部署の提案を採用したか）を実データのみから機械判定する。LLMには推測させない。
  // department_recommendations/agent_recommendations と資産名・金額が完全一致する部署があれば
  // その部署の提案採用とみなす。金額のみ集約ロジックで調整されている場合は資産一致のみで判定する。
  if (assetName !== 'なし' && finalAmt > 0) {
    const exactMatch = DEPT_ORDER
      .map(dept => recs.find(r => r.department === dept))
      .find(r => {
        if (!r) return false;
        const rAction = (r.recommendation_type || r.action || 'WAIT').toUpperCase();
        const rAsset  = r.asset_name || 'なし';
        const rAmt    = parseInt(r.amount || r.recommended_amount || 0);
        return ['BUY', 'ACCUMULATE'].includes(rAction) && rAsset === assetName && rAmt === finalAmt;
      });
    if (exactMatch) {
      lines.push(`採用：${DEPT_FIRST_NAME[exactMatch.department]}の提案（${assetName} ¥${finalAmt.toLocaleString()}）を採用`);
    } else {
      const assetOnlyMatch = DEPT_ORDER
        .map(dept => recs.find(r => r.department === dept))
        .find(r => {
          if (!r) return false;
          const rAction = (r.recommendation_type || r.action || 'WAIT').toUpperCase();
          return ['BUY', 'ACCUMULATE'].includes(rAction) && (r.asset_name || 'なし') === assetName;
        });
      lines.push(assetOnlyMatch
        ? `採用：${DEPT_FIRST_NAME[assetOnlyMatch.department]}が提案した銘柄（${assetName}）を採用し、金額は集計ロジックにより¥${finalAmt.toLocaleString()}に決定`
        : `採用：特定部署の提案そのままではなく、複数部署の意見を踏まえた総合判断`);
    }
  }

  const block = lines.join('\n') + '\n\n';

  // セクションヘッダー直後に挿入
  const insertAt = sectionIdx + sectionLen;
  console.log(`[injectRecommendationSummary] 挿入: sectionIdx=${sectionIdx} len=${sectionLen} block=${block.slice(0,20)}...`);
  return note.slice(0, insertAt) + '\n\n' + block + note.slice(insertAt + 1);
}

// ── Rule 33 修正用: 実データの橋渡しヒント（2026-08-14追加） ──────────────
// Rule33（審査部の否定評価と結論の論理橋渡し不足）の再生成では、警告メッセージだけでは
// LLMが「何を根拠に橋渡し文を書けばよいか」が曖昧になり、実データと異なる理由を
// 創作したり、橋渡しを付け足せずに終わることがある。ここで各部署の実際の推奨内容
// （銘柄・金額・見送りの別）と最終判断を機械的に列挙し、「この事実のみを根拠にせよ」と
// 明示することで、LLMに推測・創作させず実データに基づいた橋渡しを書かせる。
const RULE33_DEPT_NAMES = {
  'マーケット分析部':     '神谷シン',
  'リスク管理部':         '黒崎ミサキ',
  'ポートフォリオ管理部': '橘アオイ',
  '審査部':               '鬼塚ガイ',
};

function buildRule33DataHint(recs, decision) {
  const lines = (recs ?? []).map(r => {
    const name   = RULE33_DEPT_NAMES[r.department] || r.department;
    const asset  = r.asset_name || 'なし';
    const amt    = parseInt(r.amount || r.recommended_amount || 0);
    const action = (r.recommendation_type || r.action || 'WAIT').toUpperCase();
    const desc = (['BUY', 'ACCUMULATE'].includes(action) && asset !== 'なし' && amt > 0)
      ? `${asset} ¥${amt.toLocaleString()}を推奨`
      : '見送りを推奨';
    return `・${name}（${r.department}）: ${desc}`;
  });

  const finalLine = decision
    ? `・最終判断: ${decision.target_asset || 'なし'}` +
      (parseInt(decision.amount || 0) > 0 ? ` ¥${parseInt(decision.amount).toLocaleString()}` : '') +
      '（採用）'
    : null;

  return (
    '【Rule33修正のための実データ（推測・創作禁止。この事実のみを根拠に橋渡しの一文を書くこと）】\n' +
    lines.join('\n') + (finalLine ? `\n${finalLine}` : '') + '\n' +
    '上記の実データのみを根拠に、否定的に評価した部署の主張と、実際に支持した結論（判断：欄のラベル）との' +
    '間の橋渡しを一文で明示すること。「ただし」「それでも」「一方で」等の接続語を使い、なぜ他部署の提案' +
    'ではなくこの結論を支持するのかを、上記の実際の推奨内容（銘柄・金額・見送り）にのみ基づいて説明する' +
    'こと。上記に記載のない理由・数値を創作してはならない。'
  );
}

// ── 記事冒頭 結論ブロック生成 ────────────────────────────────
const SIGNAL_JA = {
  BUY:        '買付',
  ACCUMULATE: '観測ポジション構築',
  WAIT:       '監視継続',
  DEFEND:     '防御態勢',
  SELL:       '売却',
};

function buildMarketCheckBlock(mkt) {
  const fg   = parseFloat(mkt.fear_greed ?? 50);
  const vix  = parseFloat(mkt.vix ?? 15);
  const n100 = parseFloat(mkt.nasdaq100 ?? 0);
  const sp5  = parseFloat(mkt.sp500 ?? 0);
  const ujpy = parseFloat(mkt.usdjpy ?? 150);

  const fgLabel  = fg  <= 25 ? '極端な恐怖' : fg  <= 45 ? '恐怖' : fg  <= 55 ? '中立' : fg  <= 75 ? '強欲' : '極端な強欲';
  const avg      = (n100 + sp5) / 2;
  const mktLabel = avg >= 1.0 ? '上昇' : avg >= 0.2 ? '堅調' : avg >= -0.2 ? '横ばい' : avg >= -1.0 ? '調整' : '下落';
  const vixLabel = vix <= 12 ? '低リスク' : vix <= 20 ? '普通' : vix <= 25 ? '警戒' : vix <= 30 ? '高リスク' : '極端な高リスク';
  const fxLabel  = ujpy <= 140 ? '円高' : ujpy <= 150 ? '中立' : '円安';

  return `📊 AI Capital Market Check

😨 投資家心理
Fear & Greed：${fg}（${fgLabel}）

📉 市場環境
${mktLabel}

⚠️ リスク
VIX：${vix}（${vixLabel}）

💵 為替
USD/JPY：${ujpy}（${fxLabel}）`;
}

/**
 * buildWatchPoints — 現在の市場データから「未来方向のトリガーのみ」を機械生成
 * 現在値ですでに成立している条件は絶対に含めない。
 */
function buildWatchPoints(mkt) {
  const fg   = parseFloat(mkt.fear_greed ?? 50);
  const vix  = parseFloat(mkt.vix ?? 15);
  const n100 = parseFloat(mkt.nasdaq100 ?? 0);
  const points = [];

  // ── Fear & Greed ──────────────────────────────────────
  if (fg <= 25) {
    // 極端な恐怖: さらに下 or 回復方向
    const downThr = Math.max(5,  Math.round(fg - 8));
    const upThr   = Math.round(Math.ceil((fg + 12) / 5) * 5); // e.g. 25→35
    points.push(`Fear & Greed ${downThr}以下 → 恐怖深化、観測ポジション追加を検討`);
    points.push(`Fear & Greed ${upThr}以上 → 恐怖圏緩和を確認、戦略を再評価`);
  } else if (fg <= 45) {
    const downThr = Math.round(Math.floor((fg - 10) / 5) * 5);
    points.push(`Fear & Greed ${downThr}以下 → 恐怖圏突入、複数指標を踏まえ観測ポジションを再評価`);
    points.push(`Fear & Greed 50以上 → 心理の中立化を確認`);
  } else if (fg <= 55) {
    points.push(`Fear & Greed 40以下 → 恐怖圏入り、複数指標を踏まえ投資機会を再評価`);
    points.push(`Fear & Greed 60以上 → 強欲圏に接近、利確タイミングを検討`);
  } else if (fg <= 75) {
    const upThr = Math.round(Math.ceil((fg + 10) / 5) * 5);
    points.push(`Fear & Greed ${upThr}以上 → 過熱注意、新規買付の停止を検討`);
    points.push(`Fear & Greed 55以下 → 心理の冷却を確認、投資機会を再評価`);
  } else {
    points.push(`Fear & Greed 90以上 → 極端な過熱、全ポジション見直し`);
    points.push(`Fear & Greed 70以下 → 過熱の後退を確認`);
  }

  // ── VIX ──────────────────────────────────────────────
  if (vix < 15) {
    points.push(`VIX 18超え → 警戒水準接近、リスク管理を再確認`);
  } else if (vix < 20) {
    // ceil + 3 → 自然な警戒閾値（例: 18.41→22、19.5→23）、5の倍数に丸め
    const warnRaw = Math.ceil(vix) + 3;
    const warn    = Math.round(warnRaw / 2) * 2; // 偶数丸め
    points.push(`VIX ${warn}超え → 警戒水準入り、ポジション構築を一時保留`);
  } else if (vix < 25) {
    points.push(`VIX 25超え → 高リスク局面、防御態勢へ移行`);
    const calmThr = Math.round(Math.floor(vix - 3) / 2) * 2;
    points.push(`VIX ${calmThr}以下 → リスク低下確認、積立再開を検討`);
  } else if (vix < 30) {
    points.push(`VIX 30超え → 危機水準、現金温存を優先`);
    points.push(`VIX 22以下 → リスク後退確認、段階的再投資へ移行`);
  } else {
    const extremeThr = Math.round((vix + 5) / 5) * 5;
    points.push(`VIX ${extremeThr}超え → 危機拡大、全ポジション見直し`);
    points.push(`VIX 25以下 → リスク後退確認、段階的再投資を検討`);
  }

  // ── NASDAQ100 前日比 ──────────────────────────────────
  if (n100 >= 2) {
    points.push(`NASDAQ100 前日比 -1%以下 → 反転シグナル、利確タイミングを評価`);
  } else if (n100 >= 0.5) {
    points.push(`NASDAQ100 前日比 -1.5%以下 → 調整入り確認、複数指標を踏まえ投資機会を再評価`);
  } else if (n100 >= -0.5) {
    points.push(`NASDAQ100 前日比 -2%以下 → 下落加速、複数指標を踏まえ投資機会を再評価`);
    points.push(`NASDAQ100 前日比 +1.5%以上 → 反転シグナル、追加ポジションを検討`);
  } else if (n100 >= -2) {
    // 現在 -0.5〜-2%: さらなる下落 or 回復
    const deeperRaw = Math.floor(n100 * 2) / 2 - 0.5; // 0.5pp 悪化
    const deeperStr = deeperRaw % 1 === 0 ? deeperRaw.toFixed(0) : deeperRaw.toFixed(1);
    points.push(`NASDAQ100 前日比 ${deeperStr}%以下 → 下落加速、複数指標を踏まえさらなる投資機会を再評価`);
    points.push(`NASDAQ100 前日比 +1%以上 → 反転シグナル、ポジション継続を判断`);
  } else {
    // 現在 -2%以下（強い下落中）
    const extremeRaw = Math.floor((n100 - 1) * 2) / 2;
    const extremeStr = extremeRaw % 1 === 0 ? extremeRaw.toFixed(0) : extremeRaw.toFixed(1);
    points.push(`NASDAQ100 前日比 ${extremeStr}%以下 → 暴落水準、新規買付を一時停止`);
    points.push(`NASDAQ100 前日比 0%以上 → 回復シグナル、段階的ポジション追加を評価`);
  }

  return `👀 次回の注目点\n\n` + points.map(p => `・${p}`).join('\n');
}

// ── コンテキスト構築 ─────────────────────────────────────────

// システム内部のエラー文言（オペレーション中断・HARD RULEのシステム異常検知等）を
// 記事本文に技術的因果として断定させないための表示用サニタイズ。
// signalAggregator.js の detectHardIssue / evaluateSecretaryTieBreak が生成する
// 「システム異常/エラーを検知」系の文言のみを対象とし、市場要因によるHARD RULE
// （portfolio_status取得不可・重大リスクイベント等）は対象外（実際の市場根拠のため）。
// final_decisions/agent_votes 等の生データ自体は変更せず、LLMへ渡す表示文言のみを変換する。
const SYSTEM_ERROR_PATTERN = /システム異常\/エラー|システムエラー|Operation was aborted|JSON解析失敗|分析スキップ/i;

function sanitizeDecisionReasonForArticle(reason) {
  if (!reason) return reason;
  if (SYSTEM_ERROR_PATTERN.test(reason)) {
    return '部署間で意見が分かれ、現時点で明確な買付方向を決定する根拠が不足していたため。';
  }
  return reason;
}

function sanitizeVoteCommentForArticle(comment) {
  if (!comment) return comment;
  if (SYSTEM_ERROR_PATTERN.test(comment)) {
    return '十分な根拠が得られず見送り。';
  }
  return comment;
}

async function buildContext(date, decisions, votes, recs) {
  // positions/pending は portfolio_status.{positions,pending}_json から取得（Single Source of Truth）
  const [mkt, pf, candidates] = await Promise.all([
    sheets.getLatestRowAsOf('market_data', date).catch(() => null),
    sheets.getLatestRowAsOf('portfolio_status', date).catch(() => null),
    sheets.getRowsByDate('candidate_assets', date).catch(() => []),
  ]);
  // mkt/pf を後続の算出根拠ブロックでも使うため冒頭で宣言

  const positions     = JSON.parse(pf?.positions_json || '[]').map(p => ({
    asset_name:    p.name,
    market_value:  p.market_value,
    unrealized_pl: p.unrealized_pl,
    full_name:     p.full_name || '',
    cost_basis:    p.cost_basis,
    current_nav:   p.current_nav,
    ath_gap_pct:   p.ath_gap_pct,
  }));
  const pendingOrders = JSON.parse(pf?.pending_json || '[]');

  const lines = [];

  lines.push(`【会議情報】\n日付: ${date}`);

  // 部署別の日替わり視点（機械選定・日付ベースなので過去日再生成でも同一結果）
  lines.push(
    `【本日の部署別フォーカス視点（機械選定・必ず中心に据えること）】\n` +
    `神谷シン: ${pickRotation(date, SHIN_ANGLES)}\n` +
    `黒崎ミサキ: ${pickRotation(date, MISAKI_ANGLES)}\n` +
    `鬼塚ガイ: ${pickRotation(date, GAI_ANGLES)}\n` +
    `相沢レイ（秘書室長所見②の締めの切り口・機械選定）: ${pickRotation(date, REI_ANGLES)}`
  );

  // 各部署の投票
  if (votes.length > 0) {
    lines.push('【各部署の投票・コメント】');
    votes.forEach(v => {
      lines.push(`${v.department}: ${v.signal}(${v.confidence}%) — ${sanitizeVoteCommentForArticle(v.comment)}`);
    });
  }

  // 最終判断（JS集計済み）
  // signalAggregator未実行でpending ordersがある場合、注文データから合成
  if (decisions.length === 0 && pendingOrders.length > 0) {
    const order = pendingOrders[0];
    decisions = [{
      final_signal:  'ACCUMULATE',
      target_asset:  order.name || 'なし',
      amount:        parseInt(order.amount || 0),
      reason:        '本日の注文データより（signalAggregator未実行）'
    }];
  }
  const decision = decisions[0] ?? null;
  if (decision) {
    const amtStr = decision.amount ? `¥${parseInt(decision.amount).toLocaleString()}` : 'なし';
    lines.push(
      `【最終判断（JS集計済み・⚖️最終判断セクションの機械ブロックはシステムが挿入する・変更禁止）】\n` +
      `シグナル: ${decision.final_signal}\n` +
      `対象銘柄: ${decision.target_asset || 'なし'}\n` +
      `金額: ${amtStr}\n` +
      `根拠: ${sanitizeDecisionReasonForArticle(decision.reason)}`
    );
  }


  // 市場データ（GAS確定値）
  if (mkt) {
    lines.push(
      `【市場データ（GAS確定値・記事内の数値はこれのみ使用・推測補完禁止）】\n` +
      `Fear & Greed: ${fgDisplay(mkt.fear_greed)}\n` +
      `VIX: ${mkt.vix}\n` +
      `NASDAQ100前日比: ${mkt.nasdaq100}%\n` +
      `S&P500前日比: ${mkt.sp500}%\n` +
      `SOX（半導体）前日比: ${mkt.sox}%\n` +
      `ゴールド前日比: ${mkt.gold}%\n` +
      `ドル円: ${mkt.usdjpy}`
    );
  }

  // 模擬ファンド現状（portfolio_status が Single Source of Truth）
  if (pf) {
    const cash      = parseInt(pf.cash ?? 0);
    const total     = parseInt(pf.total_assets ?? 0);
    const invested  = parseInt(pf.invested ?? 0);
    const pending   = parseInt(pf.pending ?? 0);
    const pl        = parseInt(pf.unrealized_pl ?? 0);
    const cashRatio = pf.cash_ratio != null
      ? parseFloat(pf.cash_ratio).toFixed(1)
      : (total > 0 ? (cash / total * 100).toFixed(1) : '100.0');

    // 注文中銘柄リスト
    const pendingLines = pendingOrders.length > 0
      ? pendingOrders.map(o => `・${o.name} ¥${parseInt(o.amount).toLocaleString()}`)
      : ['・なし'];

    // 保有銘柄リスト
    const holdingLines = positions.length > 0
      ? positions.map(p =>
          `・${p.asset_name}: 時価¥${parseInt(p.market_value || 0).toLocaleString()} 含み損益¥${parseInt(p.unrealized_pl || 0).toLocaleString()}`
        )
      : ['・なし'];

    lines.push(
      `【AI Capital模擬ファンド現状（このブロックをそのまま転記すること。数値計算禁止。空行は入れないこと）】\n` +
      `💰 AI Capital模擬ファンド\n` +
      `総資産：¥${total.toLocaleString()}\n` +
      `現金残高：¥${cash.toLocaleString()}\n` +
      `注文中資金：¥${pending.toLocaleString()}\n` +
      `投資中資金：¥${invested.toLocaleString()}\n` +
      `含み損益：¥${pl >= 0 ? '+' : ''}${pl.toLocaleString()}\n` +
      `現金比率：${cashRatio}%\n` +
      `注文中銘柄：\n${pendingLines.join('\n')}\n` +
      `保有銘柄：\n${holdingLines.join('\n')}`
    );

    // リスク管理部（黒崎ミサキ）が「数字で殴る」ための参考数値
    // 黒崎の主戦場はポートフォリオ構成（集中投資率・現金比率・保有銘柄数）。ATH乖離は神谷シンの領域のため参考値として添えるのみ。
    const targetAsset = decision?.target_asset && decision.target_asset !== 'なし' ? decision.target_asset : null;
    const targetAlreadyHeld = targetAsset ? positions.some(p => p.asset_name === targetAsset) : true;
    if (positions.length > 0 || (targetAsset && !targetAlreadyHeld)) {
      const riskLines = positions.map(p => {
        const val  = parseFloat(p.market_value || 0);
        const conc = total > 0 ? (val / total * 100).toFixed(1) : '0.0';
        const ath  = (p.ath_gap_pct != null && p.ath_gap_pct !== 'N/A') ? `${p.ath_gap_pct}%` : 'データなし';
        return `・${p.asset_name}: 集中投資率${conc}%（総資産に占める割合）（参考・神谷の指標: ATH乖離${ath}）`;
      });
      // 最終判断の対象銘柄が現在未保有の場合、算出不能で「不明」と書かせないよう0%を明示する
      if (targetAsset && !targetAlreadyHeld) {
        riskLines.push(`・${targetAsset}: 集中投資率0.0%（現在未保有のため保有比率なし。ここから積み増す形になる）`);
      }
      lines.push(
        `【リスク管理部向け参考数値（黒崎ミサキの主根拠はここ。集中投資率・現金比率・保有銘柄数を使うこと。最終判断の対象銘柄が未保有の場合は0%と明記済みのため「不明」と書かないこと）】\n` +
        `現金比率：${cashRatio}%\n` +
        `保有銘柄数：${positions.length}銘柄\n` +
        riskLines.join('\n')
      );
    }
  }

  // 買付候補（🥇Core / 🚀Growth / 🛡Defense の3カテゴリからそれぞれ最上位候補を提示。
  // カテゴリ分類は表示用の CANDIDATE_DISPLAY_GROUPS を使用し、config/categoryBonus.js の
  // Coreボーナス対象とは別軸。ボーナスの有無に関わらず、その日のRank最上位を紹介する）
  if (candidates.length > 0) {
    const totalForRatio = parseInt(pf?.total_assets ?? 0);
    // 注: cost_basis は取得原価の総額（円）、current_nav は口当たり基準価格のため、
    // 両者を直接比較する「前回購入価格比」は単位が異なり異常値（例: -98%）を生む。算出せずコンテキストから外す。
    const heldStr = c => {
      const held = positions.find(p => p.asset_name === c.asset_name);
      if (!held) return '';
      const ratio = totalForRatio > 0 ? (parseFloat(held.market_value || 0) / totalForRatio * 100).toFixed(1) : null;
      return ratio != null ? ` [既存保有: ポートフォリオ比率${ratio}%]` : '';
    };
    const fmtCandidate = c => {
      const fullLabel = c.full_name ? `（${c.full_name}）` : '';
      const navLabel  = c.nav_ok === 'FALSE' ? ' ※基準価格データ未蓄積' : '';
      return `${c.asset_name}${fullLabel}: ATH乖離${c.ath_gap_pct}% 前日比${c.daily_change_pct}% スコア${c.score}（Rank${c.rank}）${navLabel}${heldStr(c)}`;
    };
    const displayCandidates = getDisplayCandidates(candidates);
    const coreTop    = displayCandidates.find(c => c.category === 'core')    || null;
    const growthTop  = displayCandidates.find(c => c.category === 'growth')  || null;
    const defenseTop = displayCandidates.find(c => c.category === 'defense') || null;

    const groupLines = [];
    if (coreTop)    groupLines.push(`🥇 Core候補: ${fmtCandidate(coreTop)}`);
    if (growthTop)  groupLines.push(`🚀 Growth候補: ${fmtCandidate(growthTop)}`);
    if (defenseTop) groupLines.push(`🛡 Defense候補: ${fmtCandidate(defenseTop)}`);

    if (groupLines.length > 0) {
      lines.push(
        `【本日の買付候補（規則エンジン算出済み・カテゴリ別。表示上のカテゴリ分けであり、\n` +
        `Coreだから優遇するという意味ではない。実際の採否は⚖️最終判断セクションに従うこと）】\n` +
        groupLines.join('\n')
      );
    }
  }

  // 各部署の最終提案（agent_recommendations / department_recommendations）
  // signalAggregator未実行でpending ordersがある場合、合成 recs (3賛成:1様子見パターン)
  if (recs.length === 0 && pendingOrders.length > 0) {
    const order  = pendingOrders[0];
    const amount = parseInt(order.amount || 0);
    const asset  = order.name || 'なし';
    recs = [
      { department: 'マーケット分析部',     agent_name: '神谷シン',   amount,    asset_name: asset,   recommendation_type: 'ACCUMULATE', confidence: 80 },
      { department: 'リスク管理部',         agent_name: '黒崎ミサキ', amount: 0, asset_name: 'なし',  recommendation_type: 'WAIT',       confidence: 85 },
      { department: 'ポートフォリオ管理部', agent_name: '橘アオイ',   amount,    asset_name: asset,   recommendation_type: 'ACCUMULATE', confidence: 75 },
      { department: '審査部',               agent_name: '鬼塚ガイ',   amount,    asset_name: asset,   recommendation_type: 'ACCUMULATE', confidence: 82 },
    ];
  }
  // 「各部署の要約欄に書く金額」はここを参照する（最終判断額ではなく自部署の提案額）
  if (recs && recs.length > 0) {
    const recLines = recs.map(r => {
      const amt    = parseInt(r.amount || r.recommended_amount || 0);
      const action = r.recommendation_type || r.action || 'WAIT';
      const name   = r.agent_name ? `${r.agent_name}（${r.department}）` : r.department;
      const asset  = r.asset_name || 'なし';
      const amtStr = amt > 0 && asset !== 'なし' ? `¥${amt.toLocaleString()}` : '見送り';
      return `${name}: ${action} ${asset} ${amtStr} 信頼度${r.confidence}%`;
    });

    // 部署ごとの提案額を明示（LLMが最終判断額と混同しないように強調）
    const perDeptAmts = recs.map(r => {
      const amt  = parseInt(r.amount || r.recommended_amount || 0);
      const name = r.agent_name || r.department;
      const amtStr = amt > 0 ? `¥${amt.toLocaleString()}` : '見送り';
      return `${name}の提案額: ${amtStr}`;
    });

    // 部署ごとの推奨銘柄・金額を明示（要約との整合性を強制）
    const DEPT_NAMES = {
      'マーケット分析部': '神谷シン',
      'リスク管理部':     '黒崎ミサキ',
      'ポートフォリオ管理部': '橘アオイ',
      '審査部':           '鬼塚ガイ',
    };
    const assetConstraints = recs.map(r => {
      const name  = DEPT_NAMES[r.department] || r.department;
      const asset = r.asset_name || 'なし';
      const amt   = parseInt(r.amount || r.recommended_amount || 0);
      const amtStr = amt > 0 && asset !== 'なし' ? `¥${amt.toLocaleString()}` : '見送り';
      return `${name}の推奨: ${asset} ${amtStr}（要約でもこの銘柄・金額を使うこと。独自変更禁止）`;
    });

    lines.push(
      `【各部署の推奨銘柄・金額（変更禁止・要約と必ず一致させること）】\n` +
      assetConstraints.join('\n') + '\n\n' +
      `【各部署が事前に算出した提案額（各部署の要約欄ではこの金額を使うこと。最終判断額とは別物）】\n` +
      perDeptAmts.join('\n') + '\n\n' +
      `【各部署の最終提案詳細（再解釈禁止）】\n` +
      recLines.join('\n')
    );
  }

  return lines.join('\n\n');
}

// ── 記事採番（AC-YYYY-NNNN）────────────────────────────────────
// article_decisions の当年行数 = 今日が何本目の記事か
async function getArticleNumber(date) {
  const year = date.slice(0, 4);
  const rows = await sheets.getRows('article_decisions').catch(() => []);
  const count = rows.filter(r => r.date && String(r.date).startsWith(year) && r.date <= date).length;
  return `AC-${year}-${String(count).padStart(4, '0')}`;
}

// ── 決定論的後処理（LLM生成直後に必ず適用する機械変換の一式） ──────
// 再生成ループから複数回呼ばれるため、date確定値の再取得は行わずctxの値を使い回す。
// ctx: { date, articleNum, recs, decisions, pf, mkt }
function applyPostProcessing(rawNote, ctx) {
  const { date, articleNum, recs, decisions, pf, mkt } = ctx;
  let note = rawNote;

  // 後処理①: 誤字修正
  note = note.replace(/要量：/g, '要約：');
  note = note.replace(/要項：/g, '要約：');

  // 後処理②: （空欄）プレースホルダー除去
  note = note.replace(/^[^\n]*（空欄）[^\n]*$/gm, '');
  note = note.replace(/（空欄）/g, '');

  // 後処理③: 😟 投資家心理 行を除去（⚠️ 市場フェーズ に F&G が含まれるため重複不要）
  note = note.replace(/^😟 投資家心理：[^\n]*\n?/gm, '');

  // 見出し検出ヘルパー: LLMが「##」等のMarkdown記法を省略することがあるため、
  // 「##」の有無・スペースの揺れに関わらず絵文字＋見出し語で判定する
  // （articleValidator.jsのSUMMARY_SECTIONS/extractSectionBodyと同じ方針）。
  const findHeading = (text, re, fromIndex = 0) => {
    const m = text.slice(fromIndex).match(re);
    return m ? fromIndex + m.index : -1;
  };
  // 「次の主要セクション見出し」の判定も同様に絵文字のみで行う（行頭想定）。
  const MAJOR_SECTION_RE = /(?:^|\n)\s*#{0,2}\s*(?:📌|🌍|🎯|🏢|⚖️|🔴|💰|👀|👑)/;

  // 後処理④: ▼HISTORY▼ 機械注入（AI Capital模擬ファンドセクション末尾に配置）
  note = note.replace(/▼HISTORY▼/g, '');
  {
    const fundIdx = findHeading(note, /#{0,2}\s*💰\s*AI Capital模擬ファンド/);
    if (fundIdx >= 0) {
      const nextHead = findHeading(note, MAJOR_SECTION_RE, fundIdx + 1);
      const pos = nextHead >= 0 ? nextHead : note.length;
      note = note.slice(0, pos) + '\n\n▼HISTORY▼' + note.slice(pos);
    } else {
      console.warn('[publisher] ▼HISTORY▼ 挿入失敗: 💰 AI Capital模擬ファンドの見出しが見つかりません');
    }
  }

  // 後処理⑤: ▼CHART▼ を秘書室長セクション末尾（免責事項直前）に機械挿入
  note = note.replace(/▼CHART▼/g, '');
  {
    const reiIdx = findHeading(note, /#{0,2}\s*👑\s*秘書室長所見/);
    if (reiIdx >= 0) {
      // 免責事項は初回生成時は `*...*` 装飾付き、後処理㉕通過後（品質改善ループの2周目以降）は
      // 装飾なしの平文3行版になる。'\n*AI Capital' 固定文字列だけでは2周目以降にマッチせず、
      // ▼CHART▼がnote末尾（既存免責事項のさらに後ろ）へ誤挿入されてしまっていた
      // （2026-08-14判明・修正。findDisclaimerIndexは下のensureMarkersPresentとも共通化）。
      const disclaimerIdx = findDisclaimerIndex(note, reiIdx + 1);
      const nextMajor     = findHeading(note, MAJOR_SECTION_RE, reiIdx + 1);
      let pos;
      if (disclaimerIdx >= 0)   pos = disclaimerIdx;
      else if (nextMajor >= 0)  pos = nextMajor;
      else                      pos = note.length;
      note = note.slice(0, pos) + '\n\n▼CHART▼\n' + note.slice(pos);
      console.log('[publisher] ▼CHART▼ 機械挿入');
    } else {
      console.warn('[publisher] ▼CHART▼ 挿入失敗: 👑 秘書室長所見の見出しが見つかりません');
    }
  }

  // 後処理⑥: 用語統一
  note = note.replace(/試し玉/g, '観測ポジション');
  note = note.replace(/\bACCUMULATE\b/g, '観測ポジション構築');
  note = note.replace(/観測ポジション買付/g, '観測ポジション構築');
  note = note.replace(/打診買い/g, '観測ポジション構築');

  // 後処理⑦: 整合性ウォーニング（部署要約に推奨銘柄の言及があるか確認）
  // 実際のブロッキング判定は articleValidator.js の Rule 37/39 が担当する。ここは早期ログのみ。
  {
    for (const r of recs) {
      const asset = r.asset_name || 'なし';
      const amt   = parseInt(r.amount || r.recommended_amount || 0);
      if (asset === 'なし' || amt === 0) continue;
      const header = findDeptHeader(note, r.department);
      if (!header) continue;
      const sectionEnd = findDeptSectionEnd(note, header.index + header.length);
      const section = note.slice(header.index, sectionEnd);
      if (section && !section.includes(asset)) {
        console.warn(`[publisher] ⚠️ 整合性: ${r.department} の要約に推奨銘柄「${asset}」の言及なし`);
      }
    }
  }

  // 後処理⑧: LLM生成の 📅 と ⚠️市場フェーズ を除去（Market Check ブロックで代替）
  note = note.replace(/^📅[^\n]*\n?/gm, '');
  note = note.replace(/^⚠️ 市場フェーズ：[^\n]*\n?/gm, '');
  // ⑮（結論ブロック挿入）より前に除去する必要がある行（後で結論ブロックが再注入する）
  note = note.replace(/^対象銘柄[：:][^\n]*\n?/gm, '');  // ⑭で再注入されるため先に除去
  note = note.replace(/^対象[：:][^\n]*\n?/gm, '');       // ⑭で再注入されるため先に除去
  note = note.replace(/^シグナル[：:][^\n]*\n?/gm, '');   // ⑭で再注入されるため先に除去
  note = note.replace(/^金額[：:][^\n]*\n?/gm, '');       // ⑭で再注入されるため先に除去
  note = note.replace(/^根拠[：:][^\n]*\n?/gm, '');       // LLMが最終判断内に書いた冗長行を除去
  note = note.replace(/^部署判断[：:][^\n]*\n?/gm, '');   // ⑭で再注入されるため先に除去
  note = note.replace(/^採用[：:][^\n]*\n?/gm, '');       // ⑭で再注入されるため先に除去

  // 後処理⑧c: LLM生成の 🆔 行を除去（記事番号・task-id の誤記フォーマット）
  // 📋 AC-YYYY-NNNN は ⑨ で機械挿入するため、LLM が 🆔 で書いた版はすべて除去する
  note = note.replace(/^🆔[^\n]*\n?/gm, '');

  // 後処理⑧d: LLM生成の 📋 行を除去（⑨で機械挿入するため LLM が書いた版を先に除去）
  // ⑨ の includes(articleNum) チェックが機能するよう、先に全除去してから再挿入させる
  note = note.replace(/^📋[^\n]*\n?/gm, '');

  // 後処理⑧e: タイトル行（H1）に日付を追記（note.comのタイトル欄はこの行から抽出されるため反映される）
  note = note.replace(/^(# 📊[^\n]*?)(?:\s+\d{4}-\d{2}-\d{2})?$/m, `$1　${date}`);

  // 後処理⑨: 記事番号をタイトル直後に挿入（AC-YYYY-NNNN）
  if (!note.includes(articleNum)) {
    note = note.replace(/^(# 📊[^\n]*\n)/, `$1\n📋 ${articleNum}\n`);
  }

  // 後処理⑨a: 📊 Market Check ブロックを 📋 番号直後に機械挿入
  // 挿入前に既存ブロックを必ず除去する（▼HISTORY▼/▼CHART▼と同じ「既存除去→1回だけ再挿入」に統一）。
  // 品質改善ループはLLMに「前回の記事全文（＝Market Checkブロック挿入済み）を維持しつつ修正」と
  // 指示するため、LLMがこのブロックをそのまま複製することがあり、除去せず挿入すると
  // 「📊 AI Capital Market Check」が2回出現するRule28違反になっていた（2026-08-14判明・修正）。
  {
    const marketCheckRe = /#{0,2}\s*📊\s*AI Capital Market Check[\s\S]*?(?=\n#{0,2}\s*(?:📌|🌍|🎯|🏢|⚖️|🔴|💰|👀|👑)|$)/g;
    note = note.replace(marketCheckRe, '').replace(/\n{3,}/g, '\n\n');
  }
  if (mkt && note.includes('📋')) {
    const checkBlock = buildMarketCheckBlock(mkt);
    note = note.replace(/(📋 [^\n]+\n)/, `$1\n${checkBlock}\n`);
  }

  // 後処理⑩: 【最終提案】ブロックを各部署セクションへ機械的に挿入（HR挿入前 → 推奨行がセクション内に収まる）
  if (recs.length > 0) {
    note = injectRecommendations(note, recs);
    console.log(`[publisher] 【最終提案】ブロック挿入: ${recs.length}部署`);
  }

  // 後処理⑩a: 各部署の「判断：」行が、機械挿入された「推奨：」（見送り）と矛盾する場合に是正する
  // （LLMが実際の推奨（WAIT/DEFEND＝見送り）を無視し、買付方向の判断ラベルを書いてしまうケースの安全網。
  //   要約本文には手を加えず、矛盾したラベル語のみを置き換える。以前は審査部のみ対象だったが、
  //   同種の矛盾は他部署でも起こり得るため2026-08-13に全部署へ一般化した）
  for (const dept of Object.keys(DEPT_HEADER_META)) {
    const header = findDeptHeader(note, dept);
    if (!header) continue;
    const headerIdx  = header.index;
    const sectionEnd = findDeptSectionEnd(note, headerIdx + header.length);
    const section = note.slice(headerIdx, sectionEnd);

    const recLineMatch = section.match(/推奨[：:]\s*\n?([^\n]+)/);
    const isWaiveRec = recLineMatch && recLineMatch[1].trim() === '今回は見送ります';
    const BUY_DIRECTION_WORDS = /(構築推奨|買付推奨|積み増し推奨|打診買い推奨|構築を推奨|買付を推奨)/;

    if (isWaiveRec) {
      const fixedSection = section.replace(/(判断[：:]\s*)([^\n]+)/, (m, p1, p2) => {
        return BUY_DIRECTION_WORDS.test(p2) ? `${p1}様子見支持` : m;
      });
      if (fixedSection !== section) {
        note = note.slice(0, headerIdx) + fixedSection + note.slice(sectionEnd);
        console.log(`[publisher] 後処理⑩a: ${dept}の「判断：」を推奨（見送り）と整合するよう是正`);
      }
    }
  }

  // 後処理⑪: 空プレースホルダー除去（②③に「省略可」「なし」等が残った場合）
  note = note.replace(/^[②③]\s*（[^）]*(?:なし|省略)[^）]*）[　 ]*\n(?:理由[：:][^\n]*\n?)?/gm, '');
  note = note.replace(/^[②③][　 ]*(?:なし|省略(?:可)?)[　 ]*\n(?:理由[：:][^\n]*\n?)?/gm, '');
  note = note.replace(/^[②③][　 ]*(?:なし|省略(?:可)?)[　 ]*$/gm, '');
  note = note.replace(/\n{3,}/g, '\n\n');

  // 後処理⑫: キャラクター名補完（LLMが名前を落とした場合）
  note = note.replace(/^### マーケット分析部\s*$/m,     '### マーケット分析部（神谷シン）');
  note = note.replace(/^### リスク管理部\s*$/m,         '### リスク管理部（黒崎ミサキ）');
  note = note.replace(/^### ポートフォリオ管理部\s*$/m,  '### ポートフォリオ管理部（橘アオイ）');
  note = note.replace(/^### 審査部\s*$/m,               '### 審査部（鬼塚ガイ）');
  note = note.replace(/^## 👑 秘書室長所見\s*$/m,      '## 👑 秘書室長所見（相沢レイ）');

  // 後処理⑬: ## / ### 見出し前後のスペースを正規化（横線は挿入しない）
  //   見出し直後に \n\n を補完して見出し行と本文を別段落にする
  note = note.replace(/\n+(## )/g, '\n\n$1');
  note = note.replace(/\n+(### )/g, '\n\n$1');
  note = note.replace(/^(#{1,3} [^\n]+)\n(?=[^\n])/gm, '$1\n\n');

  // 後処理⑭: ⚖️ 最終判断セクションに 🟢🎯💴🤖 ブロック挿入
  const pendingForSum = JSON.parse(pf?.pending_json || '[]');
  let decision        = decisions[0] ?? null;
  if (!decision && pendingForSum.length > 0) {
    const o = pendingForSum[0];
    decision = { final_signal: 'ACCUMULATE', target_asset: o.name || 'なし', amount: parseInt(o.amount || 0), reason: '本日の注文データより' };
  }
  let recsForSum = recs;
  if (recs.length === 0 && pendingForSum.length > 0) {
    const o = pendingForSum[0];
    const amt = parseInt(o.amount || 0);
    const ast = o.name || 'なし';
    recsForSum = [
      { department: 'マーケット分析部',     recommendation_type: 'ACCUMULATE', amount: amt, asset_name: ast },
      { department: 'リスク管理部',         recommendation_type: 'WAIT',       amount: 0,   asset_name: 'なし' },
      { department: 'ポートフォリオ管理部', recommendation_type: 'ACCUMULATE', amount: amt, asset_name: ast },
      { department: '審査部',               recommendation_type: 'ACCUMULATE', amount: amt, asset_name: ast },
    ];
  }
  note = injectRecommendationSummary(note, recsForSum, decision, pf);

  // 後処理⑯: 空行正規化（━━━ は削除済みのため圧縮不要）
  note = note.replace(/\n{3,}/g, '\n\n');

  // 後処理⑰: ## / ### マーカーを除去（# 1個はタイトル行なので除外）
  note = note.replace(/^#{2,3}[ \t]*/gm, '');

  // 後処理⑰b: --- 横線を除去（note.com でHRが表示される問題を防ぐ）
  note = note.replace(/^---[ \t]*$/gm, '');

  // 後処理⑰c: Markdown 箇条書き「* 」を「・」に変換（本日の論点など）
  note = note.replace(/^\*[ \t]{1,4}/gm, '・');

  // 後処理⑱: 本日の買付候補 ②③ の前に空行を挿入
  note = note.replace(/\n([②③])/g, '\n\n$1');

  // 後処理⑲: 残った空行の正規化
  note = note.replace(/\n{3,}/g, '\n\n');

  // 後処理⑳: 各部署名の先頭に顔絵文字を追加（行頭マッチのみ）
  note = note.replace(/^マーケット分析部（神谷シン）/gm,      '😎 マーケット分析部（神谷シン）');
  note = note.replace(/^リスク管理部（黒崎ミサキ）/gm,        '🤨 リスク管理部（黒崎ミサキ）');
  note = note.replace(/^ポートフォリオ管理部（橘アオイ）/gm,  '🙂 ポートフォリオ管理部（橘アオイ）');
  note = note.replace(/^審査部（鬼塚ガイ）/gm,                '🧐 審査部（鬼塚ガイ）');

  // 後処理㉑: 🔴 本日の論点 直後の空行を除去（見出しと箇条書きを密着させる）
  note = note.replace(/🔴 本日の論点\n\n/g, '🔴 本日の論点\n');

  // 後処理㉒: 「明日の注目点」→「次回の注目点」（テンプレート指示済みだが念のため統一）
  note = note.replace(/明日の注目点/g, '次回の注目点');

  // 後処理㉒a: 👀 次回の注目点 を機械生成で完全置換
  // LLMは現在値ですでに成立している条件を書く誤りを犯すため、常に機械注入する
  if (mkt) {
    const watchBlock = buildWatchPoints(mkt);
    // 👀 次回の注目点 〜 👑 秘書室長所見 の手前まで（または文末まで）を置換
    // ## あり/なし 両対応
    const watchStartRe = /(?:## )?👀 次回の注目点[\s\S]*?(?=(?:## )?👑 秘書室長所見|$)/;
    const matched = watchStartRe.test(note);
    console.log(`[publisher] 👀 watchPoints injection: matched=${matched}`);
    if (matched) {
      note = note.replace(watchStartRe, watchBlock + '\n\n');
    }
  }

  // 後処理㉓: 観測ポジション係数算出行を除去（LLMが生成した場合も除去）
  note = note.replace(/^投資額算出：[^\n]*\n?/gm, '');

  // 後処理㉓b: 最終判断内の冗長マーカーを除去（シグナル/対象/金額/根拠/部署判断 は ⑧ で除去済み）
  note = note.replace(/（?🟢🎯💴🤖）?\n?/g, '');           // 旧絵文字マーカーの残骸を除去（安全網）
  // 相沢レイ補足プレフィックスを除去（複数パターン・全角/半角両対応）
  note = note.replace(/^相沢レイ(?:による補足|の補足コメント|の補足)[：:]\s*/gm, '');
  // 買付候補②③のプレースホルダー行を除去（LLMが候補なしの場合に書くゴミ行）
  note = note.replace(/^→\s*(?:候補銘柄は|（?本日の候補は|（?ありません)[^\n]*\n?/gm, '');
  // 「でした。」だけ残った孤立行を除去
  note = note.replace(/^でした[。]?\s*\n?/gm, '');

  // 後処理④a: 💰 AI Capital模擬ファンドセクション内の余分な空行を除去（全データを一体化）
  {
    const fundStart = note.indexOf('💰 AI Capital模擬ファンド');
    const histIdx   = note.indexOf('▼HISTORY▼');
    if (fundStart >= 0 && histIdx > fundStart) {
      const before  = note.slice(0, fundStart);
      const section = note.slice(fundStart, histIdx).replace(/\n{2,}/g, '\n');
      note = before + section + note.slice(histIdx);
    }
  }

  // 後処理㉔: 空行の最終正規化
  note = note.replace(/\n{3,}/g, '\n\n');

  // 後処理㉕': 買付候補の空「理由：」行を除去（LLMがテンプレートをそのままコピーした場合）
  note = note.replace(/^理由[：:]\s*\n/gm, '');

  // 後処理㉕a: 各部署セクション内の項目間の余分な空行を除去
  // LLM が「判断：」「信頼度：」「要約：」の後に \n\n を入れるため、\n に圧縮する
  note = note.replace(/^((?:判断|信頼度|要約)[：:][^\n]*)\n\n/gm, '$1\n');

  // 後処理㉕: 免責事項を機械的に保証する（LLM出力に依存しない）
  // 一部の日でLLMが免責事項を書き落とす不具合が報告されたため、
  // LLMが書いたかどうかに関わらず、既存の記載（*...*版・1行版・3行版）を
  // 全て除去した上で記事末尾に固定文を必ず機械挿入する。条件分岐・省略は行わない。
  {
    const DISCLAIMER_PLAIN =
      'AI Capitalは投資助言サービスではありません。AI社員による意思決定の記録を公開するプロジェクトです。投資判断はご自身の責任でお願いします。';
    const DISCLAIMER_3LINES =
      'AI Capitalは投資助言サービスではありません。\n' +
      'AI社員による意思決定の記録を公開するプロジェクトです。\n' +
      '投資判断はご自身の責任でお願いします。';

    note = note.replace(new RegExp(`\\*${DISCLAIMER_PLAIN}\\*`, 'g'), '');
    note = note.replace(new RegExp(DISCLAIMER_PLAIN, 'g'), '');
    note = note.replace(new RegExp(DISCLAIMER_3LINES.replace(/\n/g, '\\n'), 'g'), '');

    note = note.trimEnd() + '\n\n' + DISCLAIMER_3LINES;
  }

  return note;
}

// ── メイン処理 ───────────────────────────────────────────────

async function publish(date) {
  console.log(`[publisher] 記事生成開始: ${date}`);
  pruneOldImages();

  // ── portfolio_status / market_data はこの後の生成・後処理・再生成ループ全体で
  //    同一の値を使い回す（date確定値のため再取得不要。再生成のたびに毎回叩くと
  //    GAS往復コストが再生成回数分積み重なるため、ここで1回だけ取得する）。
  const pf  = await sheets.getLatestRowAsOf('portfolio_status', date).catch(() => null);
  const mkt = await sheets.getLatestRowAsOf('market_data', date).catch(() => null);

  // ── portfolio_status 整合性チェック（cash + pending + invested === total_assets）
  if (pf) {
    const t   = parseInt(pf.total_assets || 0);
    const c   = parseInt(pf.cash         || 0);
    const p   = parseInt(pf.pending       || 0);
    const inv = parseInt(pf.invested      || 0);
    const sum = c + p + inv;
    if (Math.abs(t - sum) > 100) {
      throw new Error(
        `⚠️ portfolio_status整合性エラー: ` +
        `total=¥${t.toLocaleString()} vs cash+pending+invested=¥${sum.toLocaleString()} ` +
        `(差分: ¥${Math.abs(t - sum).toLocaleString()})`
      );
    }
    console.log(`[publisher] 整合性OK: total=¥${t.toLocaleString()} = cash+pending+invested`);
  }

  const articleNum = await getArticleNumber(date);
  console.log(`[publisher] 記事番号: ${articleNum}`);

  const [decisions, votes, recs, candidates] = await Promise.all([
    sheets.getRowsByDate('final_decisions', date),
    sheets.getRowsByDate('agent_votes', date),
    // agent_recommendations を優先、なければ department_recommendations にフォールバック
    sheets.getRowsByDate('agent_recommendations', date)
      .then(r => r.length > 0 ? r : sheets.getRowsByDate('department_recommendations', date))
      .catch(() => []),
    sheets.getRowsByDate('candidate_assets', date).catch(() => []),
  ]);

  // ── データ整合性チェック ─────────────────────────────────────
  const integrityWarnings = [];

  // ① 4部署全員のrecommendationsが揃っているか
  const EXPECTED_DEPTS = ['マーケット分析部', 'リスク管理部', 'ポートフォリオ管理部', '審査部'];
  const recDepts = recs.map(r => r.department);
  for (const dept of EXPECTED_DEPTS) {
    if (!recDepts.includes(dept)) {
      integrityWarnings.push(`⚠️ ${dept}のrecommendationが未保存`);
    }
  }

  // ② asset='なし'なのに amount > 0 の矛盾チェック
  for (const r of recs) {
    const asset = r.asset_name || 'なし';
    const amt   = parseInt(r.amount || r.recommended_amount || 0);
    const action = r.recommendation_type || r.action || '';
    if ((asset === 'なし' || !asset) && amt > 0) {
      integrityWarnings.push(`⚠️ ${r.department}: asset=なし なのに amount=¥${amt.toLocaleString()} (→0に正規化)`);
    }
    if ((action === 'WAIT' || action === 'DEFEND') && amt > 0) {
      integrityWarnings.push(`⚠️ ${r.department}: action=${action} なのに amount=¥${amt.toLocaleString()} (→0に正規化)`);
    }
  }

  // ③ final_decisions が存在するか
  if (decisions.length === 0) {
    integrityWarnings.push('⚠️ final_decisions が空 — signalAggregatorが未実行の可能性');
  }

  // ④ ACCUMULATE/BUYなのに orders がない場合の警告
  const finalSig = decisions[0]?.final_signal;
  if (['BUY', 'ACCUMULATE'].includes(finalSig)) {
    const todayOrders = await sheets.getRowsByDate('orders', date).catch(() => []);
    if (todayOrders.length === 0) {
      integrityWarnings.push(`⚠️ final_signal=${finalSig} なのに orders が空 — orderManagerが失敗した可能性`);
    }
  }

  if (integrityWarnings.length > 0) {
    console.warn('[publisher] データ整合性警告:');
    integrityWarnings.forEach(w => console.warn(' ', w));
  } else {
    console.log('[publisher] データ整合性チェック: 問題なし');
  }

  let context = await buildContext(date, decisions, votes, recs);

  // ── 前回、AI編集長が公開を見送った理由を今回のプロンプトへ反映（実装⑦・自己学習） ──
  // 前日分のdevelopment_logsにEDITOR_REJECTIONが記録されていれば、その理由を改善指示として
  // contextへ追記する。翌日以降も改善されなければ、その日また新たなEDITOR_REJECTIONログが
  // 積まれるだけなので、参照範囲は「前日1件」に限定し無制限に蓄積させない。
  try {
    const prevDate = new Date(`${date}T00:00:00Z`);
    prevDate.setUTCDate(prevDate.getUTCDate() - 1);
    const prevDateStr = prevDate.toISOString().slice(0, 10);
    const prevLogs = await sheets.getRowsByDate('development_logs', prevDateStr).catch(() => []);
    const rejection = prevLogs.find(r => r.type === 'EDITOR_REJECTION');
    if (rejection) {
      context += `\n\n【前回、AI編集長が公開を見送った理由（今回は必ず改善すること）】\n${rejection.summary}`;
      console.log(`[publisher] 前回のAI編集長指摘を今回のプロンプトへ反映: ${rejection.summary.slice(0, 60)}...`);
    }
  } catch (err) {
    console.warn(`[publisher] 前回の編集長指摘の取得スキップ: ${err.message}`);
  }

  // Phase3: 当日 agent_recommendations に登場した部署だけをプロンプトに含める（＋相沢レイは常時）
  const activeCharacters = computeActiveCharacters(recs);
  console.log(`[publisher] 稼働部署: ${activeCharacters.join(', ')}`);
  const noteSystem = buildNoteSystemPrompt({ activeCharacters });

  // ── ctx: 生成・後処理・再生成ループ全体で使い回すデータの束 ──────
  const ctx = { date, articleNum, recs, decisions, pf, mkt };

  // note.com 記事生成（生成 + 決定論的後処理を1セットとして扱う）
  async function generateArticle(userPrompt) {
    const raw = await ask(noteSystem, userPrompt, { num_predict: 3000, num_ctx: 32768, temperature: 0.7 });
    return applyPostProcessing(raw, ctx);
  }

  console.log('[publisher] note記事生成中');
  let note = await generateArticle(context);

  // ── 品質改善ループ（①機械修正 → ②Validator再実行 → ③必要な場合のみLLM再生成） ──
  // LLM呼び出しは最後の手段。正規表現で直せるレイアウト崩れ（Rule 9/26/27/28/30/31）は
  // autoFixLayout() が無料・即時に修正するため、大半のケースはLLMを一切使わずに完結する。
  const MAX_QUALITY_ATTEMPTS = 5;
  let mechanicalFixCount = 0;
  let regenerationCount  = 0;
  let validation = validateArticle({ note, pf, candidates, decisions, recs, articleNum, date });

  for (let attempt = 1; attempt <= MAX_QUALITY_ATTEMPTS && !validation.ok; attempt++) {
    // ① 機械修正（LLM不要・正規表現のみ・即時）
    const fix = autoFixLayout(note);
    if (fix.changed) {
      note = fix.note;
      mechanicalFixCount++;
      console.log(`[publisher] 機械修正 ${mechanicalFixCount}回目: ${fix.fixesApplied.join(', ')}`);
      validation = validateArticle({ note, pf, candidates, decisions, recs, articleNum, date });
      if (validation.ok) {
        console.log('[publisher] 機械修正のみで品質基準を満たしました（LLM再生成は不使用）');
        break;
      }
    }

    // ② 機械修正で解決しない警告（内容・論理・部署整合性等）のみLLM再生成（最後の手段）
    console.log(`[publisher] LLM再生成 ${attempt}/${MAX_QUALITY_ATTEMPTS}回目（残り警告${validation.warnings.length}件）`);
    const hasRule33 = validation.warnings.some(w => /Rule 33/.test(w));
    const repairPrompt =
      `${context}\n\n` +
      '【前回生成した記事で以下の問題が検出されました。記事全体の内容・文体は維持しつつ、指摘箇所のみを修正して記事全文を出力してください】\n' +
      validation.warnings.join('\n\n') +
      (hasRule33 ? `\n\n${buildRule33DataHint(recs, decisions[0] ?? null)}` : '') +
      `\n\n【前回生成した記事全文（この内容をベースに指摘箇所のみ修正すること）】\n${note}`;

    // Ollamaタイムアウト・ネットワーク障害等で再生成そのものが失敗した場合、
    // 処理全体を破棄せず直前の有効な記事版を保持してループを抜け、通常の
    // フォールバック（下書き保存・要確認）経路へ進む（2026-08-14追加）。
    try {
      note = await generateArticle(repairPrompt);
      regenerationCount++;
      validation = validateArticle({ note, pf, candidates, decisions, recs, articleNum, date });
    } catch (err) {
      console.warn(`[publisher] LLM再生成 ${attempt}回目が失敗（${err.message}）→ 直前の記事版を保持してループを終了します`);
      break;
    }
  }

  // ── AI編集長による最終救済（品質改善ループを尽くしてもNGの場合の最後の1回） ──
  // ここでの再生成も「記事全文を書き直す」のではなく、検出済みの警告箇所のみを
  // 修正する指示に留める（記事内容・部署コメント・数値・画像は変更しない）。
  if (!validation.ok) {
    console.warn(`[publisher] ${MAX_QUALITY_ATTEMPTS}回の品質改善サイクルを経ても警告が残っています（機械修正${mechanicalFixCount}回・LLM再生成${regenerationCount}回）。AI編集長による最終修正を試みます`);
    const hasRule33Rescue = validation.warnings.some(w => /Rule 33/.test(w));
    const editorRescuePrompt =
      `${context}\n\n` +
      'あなたはAI Capitalの編集長です。以下の記事は品質チェックで指摘された問題が複数回の自動修正でも解消していません。' +
      '記事全体の内容・文体・部署コメント・数値は変更せず、指摘箇所のみを慎重に修正して記事全文を出力してください。\n\n' +
      validation.warnings.join('\n\n') +
      (hasRule33Rescue ? `\n\n${buildRule33DataHint(recs, decisions[0] ?? null)}` : '') +
      `\n\n【前回生成した記事全文（この内容をベースに指摘箇所のみ修正すること）】\n${note}`;
    try {
      note = await generateArticle(editorRescuePrompt);
      regenerationCount++;
      // 救済再生成でRule9/26/27/28/30/31相当の純粋なレイアウト崩れ（見出し直後の空行欠落・
      // 許可されていない絵文字等）が再発することがあるため、Validator再実行の前に必ず一度
      // 機械修正を通す（Phase2.7調査：ここでautoFixLayoutを呼んでいなかったため、本来
      // 機械的に直せるはずのレイアウト崩れだけで公開停止になるケースがあった）。
      const rescueFix = autoFixLayout(note);
      if (rescueFix.changed) {
        note = rescueFix.note;
        mechanicalFixCount++;
        console.log(`[publisher] 機械修正 ${mechanicalFixCount}回目（最終救済後）: ${rescueFix.fixesApplied.join(', ')}`);
      }
      validation = validateArticle({ note, pf, candidates, decisions, recs, articleNum, date });
      console.log(`[publisher] AI編集長による最終修正完了: ${validation.ok ? 'PASS' : `NG（残り警告${validation.warnings.length}件）`}`);
    } catch (err) {
      console.warn(`[publisher] AI編集長による最終修正に失敗: ${err.message}`);
    }
  }

  console.log(`[publisher] 記事生成完了 (note: ${note.length}字・機械修正${mechanicalFixCount}回・LLM再生成${regenerationCount}回)`);

  // ── チャート・サムネイル生成（成否に関わらず後段で使う。失敗しても記事生成は続行） ──
  // AI編集長レビューやValidator最終NGで公開を見送る場合でも、修正版Draftの保存には
  // これらの画像が必要なため、編集長レビューより前に生成しておく。
  let chartPath = null, historyChartPath = null, thumbPath = null;

  try {
    if (pf) {
      chartPath = await generatePortfolioChart(pf, date);
      console.log(`[publisher] 円グラフ: ${chartPath ? 'OK' : '失敗'}`);
    }
  } catch (e) { console.warn(`[publisher] 円グラフ生成失敗: ${e.message}`); }

  try {
    const pfHistoryAll = await sheets.getRows('portfolio_status').catch(() => []);
    const pfHistory = pfHistoryAll.filter(r => (r.date || r.timestamp || '').slice(0, 10) <= date);
    historyChartPath = await generateFundHistoryChart(pfHistory, date);
    console.log(`[publisher] 面グラフ: ${historyChartPath ? 'OK' : '失敗'}`);
  } catch (e) { console.warn(`[publisher] 面グラフ生成失敗: ${e.message}`); }

  try {
    thumbPath = await thumbGen.generate(articleNum, date);
    console.log(`[publisher] サムネイル: ${thumbPath ? 'OK' : '失敗'}`);
  } catch (e) { console.warn(`[publisher] サムネイル生成失敗: ${e.message}`); }

  // ── チェック①: グラフ生成数（円グラフ＋面グラフの2枚。サムネイルは対象外） ──
  const graphsGenerated = [chartPath, historyChartPath].filter(Boolean).length;
  console.log(`[publisher] Graphs Generated : ${graphsGenerated} / 2`);

  // ▼HISTORY▼/▼CHART▼ が本文に存在するかの最終防衛ライン（saveDraft呼び出し全経路で必須）。
  // 以前は検証PASSした成功経路（チェック②）にしか無く、Validator FAILでsaveFallbackDraft()を
  // 経由するケースではこの保険が素通りされ、noteDraft.js側で「no-marker」となり画像が
  // 埋め込まれない不具合が発生していた（2026-08-14判明・修正）。
  function ensureMarkersPresent() {
    for (const marker of ['▼HISTORY▼', '▼CHART▼']) {
      if (!note.includes(marker)) {
        console.warn(`[publisher] ${marker} が本文に存在しないため末尾に保険挿入します`);
        const disclaimerIdx = findDisclaimerIndex(note);
        const pos = disclaimerIdx >= 0 ? disclaimerIdx : note.length;
        note = note.slice(0, pos) + `\n\n${marker}\n` + note.slice(pos);
      }
    }
  }

  // ── 公開停止時でも「修正版Draft」だけは必ず保存する（ゼロ件終了の禁止） ──
  // note.com下書きとして保存するのみで、実際の公開（下書き→公開ボタン）は行わない。
  async function saveFallbackDraft(reason) {
    ensureMarkersPresent();
    try {
      const result = await saveDraft({ body: note, chartPath, historyChartPath, thumbPath });
      console.log(`[publisher] 修正版Draftをnote下書きに保存しました（${reason}）: ${result.url}`);
      return result.url;
    } catch (err) {
      console.error(`[publisher] 修正版Draftの保存に失敗しました（${reason}）: ${err.message}`);
      return null;
    }
  }

  // ── AI編集長レビュー（Phase4・公開前の最終ゲート） ──────────────
  // Validator PASS かつ 機械採点(Quality Score) 95点以上に達した記事のみ、
  // 最後にAI編集長へ定性レビューをかける。LLM呼び出しは1回のみ・短い評価文のみを
  // 出力させるため品質改善ループより高速に完結する。
  let editorReview = null;
  const preEditorScore = scoreArticle(validation, regenerationCount);
  if (validation.ok && preEditorScore.total >= PUBLISH_SCORE_THRESHOLD) {
    console.log('[publisher] AI編集長レビュー実施中');
    editorReview = await runEditorReview(note, ask);
    console.log(`[publisher] AI編集長レビュー完了: 判定=${editorReview.verdict} 編集長スコア=${editorReview.editorScore ?? 'N/A'}`);

    if (editorReview.verdict !== 'APPROVED') {
      const reasonsText = editorReview.reasons.length > 0
        ? editorReview.reasons.map(r => `・${r}`).join('\n')
        : (editorReview.verdict === 'UNPARSEABLE'
            ? '（編集長レビューの出力を解析できませんでした。fail-closedのため公開を見送ります）'
            : '（理由未取得）');

      console.warn(`[publisher] AI編集長が公開を見送りました:\n${reasonsText}`);

      await development.saveDevelopmentLog({
        type:            development.QUALITY_EVENT_TYPES.EDITOR_REJECTION,
        title:           `AI編集長が公開を見送り（${articleNum}）`,
        summary:         reasonsText,
        affected_files:  'quality_scores',
        reason:          editorReview.comment || '編集長レビューによる公開見送り',
        impact:          'medium',
        breaking_change: false,
        status:          development.STATUS.AUTO_QUALITY,
      }, date).catch(err => console.warn(`[publisher] EDITOR_REJECTIONログ記録失敗: ${err.message}`));

      const qualityResult = await recordQuality({
        date, articleNum, validation, chartsOk: false, regenerationCount, mechanicalFixCount, editorReview,
      }).catch(err => {
        console.warn(`[publisher] 品質記録スキップ: ${err.message}`);
        return { overall: 'FAIL', record_type: 'AUTO_RETRY', consecutive_pass: 0, score: preEditorScore };
      });

      console.log(buildProgressLog(qualityResult.overall, qualityResult.record_type, qualityResult.consecutive_pass, qualityResult.score));
      appendFailLog({
        date, articleId: articleNum,
        finalSignal: decisions?.[0]?.final_signal, finalAsset: decisions?.[0]?.target_asset,
        failStage: 'editor_rejected',
        ruleNums: validation.warnings.map(w => (w.match(/Rule (\d+)/) || [])[1]).filter(Boolean),
        warnings: validation.warnings,
        mechanicalFixCount, regenerationCount, editorReview,
        note,
      });
      const fallbackDraftUrl = await saveFallbackDraft('AI編集長が公開を見送り');
      return {
        note, x: '', date, noteUrl: null,
        validationFailed: true,
        editorRejected: true,
        editorReview,
        qualityScore: qualityResult.score,
        fallbackDraftUrl,
      };
    }
  } else if (validation.ok) {
    // validation.ok（警告ゼロ）であれば理論上total_scoreは常に100点になるため通常到達しないが、
    // 将来のスコア算出ロジック変更に備えた安全側のフォールバック。
    console.warn(`[publisher] Quality Score ${preEditorScore.total}点が公開基準(${PUBLISH_SCORE_THRESHOLD}点)未満のためAI編集長レビューをスキップし公開を見送ります`);
    const qualityResult = await recordQuality({
      date, articleNum, validation, chartsOk: false, regenerationCount, mechanicalFixCount,
    }).catch(err => {
      console.warn(`[publisher] 品質記録スキップ: ${err.message}`);
      return { overall: 'FAIL', record_type: 'AUTO_RETRY', consecutive_pass: 0, score: preEditorScore };
    });
    console.log(buildProgressLog(qualityResult.overall, qualityResult.record_type, qualityResult.consecutive_pass, qualityResult.score));
    appendFailLog({
      date, articleId: articleNum,
      finalSignal: decisions?.[0]?.final_signal, finalAsset: decisions?.[0]?.target_asset,
      failStage: 'quality_score_below_threshold',
      ruleNums: validation.warnings.map(w => (w.match(/Rule (\d+)/) || [])[1]).filter(Boolean),
      warnings: validation.warnings,
      mechanicalFixCount, regenerationCount, editorReview: null,
      note,
    });
    const fallbackDraftUrl = await saveFallbackDraft('Quality Scoreが公開基準未満');
    return {
      note, x: '', date, noteUrl: null,
      validationFailed: true,
      qualityScore: qualityResult.score,
      fallbackDraftUrl,
    };
  }

  // ── 公開前整合性監査 ────────────────────────────────────────
  // validation は品質改善ループ（機械修正→LLM再生成）の最終結果をそのまま使う。
  {
    const SEP      = '━'.repeat(24);
    const chartsOk = !!(chartPath && historyChartPath);

    // 品質記録（PASS/FAIL 問わず実行。editorReviewはAPPROVED時のみ非null）
    const qualityResult = await recordQuality({
      date, articleNum, validation, chartsOk, regenerationCount, mechanicalFixCount, editorReview,
    }).catch(err => {
      console.warn(`[publisher] 品質記録スキップ: ${err.message}`);
      const fallbackScore = scoreArticle(validation, regenerationCount);
      return {
        overall:     validation.ok ? 'PASS' : 'FAIL',
        record_type: (mechanicalFixCount > 0 || regenerationCount > 0) ? 'AUTO_RETRY' : 'AUTO',
        consecutive_pass: 0,
        score: fallbackScore,
      };
    });

    if (!validation.ok) {
      const lines = [
        '', SEP, '',
        'ARTICLE VALIDATION FAILED', '',
        'Article ID', articleNum, '',
        'Warnings', String(validation.warnings.length), '',
        '機械修正試行', String(mechanicalFixCount), '',
        'LLM再生成試行', String(regenerationCount), '',
        SEP,
      ];
      validation.warnings.forEach(w => { lines.push('', w); });
      lines.push('', SEP, '', 'ARTICLE NOT PUBLISHED（品質改善ループ上限到達・人間の確認が必要）', '');
      console.error(lines.join('\n'));
      console.log(buildProgressLog(qualityResult.overall, qualityResult.record_type, qualityResult.consecutive_pass, qualityResult.score));
      appendFailLog({
        date, articleId: articleNum,
        finalSignal: decisions?.[0]?.final_signal, finalAsset: decisions?.[0]?.target_asset,
        failStage: 'validator_loop_exhausted',
        ruleNums: validation.warnings.map(w => (w.match(/Rule (\d+)/) || [])[1]).filter(Boolean),
        warnings: validation.warnings,
        mechanicalFixCount, regenerationCount, editorReview: null,
        note,
      });
      const fallbackDraftUrl = await saveFallbackDraft('品質改善ループ上限到達');
      return { note, x: '', date, noteUrl: null, validationFailed: true, validationWarnings: validation.warnings, qualityScore: qualityResult.score, fallbackDraftUrl };
    }

    console.log([
      '', SEP, '',
      'ARTICLE VALIDATION PASSED', '',
      'Warnings', '0', '',
      '機械修正', `${mechanicalFixCount}回`, '',
      'LLM再生成', `${regenerationCount}回`, '',
      'Publishing...', '',
      SEP, '',
    ].join('\n'));
    console.log(buildProgressLog(qualityResult.overall, qualityResult.record_type, qualityResult.consecutive_pass, qualityResult.score));
  }

  // ── チェック④: グラフ生成が2枚未満なら公開停止（修正版Draftのみ保存） ──
  // グラフはAI Capital記事の重要コンテンツのため、0〜1枚しか生成できていない場合は
  // 通常の下書き保存（実質的な「公開」扱い）へ進まず、Validator失敗時と同じ経路で止める。
  if (graphsGenerated < 2) {
    console.error(`[publisher] グラフ生成が${graphsGenerated}/2枚のため公開を停止します（円グラフ:${chartPath ? 'OK' : '失敗'} 面グラフ:${historyChartPath ? 'OK' : '失敗'}）`);
    await development.saveDevelopmentLog({
      type:            development.QUALITY_EVENT_TYPES.CHART_GENERATION_INCOMPLETE,
      title:           `グラフ生成不足により公開停止（${articleNum}）`,
      summary:         `円グラフ:${chartPath ? 'OK' : '失敗'} / 面グラフ:${historyChartPath ? 'OK' : '失敗'}`,
      affected_files:  'data/charts',
      reason:          'グラフ生成が2枚未満のため公開停止',
      impact:          'medium',
      breaking_change: false,
      status:          development.STATUS.AUTO_QUALITY,
    }, date).catch(err => console.warn(`[publisher] CHART_GENERATION_INCOMPLETEログ記録失敗: ${err.message}`));
    const fallbackDraftUrl = await saveFallbackDraft('グラフ生成不足');
    return {
      note, x: '', date, noteUrl: null,
      validationFailed: true, chartsIncomplete: true,
      graphsGenerated, graphsEmbedded: 0,
      fallbackDraftUrl,
    };
  }

  // ── チェック②: 本文内にマーカーが両方存在するか（見出し検出に依存しない最終防衛ライン） ──
  // applyPostProcessing()内の見出し検出（💰/👑）が何らかの理由で失敗しても、ここで必ず
  // マーカーを本文へ追記することで、noteDraft.jsの画像挿入が「no-marker」で失敗しないようにする。
  ensureMarkersPresent();

  // note.com へ下書き保存（先に保存してURLを取得）
  let noteUrl = null;
  let graphsEmbedded = 0;
  try {
    const result = await saveDraft({ body: note, chartPath, historyChartPath, thumbPath });
    noteUrl = result.url;
    graphsEmbedded = [result.historyEmbedded, result.chartEmbedded].filter(Boolean).length;
    console.log(`[publisher] Graphs Embedded : ${graphsEmbedded} / 2`);
    console.log(`[publisher] note.com 下書き保存完了: ${noteUrl}`);
    if (graphsEmbedded < 2) {
      console.error(`[publisher] グラフ埋め込みが${graphsEmbedded}/2枚のため要確認です（history:${result.historyEmbedded} chart:${result.chartEmbedded}）`);
      await development.saveDevelopmentLog({
        type:            development.QUALITY_EVENT_TYPES.CHART_EMBED_INCOMPLETE,
        title:           `グラフ埋め込み不足（${articleNum}）`,
        summary:         `history埋め込み:${result.historyEmbedded} / chart埋め込み:${result.chartEmbedded} / note: ${noteUrl}`,
        affected_files:  'lib/noteDraft.js',
        reason:          'note.com下書きへの画像埋め込みが2枚未満',
        impact:          'medium',
        breaking_change: false,
        status:          development.STATUS.AUTO_QUALITY,
      }, date).catch(err => console.warn(`[publisher] CHART_EMBED_INCOMPLETEログ記録失敗: ${err.message}`));
    }
  } catch (err) {
    console.error(`[publisher] note.com 下書き保存失敗: ${err.message}`);
  }

  // Pass 2: X投稿文生成（note保存後に実行してURLをコンテキストへ渡す）
  // X投稿には公開後の記事URL（note.com/{account}/n/xxxxx）を渡す。
  // 下書きエディタURL（editor.note.com/...）は本人以外アクセスできないため。
  console.log('[publisher] X投稿文生成中');
  const publicNoteUrl = toPublicNoteUrl(noteUrl);
  const xContext = publicNoteUrl
    ? `${note}\n\n---\n【note URL】${publicNoteUrl}`
    : note;
  let x = await ask(X_SYSTEM, xContext, { num_predict: 400, temperature: 0.6 });
  // 旧パターンラベル除去（互換）
  x = x.replace(/^パターン[A-Cａ-ｃ][\s\S]*?\n\n?/, '');
  console.log(`[publisher] X投稿文生成完了 (${x.length}字)`);

  // グラフ埋め込みが2/2に満たない場合は、Validator FAIL等の他の失敗経路と同じ重みで
  // 「公開停止・要確認」として扱う（chartsIncompleteだけでは警告表示に留まっていたため
  // 2026-08-14に明示化。noteUrl自体は人間が手動で直すためのリンクとして返す）。
  return {
    note, x, date, noteUrl,
    validationFailed: graphsEmbedded < 2,
    chartsIncomplete: graphsEmbedded < 2,
    graphsGenerated, graphsEmbedded,
  };
}

module.exports = {
  publish, buildContext, applyPostProcessing, injectRecommendations, injectRecommendationSummary,
  buildRule33DataHint,
};
