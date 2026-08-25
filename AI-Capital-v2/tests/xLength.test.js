'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { enforceXLength, checkXLength } = require('../lib/xLength');

// X_SYSTEMの固定構成に沿った典型的な生成結果（①見出し／②2択／③部署コメント／④締め／⑤フッター）。
// 2026-08-25の実インシデント: 旧実装が1文字ずつ末尾をpopしていたため
// 「🛡️ 全資産への分散を」のように2択の片側が行の途中で切れた投稿文が公開候補になっていた。
const LONG_POST = [
  '📊 AI Capital 市場会議',
  '',
  '会議が最も白熱したテーマは──',
  '📈 勢いある指数に資金を集中させるか',
  '🛡️ 全資産への分散を優先するか',
  '',
  '📈 マーケット分析部',
  '「NASDAQ100の押し目を狙う」',
  '',
  '🛡️ リスク管理部',
  '「集中リスクが高まっている」',
  '',
  'AI社員たちの結論は？',
  '',
  '続きはnoteで👇',
  'https://note.com/aicapital_jp/n/nad4756177929',
  '#AI投資記録',
].join('\n');

test('enforceXLength: トリム後の全行が元テキストに存在する（行途中で切らない）', () => {
  const out = enforceXLength(LONG_POST);
  const outLines = out.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of outLines) {
    assert.ok(LONG_POST.includes(line), `行が途中で切られている: ${line}`);
  }
});

test('enforceXLength: トリム結果がX制限内に収まる', () => {
  const out = enforceXLength(LONG_POST);
  assert.ok(checkXLength(out).valid, 'トリム後は制限内であるべき');
});

test('enforceXLength: 固定フッター（URL・ハッシュタグ）は必ず残す', () => {
  const out = enforceXLength(LONG_POST);
  assert.ok(out.includes('https://note.com/aicapital_jp/n/nad4756177929'), 'note URLが残るべき');
  assert.ok(out.includes('#AI投資記録'), 'ハッシュタグが残るべき');
});

test('enforceXLength: 2択の対立軸は片側だけ残さない（両方残すか両方落とす）', () => {
  const out = enforceXLength(LONG_POST);
  const hasA = out.includes('勢いある指数に資金を集中させるか');
  const hasB = out.includes('全資産への分散を優先するか');
  assert.equal(hasA, hasB, '2択は片側だけが残ってはならない');
});

test('enforceXLength: 中身のない「見出し＋URLだけ」にはしない（2択を見出しより優先して残す）', () => {
  const out = enforceXLength(LONG_POST);
  assert.ok(out.includes('全資産への分散を優先するか'),
    '2択ブロックが入る余地があるなら、固定見出しより2択を優先して残すべき');
});

test('enforceXLength: 元から制限内なら一切変更しない', () => {
  const short = [
    '📊 AI Capital 市場会議',
    '',
    '続きはnoteで👇',
    'https://note.com/aicapital_jp/n/nad4756177929',
    '#AI投資記録',
  ].join('\n');
  assert.ok(checkXLength(short).valid, '前提: この短文は制限内であること');
  assert.equal(enforceXLength(short), short, '制限内のテキストは変更されないべき');
});

test('enforceXLength: フッターマーカーがなければ生成結果をそのまま返す（誤って壊さない）', () => {
  const noFooter = 'あ'.repeat(300);
  assert.equal(enforceXLength(noFooter), noFooter);
});
