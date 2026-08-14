'use strict';

/**
 * weeklyQualityScorer.js — 週刊記事品質の数値スコア化（0〜100点）
 *
 * lib/weeklyArticleValidator.js の warnings（"Rule W\d+" 付き）を4カテゴリに分類し、
 * 警告1件につき固定減点する純粋関数。LLM呼び出しは行わない。
 * 日刊の lib/qualityScorer.js の RULE_CATEGORY（数字のみのRule番号）とは名前空間が
 * 完全に分離しており、互いのスコア計算に影響しない。
 *
 * カテゴリ:
 *   facts      - 投資回数/WAIT回数/総投資額/前週比/市場平均などの事実整合性（W01〜W06）
 *   narrative  - 勝者反省点/論争/学習成長/最上級表現の根拠性（W07,W08,W15,W16）
 *   layout     - 引用/Markdown残留/重複（W09〜W11）
 *   graphs     - グラフ生成・埋め込み（W12〜W14）
 */

const DEDUCTION_PER_WARNING = 8;
const VALIDATOR_DEDUCTION_PER_WARNING = 10;

const RULE_CATEGORY_W = {
  1: 'facts', 2: 'facts', 3: 'facts', 4: 'facts', 5: 'facts', 6: 'facts',
  7: 'narrative', 8: 'narrative',
  9: 'layout', 10: 'layout', 11: 'layout',
  12: 'graphs', 13: 'graphs', 14: 'graphs',
  15: 'narrative', 16: 'narrative',
};

function ruleNumOf(warning) {
  const m = warning.match(/Rule W(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * @param {{ ok: boolean, warnings: string[] }} validation - validateWeeklyArticle() の返り値
 * @returns {{ facts:number, narrative:number, layout:number, graphs:number, validator:number, total:number, warningCount:number }}
 */
function scoreWeeklyArticle(validation) {
  const warnings = validation?.warnings ?? [];

  const deductions = { facts: 0, narrative: 0, layout: 0, graphs: 0 };
  for (const w of warnings) {
    const ruleNum = ruleNumOf(w);
    const category = RULE_CATEGORY_W[ruleNum];
    if (category) deductions[category] += DEDUCTION_PER_WARNING;
  }

  const facts     = Math.max(0, 100 - deductions.facts);
  const narrative = Math.max(0, 100 - deductions.narrative);
  const layout    = Math.max(0, 100 - deductions.layout);
  const graphs    = Math.max(0, 100 - deductions.graphs);
  const validator = warnings.length === 0
    ? 100
    : Math.max(0, 100 - VALIDATOR_DEDUCTION_PER_WARNING * warnings.length);

  const total = Math.round((facts + narrative + layout + graphs + validator) / 5);

  return { facts, narrative, layout, graphs, validator, total, warningCount: warnings.length };
}

const PUBLISH_SCORE_THRESHOLD_WEEKLY = 95;

/**
 * AI編集長レビュー（lib/editorReview.js・日刊と共通利用）のeditorScoreを合算する。
 * @param {ReturnType<typeof scoreWeeklyArticle>} score
 * @param {number} editorScore
 */
function withEditorScoreWeekly(score, editorScore) {
  const editor = Math.max(0, Math.min(100, Math.round(editorScore)));
  const total  = Math.round((score.facts + score.narrative + score.layout + score.graphs + score.validator + editor) / 6);
  return { ...score, editor, total };
}

module.exports = {
  scoreWeeklyArticle,
  withEditorScoreWeekly,
  RULE_CATEGORY_W,
  DEDUCTION_PER_WARNING,
  PUBLISH_SCORE_THRESHOLD_WEEKLY,
};
