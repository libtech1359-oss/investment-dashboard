'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { validateArticle } = require('../lib/articleValidator');

function hasRule(warnings, ruleNum) {
  return warnings.some(w => new RegExp(`Rule ${ruleNum}\\b`).test(w));
}

test('Rule28: 20文字以上・句点で終わる文が記事内に重複していると検出する', () => {
  const dupSentence = 'これはテスト用の重複文であり二十文字以上の長さを持つ文章です。';
  const note = [
    '🌍 今日の市場',
    dupSentence,
    'その他の本文です。',
    '',
    '👑 秘書室長所見',
    dupSentence,
  ].join('\n');

  const result = validateArticle({
    note, pf: null, candidates: [], decisions: [], recs: [], articleNum: 'AC-TEST-0001', date: '2026-08-14',
  });
  assert.ok(hasRule(result.warnings, 28), 'Rule28警告が検出されるべき');
});

test('Rule28: 重複がなければ検出しない', () => {
  const note = [
    '🌍 今日の市場',
    'これはユニークな文です。',
    '👑 秘書室長所見',
    'これは別のユニークな文です。',
  ].join('\n');

  const result = validateArticle({
    note, pf: null, candidates: [], decisions: [], recs: [], articleNum: 'AC-TEST-0002', date: '2026-08-14',
  });
  assert.ok(!hasRule(result.warnings, 28), 'Rule28警告は検出されないべき');
});

// ── Rule33: 審査部の否定評価と結論の論理橋渡し ──────────────────────────
const GAI_BODY_NO_BRIDGE =
  '🧐 審査部（鬼塚ガイ）\n' +
  '判断：観測ポジション構築推奨\n' +
  '信頼度：75%\n' +
  '要約：\n' +
  '神谷の主張は根拠不足であり、市場環境の変化を過度に織り込んでいると判断します。' +
  '黒崎のリスク指摘は妥当ですが、単なる様子見に留まるのは機会損失につながります。' +
  'アオイの金額案は算出根拠が明確であり成立していますが、推奨銘柄の選択に偏りが見られます。' +
  '総合的に見て、Core候補を軸とした慎重な積み増しが最も合理的です。\n' +
  '\n⚖️ 最終判断\n本文\n';

const GAI_BODY_WITH_BRIDGE =
  '🧐 審査部（鬼塚ガイ）\n' +
  '判断：観測ポジション構築推奨\n' +
  '信頼度：75%\n' +
  '要約：\n' +
  '神谷の主張は根拠不足であり、市場環境の変化を過度に織り込んでいると判断します。' +
  'ただし黒崎の慎重論を踏まえ、縮小した金額であれば実害は小さいと判断します。' +
  'アオイの金額案は算出根拠が明確であり成立しています。' +
  '総合的に見て、縮小した金額での観測ポジション構築を支持します。\n' +
  '\n⚖️ 最終判断\n本文\n';

test('Rule33: 否定的評価の後に橋渡しなく結論を支持していると検出する', () => {
  const result = validateArticle({
    note: GAI_BODY_NO_BRIDGE, pf: null, candidates: [], decisions: [], recs: [], articleNum: 'AC-TEST-0003', date: '2026-08-14',
  });
  assert.ok(hasRule(result.warnings, 33), 'Rule33警告が検出されるべき');
});

test('Rule33: 「ただし」等の橋渡しがあれば検出しない', () => {
  const result = validateArticle({
    note: GAI_BODY_WITH_BRIDGE, pf: null, candidates: [], decisions: [], recs: [], articleNum: 'AC-TEST-0004', date: '2026-08-14',
  });
  assert.ok(!hasRule(result.warnings, 33), 'Rule33警告は検出されないべき');
});
