'use strict';

/**
 * weekly.js — 週刊記事エージェント（V1）
 *
 * 日刊記事の単純な集約ではなく、「AI Capitalが1週間をどう分析し、
 * どう判断し、何を学んだか」を伝える記事を組み立てる。
 *
 * 構成（V1.7・13セクション）:
 *   ① 今週の総括（LLM・30秒で伝わる文章）
 *   ② 今週のトピック（機械生成・3〜5項目）
 *   ③ 今週のマーケット振り返り（機械生成 + 推移チャート）
 *   ④ AI Capitalの行動履歴（機械生成）
 *   ⑤ 🏆今週の勝者・敗者（LLM・部署ごとの判断が市場結果にどれだけ近かったかを評価）
 *   ⑥ 🔥今週の論争（LLM・部署間で最も意見が割れたテーマを、各部署の論拠つきで紹介）
 *   ⑦ ポートフォリオ変化（機械生成・前週比較）
 *   ⑧ 📚AIの成長記録（LLM・今週の議論から得た投資判断の学び。開発の進捗報告ではない）
 *   ⑨ 🎯来週の焦点（LLM・来週注目すべき条件と、それが重要な理由）
 *   ⑩ 秘書室長週報（LLM: 相沢レイ・振り返り＋組織方針としての展望）
 *   ⑪ 今週の一言（名言）（LLM・発言者/発言内容/一言解説の3行、担当は毎週変動）
 *   ⑫ 来週のAI Capital会議テーマ（LLM）
 *   ⑬ 次号予告（LLM・読者向けteaser）
 *
 * 週刊記事は一般読者向けの投資組織レポートであり、AI開発日誌ではない。品質スコア・
 * Rule Engine・feat:/fix:・Phase番号・Validator等の内部管理用語や実装内容は本文に一切
 * 出さない（WEEKLY_STYLE_RULES・MAJOR_EVENT_READER_PHRASEが正本。2026-08-01変更で
 * 旧⑮「今週の記事品質」セクションは内部管理情報として全廃）。
 * 2026-08-01追加で、単なる投資レポートから「AI組織の成長日誌」として読み継がれる連載へ
 * 進化させるため、内容が重複していた旧⑤部署別レビュー・旧⑥判断ハイライト・
 * 旧⑧AIが学んだこと・旧⑨来週の注目条件・旧⑪MVPを、⑤⑥⑧⑨の4セクションへ統合・置換した
 * （MVPは⑤🏆今週の勝者・敗者に統合されたため独立セクションとしては廃止）。
 *
 * 章構成は WEEKLY_SECTIONS（本ファイル下部）が単一の正本。毎週この順序・
 * 章数のまま「固定テンプレート＋可変データ（gatherWeeklyDataが集めるその週のデータ）」
 * で生成するため、通常運用が続く限りプロンプトの手直しは不要。
 *
 * 重大イベントの自動反映（人手のログ記録に依存しない）:
 *   投資哲学変更・Rule Engine変更・評価ロジック変更・Validator追加・候補資産追加・
 *   部署追加・AI社員追加・重大バグ修正・大型イベントは、コード変更のコミット時に
 *   git の post-commit フック（scripts/auto-devlog.js）が diff を解析して自動分類し、
 *   development_logs への記録・バージョン更新（lib/systemVersion.js）・
 *   CHANGELOG.md の更新までを人手を介さず行う。誰かが saveDevelopmentLog() を
 *   書き忘れても記録は残る（分類できない変更は type:'OTHER' として記録され、
 *   Weekly記事へは反映されない＝通常運用として扱われる）。
 *   weekly.js はその結果（development_logs）を読むだけで、①②⑧⑩へ自動反映する。
 *
 * サムネイル: 日刊用と異なり、固定ファイル data/weekly_assets/週刊サムネ.png を使用する。
 *
 * 手動実行: node _run_weekly.js YYYY-MM-DD YYYY-MM-DD
 */

const sheets         = require('../lib/sheets');
const { ask }        = require('../lib/ollama');
const development    = require('./development');
const readerFeedback = require('../lib/readerFeedback');

// ── 定数 ─────────────────────────────────────────────────────

const INITIAL_ASSETS = 10_000_000;

const DEPT_DISPLAY = {
  market:    { name: '神谷シン',   dept: 'マーケット分析部',     emoji: '📈' },
  risk:      { name: '黒崎ミサキ', dept: 'リスク管理部',         emoji: '🛡️' },
  portfolio: { name: '橘アオイ',   dept: 'ポートフォリオ管理部', emoji: '💼' },
  audit:     { name: '鬼塚ガイ',   dept: '審査部',               emoji: '🔍' },
};

// agent_votes/agent_recommendations の department 表記 → 内部キー
const DEPT_KEY_BY_LABEL = {
  'マーケット分析部':     'market',
  'リスク管理部':         'risk',
  'ポートフォリオ管理部': 'portfolio',
  '審査部':               'audit',
};

const SIGNAL_WEIGHT = { BUY: 2, ACCUMULATE: 1, WAIT: 0, DEFEND: -1, SELL: -2 };

// ── 記事表現ルール（2026-08-01追加・全LLMセクション共通の正本） ──────
//
// 週刊記事は一般読者向けの投資組織レポートであり、AI開発日誌ではない。
// 以下は全LLM系セクション（①⑤⑥⑧⑩⑪⑫⑬⑭）のシステムプロンプト末尾に
// 必ず付与し、モデルの出力に混入しないよう繰り返し明示する。
const WEEKLY_STYLE_RULES = `
【表現ルール・厳守】
・「逆張り」「逆張り投資」「逆張り的視点」は使用禁止。代わりに「市場心理を総合評価した結果」
　「長期投資として魅力が高まった局面」「投資判断ロジックによる総合評価」のような、
　総合的な判断として自然に読める表現を使うこと。
・以下の開発・システム実装用語は一切使用禁止：feat: / fix: / commit / Phase1 / Phase2 /
　Quality Score / LLM / Validator / Git / バージョン管理 / Rule Engine / 内部システム名称 /
　開発ログ / コード実装内容。システム面の変更に触れる場合は、必ず一般読者向けの自然な文章に
　変換すること（例：「Rule Engineを更新」→「投資判断ロジックを改善しました」、
　「記事品質Phase5」→「記事品質を向上しました」）。
・記事内に品質スコア・点数（例：98点、99点）や「Quality Score」「品質推移」「品質評価」「記事品質」
　等の内部管理指標は一切記載しないこと。これらは読者に不要な内部情報である。`.trim();

// development_logs の type（内部分類ラベル）→ 週刊記事で使う一般読者向けの自然な言い回し。
// MAJOR_EVENT_TYPESの値をそのまま記事へ出す（例:「Rule Engine変更」）とWEEKLY_STYLE_RULESに
// 違反するため、①②⑧⑩へ差し込む前に必ずこのマップを経由させる。
const MAJOR_EVENT_READER_PHRASE = {
  '投資哲学変更':     '投資方針の見直し',
  'Rule Engine変更':  '投資判断ロジックの改善',
  '評価ロジック変更': '評価方法の改善',
  'Validator追加':    '記事チェック体制の強化',
  '候補資産追加':     '投資候補資産の追加',
  '部署追加':         '新部署の設立',
  'AI社員追加':       '新しいAI社員の着任',
  '重大バグ修正':     '運用上の不具合の修正',
  '大型イベント':     '組織体制の大きな変更',
};

// development_logs の title/summary は git のコミット件名・本文がそのまま入るため、
// "feat(decision): ..." のようなconventional commit接頭辞やPhase表記が残っていることがある。
// LLMへ渡すcontext・機械生成テキストへ使う前に必ずこの関数で除去する。
function sanitizeDevLogText(text) {
  if (!text) return '';
  return text
    .replace(/^(feat|fix|chore|refactor|docs|test|style|perf|build|ci)(\([^)]*\))?:\s*/i, '')
    .replace(/\bPhase\s?\d+\b/gi, '')
    .trim();
}

// ── Week ID ───────────────────────────────────────────────────

/**
 * ISO 8601 週番号から week_id を生成する
 * 例: '2026-06-26' → '2026-W26'
 */
function weekId(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function buildWeeklyMeta(startDate, endDate) {
  return {
    week_id:      weekId(startDate),
    start_date:   startDate,
    end_date:     endDate,
    status:       'draft',
    generated_at: null,
    published_at: null,
  };
}

function dayBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── データ取得 ────────────────────────────────────────────────

/**
 * 指定期間のデータを全シートから収集する
 */
async function gatherWeeklyData(startDate, endDate) {
  const [
    marketRows,
    voteRows,
    recRows,
    decisionRows,
    orderRows,
    pfThisWeek,
    pfPrevWeek,
    positionRows,
    devLogRows,
  ] = await Promise.all([
    sheets.getRowsByDateRange('market_data',          startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('agent_votes',           startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('agent_recommendations', startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('final_decisions',       startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('orders',                startDate, endDate).catch(() => []),
    sheets.getLatestRowAsOf('portfolio_status', endDate).catch(() => null),
    sheets.getLatestRowAsOf('portfolio_status', dayBefore(startDate)).catch(() => null),
    sheets.getRows('positions').catch(() => []),
    sheets.getRowsByDateRange('development_logs',      startDate, endDate).catch(() => []),
  ]);

  const majorEvents = devLogRows
    .filter(r => development.isMajorEvent(r.type))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // 読者コメントは note.com 側の自動取得手段が無いため、_add_reader_feedback.js で
  // 手動記録された分のみを対象週で読み込む（ゼロ件が通常運用）。
  const weekReaderFeedback = readerFeedback.getFeedbackForWeek(startDate, endDate);

  return {
    period:        { start: startDate, end: endDate, days: marketRows.length },
    market:        marketRows.sort((a, b) => (a.date < b.date ? -1 : 1)),
    marketSummary: summarizeMarket(marketRows),
    decisions:     decisionRows,
    orders:        orderRows,
    votesByDept:   aggregateVotesByDept(voteRows),
    recsByDept:    aggregateRecsByDept(recRows),
    portfolio:     pfThisWeek,
    portfolioPrev: pfPrevWeek,
    positions:     positionRows,
    latestMarket:  marketRows[marketRows.length - 1] ?? null,
    majorEvents,
    readerFeedback: weekReaderFeedback,
  };
}

// ── 重大イベント（development_logs由来。git post-commitフックによる自動記録） ─
//
// その週に development.MAJOR_EVENT_TYPES 該当のログが1件でもあれば、
// weekContextText() 経由で全LLMセクションのcontextへ差し込まれる。
// ①総括・⑧学んだこと・⑩秘書室長週報のシステムプロンプトは、この項目がcontextに
// 存在する場合のみ必ず言及するよう固定文で指示済み（週ごとの手直し不要）。
function majorEventsContextText(events) {
  if (!events || events.length === 0) return null;
  return events.map(e => {
    const phrase = MAJOR_EVENT_READER_PHRASE[e.type] || '運用面の改善';
    const flags = [];
    if (e.impact)                                    flags.push(`影響度:${e.impact}`);
    if (String(e.breaking_change).toLowerCase() === 'true') flags.push('大幅な変更');
    if (e.version)                                   flags.push(`更新後バージョン:${e.version}`);
    const flagText = flags.length ? `（${flags.join(' / ')}）` : '';
    const title   = sanitizeDevLogText(e.title);
    const summary = sanitizeDevLogText(e.summary);
    return `${e.date} [${phrase}] ${title}：${summary}${flagText}`;
  }).join('\n');
}

// その週の最後の重大イベント時点のバージョン（＝週末時点のAI Capitalバージョン）
function latestVersionThisWeek(events) {
  if (!events || events.length === 0) return null;
  return events[events.length - 1].version || null;
}

// ── 集計ヘルパー ──────────────────────────────────────────────

function summarizeMarket(rows) {
  if (!rows.length) return null;
  const pick = key => rows.map(r => parseFloat(r[key])).filter(v => !isNaN(v));
  const stat = arr => arr.length
    ? { min: Math.min(...arr), max: Math.max(...arr), avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 }
    : null;
  return {
    fear_greed: stat(pick('fear_greed')),
    vix:        stat(pick('vix')),
    usdjpy:     stat(pick('usdjpy')),
    sp500:      stat(pick('sp500')),
    nasdaq100:  stat(pick('nasdaq100')),
  };
}

function aggregateVotesByDept(voteRows) {
  const result = {};
  for (const key of Object.keys(DEPT_DISPLAY)) {
    result[key] = Object.fromEntries(Object.keys(SIGNAL_WEIGHT).map(s => [s, 0]));
  }
  for (const row of voteRows) {
    const key    = DEPT_KEY_BY_LABEL[row.department];
    const signal = (row.signal || '').toUpperCase();
    if (key && result[key] && signal in result[key]) result[key][signal]++;
  }
  return result;
}

function aggregateRecsByDept(recRows) {
  const result = {};
  for (const key of Object.keys(DEPT_DISPLAY)) result[key] = [];
  for (const row of recRows) {
    const key = DEPT_KEY_BY_LABEL[row.department];
    if (!key) continue;
    result[key].push({
      date:   row.date,
      type:   row.recommendation_type || row.action || '',
      asset:  row.asset_name || 'なし',
      amount: parseInt(row.amount || 0),
      reason: row.reason_summary || '',
    });
  }
  return result;
}

// ── ①今週の総括（LLM・30秒で伝わる文章） ─────────────────────

const WEEKLY_SUMMARY_SYSTEM = `あなたはAI Capital運用チーム全体を俯瞰する立場から、週刊レポートの書き出しを書きます。
「今週どのような1週間だったのか」が読者に30秒で伝わるよう、3〜4文の自然な文章でまとめてください。
・今週の市場評価
・AI Capitalの行動概要
・今週の結論
の3要素を、箇条書きではなく1つの流れる文章として織り込むこと。
与えられたデータのみを根拠にし、新しい数値を創作しないこと。数値を羅列するだけの文にしないこと。
【重要】contextに「今週の重大アップデート」という項目がある場合、それは今週AI Capitalに
加えられた仕様変更・ルール変更等の重大な出来事である。その場合は必ず1文でその内容に触れ、
「更新後バージョン」が含まれていれば「AI Capitalはv2.4へ更新されました」のように
バージョン番号も明記すること。この項目が無い場合は、通常通り上記3要素のみで構成すること
（無理に言及を作らないこと）。

${WEEKLY_STYLE_RULES}`;

async function buildSummary(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_SUMMARY_SYSTEM, ctx, { num_predict: 300, temperature: 0.6 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ① 今週の総括`, '', body.trim()].join('\n');
}

// ── ②今週のトピック（機械生成） ───────────────────────────────

function buildTopics(data) {
  const { orders, decisions, marketSummary, market, majorEvents } = data;
  if (!marketSummary) return `## ② 今週のトピック\n\nデータなし`;

  const assetCounts = {};
  for (const o of orders) {
    const name = o.asset_name || '不明';
    assetCounts[name] = (assetCounts[name] || 0) + 1;
  }
  const topAsset  = Object.entries(assetCounts).sort((a, b) => b[1] - a[1])[0];
  const waitCount = decisions.filter(d => (d.final_signal || '').toUpperCase() === 'WAIT').length;
  const fgAvg     = marketSummary.fear_greed?.avg;

  // 今週最大の出来事: Fear&Greedが最も低かった日（恐怖が最も強まった局面）を機械抽出
  let bigEvent = '特筆すべき急変動なし';
  if (market.length > 0) {
    const worst = [...market]
      .filter(r => !isNaN(parseFloat(r.fear_greed)))
      .sort((a, b) => parseFloat(a.fear_greed) - parseFloat(b.fear_greed))[0];
    if (worst) {
      const d = decisions.find(x => x.date === worst.date);
      bigEvent = `${worst.date}にFear & Greedが${worst.fear_greed}まで低下${d ? `、AI Capitalは${d.final_signal}と判断` : ''}`;
    }
  }

  // システム更新: development_logs 由来の重大イベントを一般読者向けの言い回しへ変換して列挙する
  // （type/titleの生値＝内部システム用語やgitコミット件名は WEEKLY_STYLE_RULES 違反のため出さない）
  const systemUpdate = (majorEvents && majorEvents.length > 0)
    ? [...new Set(majorEvents.map(e => MAJOR_EVENT_READER_PHRASE[e.type] || '運用面の改善'))].join(' / ')
    : 'なし（通常運用週）';
  const versionNote = latestVersionThisWeek(majorEvents);

  const items = [
    `投資回数：${orders.length}回${topAsset ? `（最多は${topAsset[0]}へ${topAsset[1]}回）` : ''}`,
    `WAIT判断 ${waitCount}回`,
    `Fear & Greed平均 ${fgAvg ?? '—'}`,
    `今週最大の出来事：${bigEvent}`,
    `システム更新：${systemUpdate}${versionNote ? `（${versionNote} へ更新）` : ''}`,
  ];

  return [`## ② 今週のトピック`, '', ...items.map(i => `・${i}`)].join('\n');
}

// ── ③今週のマーケット振り返り（機械生成 + チャート） ───────────

function buildMarketRecap(data) {
  const { marketSummary } = data;
  if (!marketSummary) return `## ③ 今週のマーケット振り返り\n\nデータなし`;

  const fmt = (stat, digits = 1) => stat
    ? `${stat.min.toFixed(digits)} 〜 ${stat.max.toFixed(digits)}（平均 ${stat.avg.toFixed(digits)}）`
    : '—';

  return [
    `## ③ 今週のマーケット振り返り`,
    '',
    `▼HISTORY▼`,
    '',
    `📊 Fear & Greed : ${fmt(marketSummary.fear_greed, 0)}`,
    `⚡ VIX          : ${fmt(marketSummary.vix)}`,
    `💵 USD/JPY      : ${fmt(marketSummary.usdjpy, 2)} 円`,
    `📈 S&P500       : 前日比 ${fmt(marketSummary.sp500)} %`,
    `📈 NASDAQ100    : 前日比 ${fmt(marketSummary.nasdaq100)} %`,
  ].join('\n');
}

// ── ④AI Capitalの行動履歴（機械生成） ───────────────────────

function buildActionHistory(data) {
  const { decisions, orders, period } = data;
  if (!decisions.length) return `## ④ AI Capitalの行動履歴\n\n判断記録なし`;

  const sorted = [...decisions].sort((a, b) => (a.date < b.date ? -1 : 1));
  const rows = sorted.map(d => {
    const sig  = d.final_signal || '—';
    const ast  = d.selected_asset || d.target_asset || 'なし';
    const amt  = parseInt(d.selected_amount || d.amount || 0);
    return `・${d.date} | ${sig} | ${ast} | ${amt > 0 ? `¥${amt.toLocaleString()}` : '—'}`;
  });

  const totalBuy  = orders.reduce((s, o) => s + parseInt(o.amount || 0), 0);
  const buyCount  = sorted.filter(d => ['BUY', 'ACCUMULATE'].includes((d.final_signal || '').toUpperCase())).length;
  const waitCount = sorted.filter(d => (d.final_signal || '').toUpperCase() === 'WAIT').length;

  return [
    `## ④ AI Capitalの行動履歴`,
    '',
    ...rows,
    '',
    `**今週の総投資額**：¥${totalBuy.toLocaleString()}`,
    `**観測ポジション回数**：${buyCount}回 / ${period.days}営業日`,
    `**WAIT回数**：${waitCount}回`,
  ].join('\n');
}

// ── ⑤🏆今週の勝者・敗者（LLM・部署の判断が市場結果にどれだけ近かったかを評価） ──
//
// 旧「部署別レビュー」（各部署の自己申告的な振り返り）と旧「MVP」（1名選出）を統合し、
// 「市場結果・最終判断と照らして最も的確だった部署／最も見直しの余地があった部署」を
// 客観的に評価する形式へ再構成した（2026-08-01）。

const WEEKLY_WINNER_LOSER_SYSTEM = `あなたはAI Capital運用チーム全体を俯瞰する立場です。
今週1週間の各部署（神谷シン=マーケット分析部／黒崎ミサキ=リスク管理部／橘アオイ=ポートフォリオ管理部／鬼塚ガイ=審査部）の
提案・判断履歴を、判断"過程"の質という観点で評価し、
「今週最も判断過程が的確だった部署（勝者）」と「今週最も判断過程に見直しの余地があった部署（反省点）」を
それぞれ1部署ずつ選出してください。
【厳禁】市場が結果的に上がった／下がったという結果だけを根拠に「当たった／外れた」と評価すること
（後知恵評価）は禁止する。市場結果が確定していない判断について「上がったから正しかった」
「下がったから間違いだった」のような表現は一切使わないこと。
評価の観点（例。実際の内容はデータに基づくこと。市場結果の当たり外れではなく過程の質で選ぶこと）：
・判断の一貫性（週を通じて主張の軸がぶれていないか、根拠なく判断を翻していないか）
・その時点の市場環境（Fear & Greed・VIX等）との整合性（判断時点で説明できる根拠があったか）
・ポートフォリオへの適合性（現金比率・集中度・配分方針に沿っていたか）
・他部署との比較（同じ材料に対し、より具体的・数値的な根拠を示せていたか）
・判断変更の妥当性（見解を変えた場合、変更理由が数値・状況の変化で説明できているか）
出力形式（厳守）：
🏆 今週の勝者
（氏名）（部署）

理由
（2〜3文、具体的な数値・出来事を根拠に）

🔻 今週の反省点
（氏名）（部署）

理由
（2〜3文、具体的な数値・出来事を根拠に。人格を否定する書き方はせず、次に活かせる視点として書くこと）
上記の形式以外の文章・前置き・見出しは出力しないこと。同じ部署を両方に選ばないこと。
与えられたデータのみを根拠にし、新しい数値を創作しないこと。

${WEEKLY_STYLE_RULES}`;

// 部署ごとの提案履歴テキスト（🏆⑤・🔥⑥・⑨いずれからも参照する共通ヘルパー）
function deptContextText(key, data) {
  const recs = data.recsByDept[key] || [];
  if (recs.length === 0) return '今週の提案記録なし。';
  return recs.map(r =>
    `${r.date} | ${r.type} | ${r.asset} | ${r.amount > 0 ? `¥${r.amount.toLocaleString()}` : '—'} | ${r.reason}`
  ).join('\n');
}

function winnerLoserContextText(data) {
  const { market, decisions } = data;
  const marketLines = (market || []).map(m =>
    `${m.date} | F&G:${m.fear_greed ?? '—'} VIX:${m.vix ?? '—'} S&P500:${m.sp500 ?? '—'}% NASDAQ100:${m.nasdaq100 ?? '—'}%`
  ).join('\n');
  const decisionLines = (decisions || []).map(d => `${d.date} 最終判断=${d.final_signal || '—'}`).join('\n');
  const deptLines = Object.keys(DEPT_DISPLAY).map(key => {
    const meta = DEPT_DISPLAY[key];
    return `【${meta.name}（${meta.dept}）】\n${deptContextText(key, data)}`;
  }).join('\n\n');
  return [
    '■ 今週の市場推移',
    marketLines || 'データなし',
    '',
    '■ 今週の最終判断',
    decisionLines || 'データなし',
    '',
    '■ 部署ごとの提案履歴',
    deptLines,
  ].join('\n');
}

async function buildWinnerLoser(data) {
  const ctx = winnerLoserContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_WINNER_LOSER_SYSTEM, ctx, { num_predict: 500, temperature: 0.6 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ⑤ 今週の勝者・敗者`, '', body.trim()].join('\n');
}

// ── ⑥🔥今週の論争（LLM・部署間で最も意見が割れたテーマを対話形式で紹介） ──
//
// 旧「今週の判断ハイライト」を、単なる決着報告ではなく「AI社員同士が議論している」と
// 感じられる対立構造の描写へ再構成した（2026-08-01）。

const WEEKLY_DEBATE_SYSTEM = `今週1週間のAI Capitalの判断データを見て、部署間で最も意見が割れたテーマを1つ選び、紹介してください。
テーマの例（あくまで例。実際の内容はデータに基づくこと）：
・特定銘柄を買うべきか
・現金比率を維持するべきか
・Fear & Greedをどこまで重視するべきか
・ATH乖離率をどこまで重視するべきか
単に「意見が割れた」と述べるのではなく、関係する部署それぞれが「なぜそう考えたか」の根拠まで紹介し、
読者がAI社員同士の議論を覗き見しているように感じられる書き方にすること（可能であれば引用形式
> 「〜」 を使い、部署ごとの発言として書くこと）。
最後に、実際にはどちらの意見が採用され、最終判断がどうなったかを明記すること。
日付を明記し、5〜8行程度。与えられたデータのみ使うこと。新しい数値を創作しないこと。

${WEEKLY_STYLE_RULES}`;

async function buildDebate(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_DEBATE_SYSTEM, ctx, { num_predict: 600, temperature: 0.7 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ⑥ 今週の論争`, '', body.trim()].join('\n');
}

// ── ⑦ポートフォリオ変化（機械生成・前週比較） ─────────────────

function buildPortfolioChange(data) {
  const { portfolio: cur, portfolioPrev: prev } = data;
  if (!cur) return `## ⑦ ポートフォリオ変化\n\nデータなし`;

  const curTotal = parseInt(cur.total_assets || 0);
  const curCash  = parseFloat(cur.cash_ratio || 0);
  const curPl    = parseInt(cur.unrealized_pl || 0);
  const curPend  = parseInt(cur.pending || 0);

  const prevTotal = prev ? parseInt(prev.total_assets || 0) : INITIAL_ASSETS;
  const prevCash  = prev ? parseFloat(prev.cash_ratio || 0) : 100.0;
  const prevPl    = prev ? parseInt(prev.unrealized_pl || 0) : 0;

  const diffTotal = curTotal - prevTotal;
  const diffCash  = curCash - prevCash;
  const diffPl    = curPl - prevPl;
  const sign      = v => (v >= 0 ? '+' : '') + v.toLocaleString();

  const positions   = JSON.parse(cur.positions_json || '[]');
  const holdRatio   = curTotal > 0 ? (100 - curCash).toFixed(1) : '0.0';

  const posLines = positions.length
    ? positions.map(p => `  ・${p.name}：¥${Number(p.market_value || 0).toLocaleString()}`).join('\n')
    : '  ・なし';

  return [
    `## ⑦ ポートフォリオ変化`,
    '',
    `総資産　：¥${curTotal.toLocaleString()}（前週比 ${sign(diffTotal)}）`,
    `現金比率：${curCash.toFixed(1)}%（前週比 ${sign(+diffCash.toFixed(1))}pt）`,
    `保有比率：${holdRatio}%`,
    `注文中　：¥${curPend.toLocaleString()}`,
    `含み損益：${curPl >= 0 ? '+' : ''}¥${curPl.toLocaleString()}（前週比 ${sign(diffPl)}）`,
    '',
    `保有銘柄:`,
    posLines,
  ].join('\n');
}

// ── ⑧📚AIの成長記録（LLM・投資判断の学び。開発の進捗報告ではない） ──
//
// 旧「AIが学んだこと」を、「AI Capitalが毎週少しずつ賢くなっている」という
// 連載としての成長ストーリーが伝わる見出し・トーンへ強化した（2026-08-01）。

const WEEKLY_GROWTH_SYSTEM = `あなたはAI Capital運用チーム全体を俯瞰する立場です。
今週1週間、各部署が議論の中で示した根拠・対立・合意形成を踏まえ、
「今週の議論からAI Capitalが得た投資判断の学び・改善点」を3〜4点、箇条書きでまとめてください。
これは開発の進捗報告ではない。何を直したか・何を実装したかではなく、その出来事を通じて
「投資判断としてどんな教訓を得たか」を一般読者にも伝わる自然な言葉で書くこと
（視点の例：市場心理だけで判断しない重要性を学んだ／現金比率を維持することの価値を再確認した／
部署間の意見が割れた時ほど慎重な判断が重要だと学んだ／短期的な値動きより資産配分を優先する
考え方が強化された、など。ただし例の丸写しは禁止）。
「AI Capitalは今週もまた少し賢くなった」ということが、大げさな宣言ではなく箇条書きの内容から
自然に伝わるようにすること。与えられたデータから読み取れる具体的な傾向のみ書くこと。各項目1行、簡潔に。
【重要】contextに「今週の重大アップデート」という項目がある場合、それは今週AI Capitalの
投資判断の仕組みに加えられた変化である。専門用語や実装内容には一切触れず、その変化から
どんな投資判断上の教訓・気づきを得たかを箇条書きの1項目として必ず含めること
（例：「Rule Engineを更新」ではなく「複数の指標を組み合わせて判断する体制を強化した」のように書く）。
この項目が無い場合は、通常通り市場観察・部署間の議論から得た判断基準の学びという観点でまとめること。
【重要】contextに「今週寄せられた読者コメント」がある場合、それは読者から寄せられた視点であり
AI Capital側の事実や結論ではない。箇条書き1項目として「読者から〜という視点が寄せられ、
それを踏まえて〜を意識するようになった」のように、あくまで読者由来の指摘として触れ、
読者の主張をAI Capital自身の判断結果であるかのように断定しないこと。この項目が無い場合は
無理に読者コメントへ言及しないこと。

${WEEKLY_STYLE_RULES}`;

// 読者コメントは事実ではなく「読者から寄せられた視点」としてLLMへ渡す文言に統一する
// （①-5要件：読者コメントを学習材料として扱う際、事実断定は禁止）。
function readerFeedbackContextText(entries) {
  if (!entries || entries.length === 0) return null;
  return entries
    .map(e => `${e.date} [読者から寄せられた視点${e.theme ? `・${e.theme}` : ''}] ${e.comment}`)
    .join('\n');
}

function weekContextText(data) {
  const { marketSummary, decisions, orders, votesByDept, recsByDept, majorEvents, readerFeedback: feedback } = data;
  const parts = [];
  const eventsText = majorEventsContextText(majorEvents);
  if (eventsText) parts.push(`今週の重大アップデート:\n${eventsText}`);
  if (marketSummary) {
    parts.push(`Fear&Greed: ${marketSummary.fear_greed?.min}-${marketSummary.fear_greed?.max}(avg ${marketSummary.fear_greed?.avg}) / VIX: ${marketSummary.vix?.min}-${marketSummary.vix?.max}(avg ${marketSummary.vix?.avg})`);
  }
  parts.push(`最終判断: ${decisions.map(d => `${d.date}=${d.final_signal}`).join(', ') || 'なし'}`);
  parts.push(`発注: ${orders.map(o => `${o.date} ${o.asset_name} ¥${o.amount}`).join(', ') || 'なし'}`);
  for (const [key, meta] of Object.entries(DEPT_DISPLAY)) {
    const reasons = (recsByDept[key] || []).map(r => r.reason).filter(Boolean);
    if (reasons.length) parts.push(`${meta.dept}の根拠: ${reasons.join(' / ')}`);
  }
  const feedbackText = readerFeedbackContextText(feedback);
  if (feedbackText) parts.push(`今週寄せられた読者コメント:\n${feedbackText}`);
  return parts.join('\n');
}

async function buildGrowthRecord(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_GROWTH_SYSTEM, ctx, { num_predict: 350, temperature: 0.6 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ⑧ AIの成長記録`, '', body.trim()].join('\n');
}

// ── ⑨🎯来週の焦点（LLM・来週注目すべき条件と、それが重要な理由） ──
//
// 旧「来週の注目条件」（機械生成の定型文）を、現在の保有状況・現金比率を踏まえて
// 「なぜそれが重要なのか」までLLMが説明する形式へ再構成した（2026-08-01）。

const WEEKLY_FOCUS_SYSTEM = `AI Capitalの現在のポートフォリオ構成・直近の市場水準を踏まえ、
来週AI Capitalが最も注目している条件を3〜4項目、箇条書きで紹介してください。
項目の例（あくまで例。実際の条件・数値は与えられたデータに基づくこと）：
・Fear & Greedが一定水準を割る／超えるかどうか
・NASDAQ100やS&P500が反発するかどうか
・VIXが警戒水準を突破するかどうか
・ドル円の水準
・保有銘柄（Core資産）の反転・資金流入
単に数値条件を並べるのではなく、各項目について「なぜそれが重要なのか」を
現在の保有状況・現金比率・今週の議論を踏まえて一言添えること（例：「現金比率◯%を維持しているため」
「保有銘柄の含み損益に直結するため」など）。
各項目は「・条件：理由」の1行にまとめ、長い説明文にしないこと。
与えられたデータに存在しない数値・銘柄を創作しないこと。
出力は「・」で始まる箇条書きのみ。他の文章・前置き・見出しは一切書かないこと。

${WEEKLY_STYLE_RULES}`;

async function buildFocusPoints(data) {
  if (!data.latestMarket) return `## ⑨ 来週の焦点\n\nデータなし`;
  const ctx = nextThemeContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_FOCUS_SYSTEM, ctx, { num_predict: 350, temperature: 0.65 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  const bullets = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('・'));
  const content = bullets.length > 0 ? bullets.join('\n') : body.trim();
  return [`## ⑨ 来週の焦点`, '', content].join('\n');
}

// ── ⑩秘書室長週報（LLM） ─────────────────────────────────────

const WEEKLY_SECRETARY_SYSTEM = `あなたは相沢レイ、AI Capitalの秘書室長です。あなた自身は投資判断を行う立場ではありません。
今週1週間の会議・議論全体を振り返り、記事全体を締めくくる経営総括を書いてください。読み終えた読者が
「来週も見たい」と思えるような、締まりのある文章を目指すこと。
前半（振り返り）では以下を扱うこと：
・今週の議論で何が話し合われたか
・部署間で意見が分かれた点（データにその形跡があれば具体的に）
・最終判断に至った経緯、会議全体の雰囲気（緊張感があった／落ち着いていた、など）
後半（締め）では、来週へ向けた展望と、AI Capital全体としての方針を明確に打ち出すこと。
ただし「SOXを買うべき」のような具体的な投資方針・銘柄への言及は禁止。
「部署間の連携をより深めたい」「リスク許容度の判断基準を精緻化したい」のような、
AI Capitalという組織としての運営・議論姿勢に関する方針・展望に留めること。
地の文で、同じ表現・言い回しの繰り返しは避けること。5〜7行程度。与えられたデータのみを根拠にすること。
【重要】contextに「今週の重大アップデート」がある場合、前半の振り返りの中でその変更に触れ、
バージョン表記（例: v2.4）が含まれていれば「AI Capitalはv2.4へ更新されました」のように
明記すること。この項目が無い場合は、通常通り会議・議論の振り返りのみで構成すること。

${WEEKLY_STYLE_RULES}`;

async function buildSecretaryReport(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_SECRETARY_SYSTEM, ctx, { num_predict: 500, temperature: 0.7 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ⑩ 秘書室長週報（相沢レイ）`, '', body.trim()].join('\n');
}

// ── ⑪今週の一言（名言）（LLM） ───────────────────────────────
// 旧⑪「今週のAI社員MVP」は⑤🏆今週の勝者・敗者に統合されたため、独立セクションとしては廃止（2026-08-01）。

const WEEKLY_QUOTE_SYSTEM = `今週1週間のAI Capital各部署（神谷シン=マーケット分析部／黒崎ミサキ=リスク管理部／橘アオイ=ポートフォリオ管理部／鬼塚ガイ=審査部／相沢レイ=秘書室長）の
やり取りを踏まえ、今週最も印象に残った発言を1つ選定・創作してください。担当者は毎週変わってよい。
【重要・厳守】
・与えられたデータの reason（判断根拠）や議事録の文章をそのまま引用・要約・言い換えしないこと。
・「〜%が高い」「〜%まで低下」のような数値をそのまま読み上げる発言は禁止。
・そのキャラクターが今週の出来事を振り返って言いそうな、性格・口調が滲み出るオリジナルの発言を作ること。
・毎週同じような言い回しにならないよう、今週ならではの出来事（対立した部署、判断の分かれ目など）の
　"空気感"を踏まえつつ、数値を直接引用しない比喩・言い回しにすること。
必ず1名分のみ出力すること。複数キャラクター分を書いた場合は不正解とする。
出力形式（厳守・この3行のみ）：
発言者：（氏名）（部署）
発言内容：「（20〜40字程度、そのキャラクターの口調で）」
一言解説：（なぜこの発言が今週を象徴するのか、事実に基づき1文で）
それ以外の文章は出力しないこと。

${WEEKLY_STYLE_RULES}`;

async function buildQuote(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_QUOTE_SYSTEM, ctx, { num_predict: 280, temperature: 0.85 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  // LLMが複数名分を出力することがあるため、最初の1組（発言者/発言内容/一言解説）だけを取り出す
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const quoteIdx = lines.findIndex(l => /^発言内容[：:]/.test(l));
  let result = body.trim();
  if (quoteIdx >= 0) {
    let speaker = null;
    for (let i = quoteIdx - 1; i >= 0; i--) {
      if (lines[i]) { speaker = lines[i].replace(/^発言者[：:]\s*/, ''); break; }
    }
    let explanation = null;
    if (lines[quoteIdx + 1] && /^一言解説[：:]/.test(lines[quoteIdx + 1])) {
      explanation = lines[quoteIdx + 1];
    }
    const parts = [];
    if (speaker) parts.push(`発言者：${speaker}`);
    parts.push(lines[quoteIdx]);
    if (explanation) parts.push(explanation);
    if (parts.length > 0) result = parts.join('\n');
  }
  return [`## ⑪ 今週の一言（名言）`, '', result].join('\n');
}

// ── ⑫来週のAI Capital会議テーマ（LLM） ───────────────────────

const WEEKLY_NEXT_THEME_SYSTEM = `AI Capitalの現在のポートフォリオ構成・今週の市場環境・今週の議論内容を踏まえ、
来週のAI Capital会議で議論すべきテーマを1件、疑問形で提案してください。
例（あくまで形式の例。内容はコピーしないこと）：
・SOX集中率30%は許容範囲か
・Fear & Greed30以下で追加投資すべきか
・ゴールド比率の見直しは必要か
実際の保有比率・市場水準・今週の対立点など、与えられたデータに基づいた具体的なテーマにすること。
翌週の議論に直接つながる、答えが1つに決まっていない問いにすること。
例のように15〜25字程度の短い問いかけにすること（長い説明文にしないこと）。
出力は「・」で始まる1行のみ。他の文章・前置き・見出しは一切書かないこと。

${WEEKLY_STYLE_RULES}`;

function nextThemeContextText(data) {
  const pf  = data.portfolio;
  const mkt = data.latestMarket;
  const positions = pf ? JSON.parse(pf.positions_json || '[]') : [];
  const posLine = positions.length
    ? positions.map(p => `${p.name}:¥${Number(p.market_value || 0).toLocaleString()}`).join(', ')
    : 'なし';

  return [
    `現金比率: ${pf?.cash_ratio ?? '—'}%`,
    `保有銘柄: ${posLine}`,
    `直近Fear&Greed: ${mkt?.fear_greed ?? '—'} / VIX: ${mkt?.vix ?? '—'}`,
    weekContextText(data),
  ].join('\n');
}

async function buildNextTheme(data) {
  const ctx = nextThemeContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_NEXT_THEME_SYSTEM, ctx, { num_predict: 150, temperature: 0.75 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  // 前置きが付いた場合の安全網: 「・」で始まる行があればそれを優先する
  const bulletLine = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('・')).pop();
  const line = (bulletLine || body.trim().split('\n').filter(Boolean).pop() || body.trim()).replace(/^・/, '');
  return [`## ⑫ 来週のAI Capital会議テーマ`, '', `・${line}`].join('\n');
}

// ── ⑬次号予告（LLM） ───────────────────────────────────────

const WEEKLY_PREVIEW_SYSTEM = `AI Capital週刊号の最後に置く「次号予告」を作成してください。
来週の市場注目点・保有銘柄の状況・今週の議論の流れを踏まえ、
読者が「来週も読みたい」と思えるteaser（予告）を2〜3項目、箇条書きで作成してください。
例（形式の参考。内容はそのままコピーしないこと）：
・Fear & Greedが30を割った場合のAI判断
・注目銘柄の最新評価
・来週の会議テーマの結論
具体的な数値・銘柄名を使い、続きが気になるフックのある文にすること。抽象的な一般論は禁止。
【重要・厳守】与えられたデータに存在しない数値・日付・曜日・出来事を創作しないこと。
「〜になった場合」「〜を割ったら」のように仮定・未来の問いかけとして書くのは良いが、
「今週すでに起きたこと」として事実と異なる内容（数値の向き・時系列など）を書かないこと。
出力は「・」で始まる箇条書き2〜3行のみ。他の文章・前置き・見出しは一切書かないこと。

${WEEKLY_STYLE_RULES}`;

async function buildPreview(data) {
  const ctx = nextThemeContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_PREVIEW_SYSTEM, ctx, { num_predict: 250, temperature: 0.75 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  const bullets = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('・'));
  const content = bullets.length > 0 ? bullets.join('\n') : body.trim();
  return [`## ⑬ 次号予告`, '', '【次号予告】', '', content].join('\n');
}

// ── note.com向けクリーンアップ ─────────────────────────────────

/**
 * note.comのエディタはMarkdown記法を解釈しないため、見出し記号・強調記号・
 * 水平線を除去してプレーンテキストとして読める形に整形する。
 * (publisher.js の後処理群とは独立した、週刊専用の簡易版)
 */
function cleanupForNote(markdown) {
  let note = markdown;
  // ▼HISTORY▼ マーカーは除去しない: noteDraft.saveDraft() が画像挿入時に見つけて置き換える
  note = note.replace(/^#{2,3}[ \t]*/gm, '');
  note = note.replace(/\*\*(.+?)\*\*/g, '$1');
  note = note.replace(/^\*[ \t]{1,4}/gm, '・');       // Markdown箇条書き「* 」→「・」
  note = note.replace(/^---[ \t]*$/gm, '');
  note = note.replace(/\n{3,}/g, '\n\n');
  return note.trim();
}

// ── 固定テンプレート定義（①〜⑬・単一の正本） ───────────────────
//
// Weekly記事の章構成・順序はこの配列だけが正本（single source of truth）。
// 章を追加/削除/並べ替えたい場合はここを編集する（buildWeeklyDraft側は不変）。
// 各 build は (data) → string | Promise<string> を返す関数で、
// data（その週のデータ）だけが週ごとに変化し、build自体（＝テンプレート・
// プロンプト）は固定のまま再利用される、という「固定テンプレート＋可変データ」
// 構造をこの配列がそのまま体現している。
const WEEKLY_SECTIONS = [
  { no: '①',  title: '今週の総括',             build: buildSummary },
  { no: '②',  title: '今週のトピック',           build: buildTopics },
  { no: '③',  title: '今週のマーケット振り返り',   build: buildMarketRecap },
  { no: '④',  title: 'AI Capitalの行動履歴',     build: buildActionHistory },
  { no: '⑤',  title: '🏆今週の勝者・敗者',       build: buildWinnerLoser },
  { no: '⑥',  title: '🔥今週の論争',            build: buildDebate },
  { no: '⑦',  title: 'ポートフォリオ変化',        build: buildPortfolioChange },
  { no: '⑧',  title: '📚AIの成長記録',           build: buildGrowthRecord },
  { no: '⑨',  title: '🎯来週の焦点',            build: buildFocusPoints },
  { no: '⑩',  title: '秘書室長週報',             build: buildSecretaryReport },
  { no: '⑪',  title: '今週の一言',               build: buildQuote },
  { no: '⑫',  title: '来週のAI Capital会議テーマ', build: buildNextTheme },
  { no: '⑬',  title: '次号予告',                 build: buildPreview },
];

// ── メイン ──────────────────────────────────────────────────

/**
 * 週刊記事ドラフトを組み立てる（LLM呼び出しあり・note保存なし）
 * WEEKLY_SECTIONS の順で①〜⑭を毎週固定生成する。
 * （LLM負荷を局所に集中させないよう、機械生成/LLM生成を問わず順次実行する）
 * @returns {Promise<{ note: string, meta: object, chartData: Array }>}
 */
async function buildWeeklyDraft(startDate, endDate) {
  const data = await gatherWeeklyData(startDate, endDate);
  const meta = buildWeeklyMeta(startDate, endDate);

  const header = [
    `# 📊 AI Capital 週刊号　${meta.week_id}（${startDate}〜${endDate}）`,
    '',
    '*AI社員4部署による、1週間の市場観測と判断のまとめです。*',
    '',
  ].join('\n');

  const sections = [];
  for (const section of WEEKLY_SECTIONS) {
    sections.push(await section.build(data));
  }

  const footer = [
    '',
    '---',
    '*AI Capitalは投資助言サービスではありません。AI社員による意思決定の記録を公開するプロジェクトです。投資判断はご自身の責任でお願いします。*',
  ].join('\n');

  const note = header + sections.join('\n\n') + footer;
  return { note, meta, marketRows: data.market };
}

/**
 * 週刊記事を組み立て、note.comに下書き保存する。
 * @returns {Promise<{ note: string, meta: object, noteUrl: string|null }>}
 */
// 日刊記事はAC番号ごとにサムネイルを動的生成するが、週刊号は固定のこのファイルを常に使う
const WEEKLY_THUMB_PATH = require('path').join(__dirname, '../data/weekly_assets/週刊サムネ.png');

async function publishWeekly(startDate, endDate) {
  const chartGen  = require('../lib/chartGenerator');
  const noteDraft = require('../lib/noteDraft');
  const fs        = require('fs');

  const { note, meta, marketRows } = await buildWeeklyDraft(startDate, endDate);

  let trendChartPath = null;
  try {
    trendChartPath = await chartGen.generateWeeklyTrendChart(marketRows, meta.week_id);
  } catch (e) {
    console.warn(`[weekly] 推移チャート生成失敗: ${e.message}`);
  }

  // 週刊は▼HISTORY▼（推移チャート）1枚のみが仕様（円グラフに相当する▼CHART▼は使わない）
  const graphsGenerated = trendChartPath ? 1 : 0;
  console.log(`[weekly] Graphs Generated : ${graphsGenerated} / 1`);

  let cleaned  = cleanupForNote(note);
  const thumbPath = fs.existsSync(WEEKLY_THUMB_PATH) ? WEEKLY_THUMB_PATH : null;
  if (!thumbPath) console.warn(`[weekly] 週刊サムネイルが見つかりません: ${WEEKLY_THUMB_PATH}`);

  // 見出し検出に依存しない保険挿入（日刊publisher.jsと同じ最終防衛ライン）
  if (!cleaned.includes('▼HISTORY▼')) {
    console.warn('[weekly] ▼HISTORY▼ が本文に存在しないため末尾に保険挿入します');
    cleaned += '\n\n▼HISTORY▼\n';
  }

  let noteUrl = null;
  let graphsEmbedded = 0;
  try {
    const result = await noteDraft.saveDraft({ body: cleaned, historyChartPath: trendChartPath, thumbPath });
    noteUrl = result.url;
    graphsEmbedded = result.historyEmbedded ? 1 : 0;
    console.log(`[weekly] Graphs Embedded : ${graphsEmbedded} / 1`);
    if (graphsEmbedded < 1) {
      console.error(`[weekly] 推移チャートが記事へ埋め込まれませんでした（要確認）: ${noteUrl}`);
    }
  } catch (e) {
    console.error(`[weekly] note.com 下書き保存失敗: ${e.message}`);
  }

  return {
    note: cleaned, meta, noteUrl,
    chartsIncomplete: graphsEmbedded < 1,
    graphsGenerated, graphsEmbedded,
  };
}

module.exports = {
  weekId,
  buildWeeklyMeta,
  gatherWeeklyData,
  buildWeeklyDraft,
  publishWeekly,
  cleanupForNote,
  WEEKLY_SECTIONS,
};
