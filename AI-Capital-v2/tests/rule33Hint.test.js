'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildRule33DataHint } = require('../agents/publisher');

// 2026-08-14に実際に発生したインシデントの実データを再現
const RECS = [
  { department: 'マーケット分析部',     recommendation_type: 'ACCUMULATE', asset_name: 'FANG+',   amount: 450000 },
  { department: 'リスク管理部',         recommendation_type: 'WAIT',       asset_name: 'なし',    amount: 0 },
  { department: 'ポートフォリオ管理部', recommendation_type: 'ACCUMULATE', asset_name: 'S&P500',  amount: 156000 },
  { department: '審査部',               recommendation_type: 'ACCUMULATE', asset_name: 'S&P500',  amount: 300000 },
];
const DECISION = { target_asset: 'S&P500', amount: 228000 };

test('buildRule33DataHint: 各部署の実データ（銘柄・金額・見送り）を正確に反映する', () => {
  const hint = buildRule33DataHint(RECS, DECISION);

  assert.match(hint, /神谷シン（マーケット分析部）: FANG\+ ¥450,000を推奨/);
  assert.match(hint, /黒崎ミサキ（リスク管理部）: 見送りを推奨/);
  assert.match(hint, /橘アオイ（ポートフォリオ管理部）: S&P500 ¥156,000を推奨/);
  assert.match(hint, /鬼塚ガイ（審査部）: S&P500 ¥300,000を推奨/);
  assert.match(hint, /最終判断: S&P500 ¥228,000（採用）/);
});

test('buildRule33DataHint: 推測・創作の禁止を明示する', () => {
  const hint = buildRule33DataHint(RECS, DECISION);
  assert.match(hint, /推測・創作禁止/);
  assert.match(hint, /上記に記載のない理由・数値を創作してはならない/);
});

test('buildRule33DataHint: decision未確定でも例外を投げない', () => {
  assert.doesNotThrow(() => buildRule33DataHint(RECS, null));
  assert.doesNotThrow(() => buildRule33DataHint([], null));
});
