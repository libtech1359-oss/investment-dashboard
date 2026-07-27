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
};

const EDITOR_SYSTEM = `あなたはAI Capitalの編集長です。公開直前の記事を最終レビューしてください。

以下の7項目を、それぞれ100点満点で採点してください（各項目1行、ラベルの直後に数字のみを書くこと）。
投資ロジック：
数値整合性：
部署人格：
日本語品質：
レイアウト：
記事構成：
読みやすさ：

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
  部署の人格が別部署と混同されている、日本語が意味不明である等、読者に実害・誤解を与えうる場合のみ。`;

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
