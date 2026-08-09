'use strict';

/**
 * editorReview.js — AI編集長による公開前最終レビュー（Phase4）
 *
 * Validator・Auto Fix・品質改善ループ（機械修正/LLM再生成）を通過し
 * quality_scoreが95点以上に達した記事に対して、最後に1回だけ実施する
 * 定性レビュー。ここでの判定は公開可否の最終ゲートになる。
 *
 * 設計方針:
 *   - LLM呼び出しは1回のみ（記事全文の再生成ではなく短い評価文を出力させるため
 *     num_predictを小さく抑え、品質改善ループより高速に完結させる）。
 *   - 出力パースに失敗した場合は「公開して問題ありません」とは解釈しない
 *     （fail-closed。安全側に倒し、REJECTEDとして扱う）。
 */

const CATEGORY_LABELS = {
  investmentLogic: '投資ロジック',
  numericConsistency: '数値整合性',
  departmentPersona: '部署人格',
  japaneseQuality: '日本語品質',
  layout: 'レイアウト',
  structure: '記事構成',
  readability: '読みやすさ',
  timeHorizonConsistency: '時間軸整合性',
};

const EDITOR_SYSTEM = `あなたはAI Capitalの編集長です。公開直前の記事を最終レビューしてください。

以下の8項目を、それぞれ100点満点で採点してください（各項目1行、ラベルの直後に数字のみを書くこと）。
投資ロジック：
数値整合性：
部署人格：
日本語品質：
レイアウト：
記事構成：
読みやすさ：
時間軸整合性：

続けて、100文字以内で総評を1文で書いてください。
総評：（ここに書く）

最後に、公開判定を必ず次のいずれか1行だけで出力してください（他の文言と混在させないこと）。
公開判定：公開して問題ありません
公開判定：公開を推奨しません

「公開を推奨しません」と判定した場合のみ、続けて理由を最大3件、箇条書きで書いてください。
理由：
・（理由1）
・（理由2）
・（理由3）

【評価にあたっての注意】
・機械的なレイアウト崩れやValidatorが検出する整合性エラーは既に別工程でチェック済みのため、
  ここでは主に「読み物としての質」「投資ロジックの説得力」「部署ごとの人格が保たれているか」
  「日本語として自然か」を重視すること。
・些細な言い回しの好みだけで公開を止めない。公開を推奨しないのは、投資判断の根拠が破綻している、
  部署の人格が別部署と混同されている、日本語が意味不明である等、読者に実害・誤解を与えうる場合のみ。

【時間軸整合性の採点基準（読者フィードバックより・重要・2026-08-09改訂）】
評価するのは「根拠→時間軸→判断」の一貫性であり、期間の厳密さや単語の有無ではない。

やってはいけないこと（過剰な厳格化・禁止）：
・「3ヶ月」「6ヶ月」「1年」のような具体的な期間の明記を要求しないこと。「短期的な」
  「中長期的な」「長期的な」という相対的な表現で十分であり、これだけを理由に減点しない。
・部署ごとに時間軸の重心が異なること（例：マーケット分析部は短期、リスク管理部やポートフォリオ
  管理部は中長期）はAI Capitalの部署対立構造として正常であり、それ自体を「矛盾」「論理の飛躍」
  として扱わないこと。異なる部署が異なる時間軸で異なる結論を主張するのは想定通りの設計であり、
  意見が割れること自体を減点対象にしないこと。
  【重要】この禁止事項は「矛盾」「論理の飛躍」という言葉を使った場合だけでなく、「時間軸の記述が
  部署間で混在している」「トーンを統一すべき」「一貫した時間軸でまとめる必要がある」のように、
  言い換えて同じ内容を指摘する場合も含む。部署間で時間軸が異なること自体を理由に公開見送りの
  理由に挙げないこと。
・「短期的には様子見が妥当だが中長期的には積み増しを検討する」のように、1つの部署が複数の時間軸に
  言及すること自体は正常な記述であり、それだけで減点しないこと（最終判断と整合していれば問題ない）。

減点・公開見送りの対象とすべき「真の矛盾」（このいずれかに該当する場合のみ）：
・ある部署が、直近の値動き（前日比・VIX・Fear&Greed等）のみを根拠に挙げているのに、
  その根拠と矛盾する時間軸（例：「長期的な資産形成を最優先」）を結論として書いている場合。
・秘書室長所見や最終判断の解説が「安定性を最優先した」「守りを優先した」等の守り重視の説明を
  しているにもかかわらず、実際に採用された銘柄が成長株・テーマ株（例：Zテック20）のような
  攻めの資産である場合（逆に「成長性を最優先した」と書きながら実際はゴールド等の守りの資産を
  採用した場合も同様）。
・時間軸の記述が、その部署自身が同じ段落内で挙げた数値根拠と明白に矛盾している場合。
上記に該当しない限り、時間軸表現が多少曖昧・簡潔であっても減点を最小限に留め、公開見送りの
理由にはしないこと。`;

function parseScore(text, label) {
  const re = new RegExp(`${label}[：:]\\s*(\\d{1,3})`);
  const m = text.match(re);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return (v >= 0 && v <= 100) ? v : null;
}

/**
 * @param {string} rawReview - LLM出力
 * @returns {{ scores: object, editorScore: number|null, verdict: 'APPROVED'|'REJECTED'|'UNPARSEABLE', comment: string, reasons: string[] }}
 */
function parseEditorReview(rawReview) {
  const scores = {};
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    scores[key] = parseScore(rawReview, label);
  }
  const parsedScores = Object.values(scores).filter(v => v != null);
  const editorScore = parsedScores.length > 0
    ? Math.round(parsedScores.reduce((a, b) => a + b, 0) / parsedScores.length)
    : null;

  const commentMatch = rawReview.match(/総評[：:]\s*(.+)/);
  const comment = commentMatch ? commentMatch[1].trim().slice(0, 200) : '';

  const verdictMatch = rawReview.match(/公開判定[：:]\s*(公開して問題ありません|公開を推奨しません)/);
  let verdict;
  if (!verdictMatch) {
    verdict = 'UNPARSEABLE'; // fail-closed: パース不能は公開しない
  } else {
    verdict = verdictMatch[1] === '公開して問題ありません' ? 'APPROVED' : 'REJECTED';
  }

  let reasons = [];
  if (verdict === 'REJECTED') {
    const reasonBlockMatch = rawReview.match(/理由[：:]\s*([\s\S]*)/);
    if (reasonBlockMatch) {
      reasons = reasonBlockMatch[1]
        .split('\n')
        .map(l => l.replace(/^[・\-\*]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 3);
    }
  }

  return { scores, editorScore, verdict, comment, reasons };
}

/**
 * @param {string} note - 公開直前の記事全文
 * @param {(system: string, user: string, opts?: object) => Promise<string>} askFn - lib/ollama.ask 互換関数
 * @returns {Promise<{ scores: object, editorScore: number|null, verdict: string, comment: string, reasons: string[], raw: string }>}
 */
async function runEditorReview(note, askFn) {
  let raw;
  try {
    raw = await askFn(EDITOR_SYSTEM, note, { num_predict: 700, num_ctx: 16384, temperature: 0.2 });
  } catch (err) {
    // LLM呼び出し自体が失敗した場合もfail-closedでREJECTED相当として扱う
    return {
      scores: {}, editorScore: null, verdict: 'UNPARSEABLE',
      comment: `編集長レビュー呼び出し失敗: ${err.message}`, reasons: [], raw: '',
    };
  }
  return { ...parseEditorReview(raw), raw };
}

module.exports = { runEditorReview, parseEditorReview, CATEGORY_LABELS };
