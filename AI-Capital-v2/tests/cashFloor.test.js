'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const cf = require('../config/cashFloor');

// 既定値前提: SOFT=20 / HARD=10 / CRASH=5 / MIN_ORDER_AMOUNT=1000
// CRASH_FG_MAX=25 / CRASH_NASDAQ_DROP_PCT=-3.0

// ── C1: resolveBuyBudget — フロア上・境界 ─────────────────────
test('C1.1 現金比率25%（SOFT超）→ baseAmount 素通し', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 25, baseAmount: 50000 });
  assert.equal(r.amount, 50000);
  assert.equal(r.factor, 1);
  assert.equal(r.note, '');
});

test('C1.2 現金比率20%ちょうど（SOFT境界・以上）→ 素通し', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 20, baseAmount: 50000 });
  assert.equal(r.amount, 50000);
});

test('C1.3 現金比率19.99%（SOFT直下）→ わずかに逓減', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 19.99, baseAmount: 50000 });
  // factor = (19.99-10)/(20-10) = 0.999 → floor(49950/1000)*1000 = 49000
  assert.equal(r.amount, 49000);
});

// ── C2: resolveBuyBudget — 逓減帯（HARD<cr<SOFT）─────────────
test('C2.1 現金比率15% / base5万 → factor0.5 → 2.5万', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 15, baseAmount: 50000 });
  assert.equal(r.amount, 25000);
  assert.equal(r.factor, 0.5);
});

test('C2.2 現金比率15% / base4000 → 2000（MIN以上で残る）', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 15, baseAmount: 4000 });
  assert.equal(r.amount, 2000);
});

test('C2.3 現金比率15% / base1500 → 750 < MIN → 0（factorは保持）', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 15, baseAmount: 1500 });
  assert.equal(r.amount, 0);
  assert.ok(r.factor > 0, 'factorはログ用に残す');
  assert.match(r.note, /下限未満/);
});

// ── C3: resolveBuyBudget — フロア下（通常時）─────────────────
test('C3.1 現金比率10%ちょうど（HARD境界・以下）→ 0', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 10, baseAmount: 50000 });
  assert.equal(r.amount, 0);
  assert.equal(r.factor, 0);
  assert.match(r.note, /下限10%以下/);
});

test('C3.2 現金比率8% / crashSignalなし → 0', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 8, baseAmount: 50000, crashSignal: false });
  assert.equal(r.amount, 0);
});

// ── C4: resolveBuyBudget — 暴落例外 ─────────────────────────
test('C4.1 現金比率8% + crashSignal（floor→5）→ factor0.2 → 1万', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 8, baseAmount: 50000, crashSignal: true });
  // factor = (8-5)/(20-5) = 0.2 → 10000
  assert.equal(r.amount, 10000);
  assert.equal(r.floorPct, 5);
});

test('C4.2 現金比率5%ちょうど + crashSignal（CRASH境界・以下）→ 0', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 5, baseAmount: 50000, crashSignal: true });
  assert.equal(r.amount, 0);
});

test('C4.3 現金比率12% + crashSignal → 通常HARD帯と同じ扱い（floor=5なのでfactorは緩む）', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 12, baseAmount: 50000, crashSignal: true });
  // factor = (12-5)/(20-5) = 0.4667 → floor(23333/1000)*1000 = 23000
  assert.equal(r.amount, 23000);
});

// ── C5: resolveBuyBudget — 異常系・キャップ ─────────────────
test('C5.1 現金比率が数値化不可 → baseAmount 素通し（既存挙動維持）', () => {
  assert.equal(cf.resolveBuyBudget({ cashRatioPct: '',   baseAmount: 50000 }).amount, 50000);
  assert.equal(cf.resolveBuyBudget({ cashRatioPct: null, baseAmount: 50000 }).amount, 50000);
  assert.equal(cf.resolveBuyBudget({ cashRatioPct: NaN,  baseAmount: 50000 }).amount, 50000);
});

test('C5.2 逓減後の額が現金残高を超える場合は残高にクランプ', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 15, baseAmount: 50000, cashJpy: 12000 });
  // 通常なら25000だが cashJpy=12000 でクランプ
  assert.equal(r.amount, 12000);
});

test('C5.3 残高クランプで MIN 未満になったら 0', () => {
  const r = cf.resolveBuyBudget({ cashRatioPct: 15, baseAmount: 50000, cashJpy: 800 });
  assert.equal(r.amount, 0);
});

test('C5.4 baseAmount=0 → 0', () => {
  assert.equal(cf.resolveBuyBudget({ cashRatioPct: 15, baseAmount: 0 }).amount, 0);
});

// ── C6: isCrashSignal ───────────────────────────────────────
test('C6.1 Fear&Greed=25（境界・以下）→ true', () => {
  assert.equal(cf.isCrashSignal({ fearGreed: 25 }), true);
});

test('C6.2 Fear&Greed=26 → false', () => {
  assert.equal(cf.isCrashSignal({ fearGreed: 26 }), false);
});

test('C6.3 NASDAQ前日比 -3.0（境界・以下）→ true', () => {
  assert.equal(cf.isCrashSignal({ nasdaqChangePct: -3.0 }), true);
});

test('C6.4 NASDAQ前日比 -2.9 → false', () => {
  assert.equal(cf.isCrashSignal({ nasdaqChangePct: -2.9 }), false);
});

test('C6.5 両方未指定 → false', () => {
  assert.equal(cf.isCrashSignal({}), false);
  assert.equal(cf.isCrashSignal(), false);
});

test('C6.6 片方が数値化不可でも、もう片方が条件を満たせば true', () => {
  assert.equal(cf.isCrashSignal({ fearGreed: 'n/a', nasdaqChangePct: -5 }), true);
});

// ── C7: config パラメータ（ハードコード無し） ───────────────
test('C7.1 パラメータが config に数値で存在し、既定値が仕様どおり', () => {
  for (const k of ['CASH_FLOOR_SOFT_PCT', 'CASH_FLOOR_HARD_PCT', 'CASH_FLOOR_CRASH_PCT',
    'CRASH_FG_MAX', 'CRASH_NASDAQ_DROP_PCT', 'MIN_ORDER_AMOUNT']) {
    assert.equal(typeof cf[k], 'number', `${k} が数値`);
  }
  assert.equal(cf.CASH_FLOOR_SOFT_PCT, 20);
  assert.equal(cf.CASH_FLOOR_HARD_PCT, 10);
  assert.equal(cf.CASH_FLOOR_CRASH_PCT, 5);
  assert.equal(cf.CRASH_FG_MAX, 25);
  assert.equal(cf.CRASH_NASDAQ_DROP_PCT, -3.0);
  assert.equal(cf.MIN_ORDER_AMOUNT, 1000);
});

// ── C8: 単調性（回帰防止）─────────────────────────────────
test('C8.1 現金比率が下がるほど買付額は単調に減る（10〜20%）', () => {
  let prev = Infinity;
  for (let cr = 20; cr >= 10; cr -= 0.5) {
    const amt = cf.resolveBuyBudget({ cashRatioPct: cr, baseAmount: 50000 }).amount;
    assert.ok(amt <= prev, `cr=${cr}: ${amt} <= ${prev}`);
    prev = amt;
  }
});
