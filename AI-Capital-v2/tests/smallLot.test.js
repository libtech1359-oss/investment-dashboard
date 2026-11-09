'use strict';

/**
 * smallLot.test.js — 小口買付（2026-11-06 確定仕様）の純粋関数テスト
 *   config/cashFloor.js の resolvePortfolioVote / resolveSmallLotAmount
 *
 * 既定値前提: SOFT=20 / HARD=10 / CRASH=5 / MIN_ORDER_AMOUNT=1000
 *   小口: 通常¥10,000 / 強根拠¥30,000 / 暴落時の下限帯(5〜10%)¥10,000固定
 *   アオイの買い票: F&G<=30 かつ 他3部署の買い票>=2（現金比率 下限〜20% の間のみ）
 *   強根拠: 実効スコア>=0.75 かつ 採用銘柄のRule Engineスコア(0-100)>=20
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const cf = require('../config/cashFloor');

// ── resolvePortfolioVote（アオイの実効票）──────────────────────
const vote = (over) => cf.resolvePortfolioVote({ signal: 'ACCUMULATE', cashRatioPct: 15, fearGreed: 28, otherBuyVotes: 2, ...over });

test('SL-V1 現金比率20%以上 → 従来ルール（買い票はそのまま）', () => {
  const r = vote({ cashRatioPct: 20, fearGreed: 60, otherBuyVotes: 0 });
  assert.equal(r.signal, 'ACCUMULATE');
  assert.equal(r.downgraded, false);
});

test('SL-V2 現金15% F&G=30（境界・以下）かつ他2票 → 買い票有効', () => {
  const r = vote({ fearGreed: 30 });
  assert.equal(r.signal, 'ACCUMULATE');
  assert.equal(r.downgraded, false);
});

test('SL-V3 現金15% F&G=31 → WAIT扱い', () => {
  const r = vote({ fearGreed: 31 });
  assert.equal(r.signal, 'WAIT');
  assert.equal(r.downgraded, true);
  assert.match(r.note, /小口買付条件/);
});

test('SL-V4 現金15% F&G=28 だが他部署の買い票が1票 → WAIT扱い', () => {
  assert.equal(vote({ otherBuyVotes: 1 }).signal, 'WAIT');
  assert.equal(vote({ otherBuyVotes: 0 }).signal, 'WAIT');
});

test('SL-V5 他3部署の買い票が3票でも条件を満たす（2票以上）', () => {
  assert.equal(vote({ otherBuyVotes: 3 }).signal, 'ACCUMULATE');
});

test('SL-V6 現金10%ちょうど（通常時の下限・以下）→ WAIT扱い（原則WAIT）', () => {
  const r = vote({ cashRatioPct: 10 });
  assert.equal(r.signal, 'WAIT');
  assert.equal(r.downgraded, true);
});

test('SL-V7 現金9%・暴落なし → WAIT扱い', () => {
  assert.equal(vote({ cashRatioPct: 9 }).signal, 'WAIT');
});

test('SL-V8 暴落時: 現金8%（5〜10%帯）でも同じ条件を満たせば有効（既存の暴落特別ルールを維持）', () => {
  const r = vote({ cashRatioPct: 8, crashSignal: true, fearGreed: 22 });
  assert.equal(r.signal, 'ACCUMULATE');
  assert.equal(r.downgraded, false);
});

test('SL-V9 暴落時でも現金5%以下 → WAIT扱い', () => {
  assert.equal(vote({ cashRatioPct: 5, crashSignal: true, fearGreed: 18 }).signal, 'WAIT');
});

test('SL-V10 買い票以外（WAIT/DEFEND）は触らない', () => {
  assert.equal(vote({ signal: 'WAIT' }).downgraded, false);
  assert.equal(vote({ signal: 'DEFEND' }).signal, 'DEFEND');
});

test('SL-V11 現金比率が数値化できない → 票を触らない（既存挙動）', () => {
  const r = vote({ cashRatioPct: '', fearGreed: 60, otherBuyVotes: 0 });
  assert.equal(r.signal, 'ACCUMULATE');
  assert.equal(r.downgraded, false);
});

test('SL-V12 帯の中でF&Gが数値化できない → 安全側でWAIT扱い', () => {
  assert.equal(vote({ fearGreed: undefined }).signal, 'WAIT');
});

test('SL-V13 BUY票も同じ扱い', () => {
  assert.equal(vote({ signal: 'BUY' }).signal, 'BUY');
  assert.equal(vote({ signal: 'BUY', fearGreed: 45 }).signal, 'WAIT');
});

// ── resolveSmallLotAmount（小口キャップ）──────────────────────
const lot = (over) => cf.resolveSmallLotAmount({ cashRatioPct: 15, cashJpy: 1_700_000, amount: 350000, voteScore: 0.5, ruleScore: 10, ...over });

test('SL-A1 現金20%以上 → キャップなし（金額そのまま）', () => {
  const r = lot({ cashRatioPct: 20 });
  assert.equal(r.amount, 350000);
  assert.equal(r.applied, false);
});

test('SL-A2 現金15%・通常（強根拠でない）→ ¥10,000', () => {
  const r = lot({});
  assert.equal(r.amount, 10000);
  assert.equal(r.applied, true);
  assert.equal(r.strong, false);
  assert.match(r.note, /小口買付/);
  assert.match(r.note, /¥10,000/);
});

test('SL-A3 強根拠（実効スコア0.75・採用銘柄Rule 20）→ ¥30,000', () => {
  const r = lot({ voteScore: 0.75, ruleScore: 20 });
  assert.equal(r.amount, 30000);
  assert.equal(r.strong, true);
  assert.match(r.note, /根拠が強い/);
});

test('SL-A4 実効スコア0.7499 → 強根拠にならず¥10,000', () => {
  assert.equal(lot({ voteScore: 0.7499, ruleScore: 30 }).amount, 10000);
});

test('SL-A5 採用銘柄のRule Engineスコア19 → 強根拠にならず¥10,000', () => {
  assert.equal(lot({ voteScore: 1.0, ruleScore: 19 }).amount, 10000);
});

test('SL-A6 採用銘柄のRule Engineスコアが不明 → 強根拠にならず¥10,000（安全側）', () => {
  assert.equal(lot({ voteScore: 1.0, ruleScore: undefined }).amount, 10000);
  assert.equal(lot({ voteScore: 1.0, ruleScore: 'abc' }).amount, 10000);
});

test('SL-A7 暴落時の5〜10%帯 → ¥10,000固定（強根拠でも¥30,000にしない）', () => {
  const r = lot({ cashRatioPct: 8, crashSignal: true, voteScore: 1.0, ruleScore: 50 });
  assert.equal(r.amount, 10000);
  assert.equal(r.strong, false);
});

test('SL-A8 暴落時でも現金10%超（10〜20%）なら強根拠は有効', () => {
  const r = lot({ cashRatioPct: 15, crashSignal: true, voteScore: 0.8, ruleScore: 25 });
  assert.equal(r.amount, 30000);
});

test('SL-A9 フロア後の額が上限以下 → そのまま（キャップは変更しない）', () => {
  const r = lot({ amount: 6000 });
  assert.equal(r.amount, 6000);
  assert.equal(r.applied, false);
});

test('SL-A10 部署の推薦額の平均が大きくても上限を超えない', () => {
  assert.equal(lot({ amount: 5_000_000, voteScore: 1.0, ruleScore: 90 }).amount, 30000);
  assert.equal(lot({ amount: 5_000_000 }).amount, 10000);
});

test('SL-A11 現金残高が上限より小さい → 残高を超えない（1,000円単位に切り捨て）', () => {
  assert.equal(lot({ cashJpy: 7_500 }).amount, 7000);
});

test('SL-A12 小口にした結果が最小発注額(¥1,000)未満 → 見送り(0)', () => {
  const r = lot({ amount: 900 });
  assert.equal(r.amount, 0);
  assert.equal(r.applied, true);
});

test('SL-A13 既存の最小発注額¥1,000は変更されていない', () => {
  assert.equal(cf.MIN_ORDER_AMOUNT, 1000);
  assert.equal(lot({ amount: 1000 }).amount, 1000);
});

test('SL-A14 現金比率が下限以下 → 0（現金フロアと同じ最終下限）', () => {
  assert.equal(lot({ cashRatioPct: 10 }).amount, 0);
  assert.equal(lot({ cashRatioPct: 5, crashSignal: true }).amount, 0);
});

test('SL-A15 現金比率が数値化できない → 素通し', () => {
  const r = lot({ cashRatioPct: '' });
  assert.equal(r.amount, 350000);
  assert.equal(r.applied, false);
});

// ── 現金フロア → 小口キャップの順序（フロア後の額に対してキャップ）──
test('SL-O1 現金フロアで先に絞られた額が上限以下なら、その額が最終額になる', () => {
  const floored = cf.resolveBuyBudget({ cashRatioPct: 10.2, baseAmount: 100000 }).amount; // factor≈0.02 → 小額
  assert.ok(floored > 0 && floored < 10000, `前提: フロア後が1万円未満 (実際 ${floored})`);
  const r = cf.resolveSmallLotAmount({ cashRatioPct: 10.2, cashJpy: 1_000_000, amount: floored, voteScore: 0.5, ruleScore: 10 });
  assert.equal(r.amount, floored);
  assert.equal(r.applied, false);
});

test('SL-O2 現金フロアの後でもなお上限を超える額は小口上限に切り詰められる', () => {
  const floored = cf.resolveBuyBudget({ cashRatioPct: 15, baseAmount: 350000 }).amount; // 約¥175,000
  assert.ok(floored > 30000);
  assert.equal(cf.resolveSmallLotAmount({ cashRatioPct: 15, cashJpy: 1_000_000, amount: floored, voteScore: 0.5, ruleScore: 10 }).amount, 10000);
});

test('SL-C 設定値が確定仕様どおり', () => {
  assert.equal(cf.SMALL_LOT_NORMAL_AMOUNT, 10000);
  assert.equal(cf.SMALL_LOT_STRONG_AMOUNT, 30000);
  assert.equal(cf.SMALL_LOT_CRASH_BAND_AMOUNT, 10000);
  assert.equal(cf.SMALL_LOT_AOI_MAX_FEAR_GREED, 30);
  assert.equal(cf.SMALL_LOT_AOI_MIN_OTHER_BUYS, 2);
  assert.equal(cf.SMALL_LOT_STRONG_MIN_VOTE_SCORE, 0.75);
  assert.equal(cf.SMALL_LOT_STRONG_MIN_RULE_SCORE, 20);
  assert.equal(cf.CASH_FLOOR_HARD_PCT, 10);
  assert.equal(cf.CASH_FLOOR_CRASH_PCT, 5);
});

// ── 部署プロンプト用の金額ガイド（smallLotAmountHint）──────────
test('SL-H1 小口帯（10超〜20未満）ではガイド行を返し、小口額と「signal判断は変えない」を含む', () => {
  const h = cf.smallLotAmountHint(16);
  assert.match(h, /現金比率16%/);
  assert.match(h, /¥10,000/);
  assert.match(h, /signal.*変えない/);
});

test('SL-H2 帯の外（20%以上・10%以下）・数値化不能では空文字（プロンプト不変）', () => {
  assert.equal(cf.smallLotAmountHint(20), '');
  assert.equal(cf.smallLotAmountHint(45), '');
  assert.equal(cf.smallLotAmountHint(10), '');
  assert.equal(cf.smallLotAmountHint(''), '');
  assert.equal(cf.smallLotAmountHint(undefined), '');
  assert.equal(cf.smallLotAmountHint('abc'), '');
});
