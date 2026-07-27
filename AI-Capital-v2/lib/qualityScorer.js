'use strict';

/**
 * qualityScorer.js — 記事品質の数値スコア化（0〜100点）
 *
 * articleValidator.js の warnings（Rule番号付き）を5カテゴリに分類し、
 * 警告1件につき固定減点する純粋関数。LLM呼び出しは行わない。
 *
 * カテゴリ:
 *   layout     - 見出し/箇条書き/重複掲載/Markdown残留など構造面
 *   japanese   - 内部シグナル英語残留/意味の重複/句読点不足など日本語品質
 *   logic      - データ整合性・単一根拠・誇張表現・最終判断とのトーン矛盾
 *   department - 部署人格・禁止表現・網羅性など部署整合性
 *   validator  - 警告総数から見た総合監査結果（他カテゴリと独立の全体指標）
 *   total      - 上記5カテゴリの単純平均
 */

const DEDUCTION_PER_WARNING = 8;
const VALIDATOR_DEDUCTION_PER_WARNING = 10;

const RULE_CATEGORY = {
  1: 'logic', 2: 'logic', 3: 'logic', 4: 'logic', 5: 'logic', 6: 'logic', 7: 'logic',
  8: 'layout', 9: 'layout', 10: 'layout',
  12: 'department',
  13: 'logic', 14: 'logic',
  15: 'department',
  16: 'japanese',
  17: 'department', 18: 'layout', 19: 'department', 20: 'department', 21: 'department', 22: 'department',
  23: 'logic', 24: 'logic', 25: 'logic',
  26: 'layout', 27: 'japanese', 28: 'japanese', 29: 'japanese', 30: 'layout', 31: 'layout',
};

function ruleNumOf(warning) {
  const m = warning.match(/Rule (\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * @param {{ ok: boolean, warnings: string[] }} validation - validateArticle() の返り値
 * @param {number} [regenerationCount] - 再生成が行われた回数（ログ用・スコアには影響しない）
 * @returns {{ layout:number, japanese:number, logic:number, department:number, validator:number, total:number, warningCount:number }}
 */
function scoreArticle(validation, regenerationCount = 0) {
  const warnings = validation?.warnings ?? [];

  const deductions = { layout: 0, japanese: 0, logic: 0, department: 0 };
  for (const w of warnings) {
    const ruleNum = ruleNumOf(w);
    const category = RULE_CATEGORY[ruleNum];
    if (category) deductions[category] += DEDUCTION_PER_WARNING;
  }

  const layout     = Math.max(0, 100 - deductions.layout);
  const japanese   = Math.max(0, 100 - deductions.japanese);
  const logic      = Math.max(0, 100 - deductions.logic);
  const department = Math.max(0, 100 - deductions.department);
  const validator   = warnings.length === 0
    ? 100
    : Math.max(0, 100 - VALIDATOR_DEDUCTION_PER_WARNING * warnings.length);

  const total = Math.round((layout + japanese + logic + department + validator) / 5);

  return {
    layout, japanese, logic, department, validator, total,
    warningCount: warnings.length,
    regenerationCount,
  };
}

const PUBLISH_SCORE_THRESHOLD = 95;

/**
 * AI編集長レビュー（Phase4）の editorScore を合算し、totalを6カテゴリ平均で再計算する。
 * 機械採点（layout/japanese/logic/department/validator）は既に確定済みの値をそのまま使う。
 *
 * @param {ReturnType<typeof scoreArticle>} score
 * @param {number} editorScore - 0〜100
 * @returns {ReturnType<typeof scoreArticle> & { editor: number }}
 */
function withEditorScore(score, editorScore) {
  const editor = Math.max(0, Math.min(100, Math.round(editorScore)));
  const total  = Math.round((score.layout + score.japanese + score.logic + score.department + score.validator + editor) / 6);
  return { ...score, editor, total };
}

module.exports = { scoreArticle, withEditorScore, RULE_CATEGORY, DEDUCTION_PER_WARNING, PUBLISH_SCORE_THRESHOLD };
