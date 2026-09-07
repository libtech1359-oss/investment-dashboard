'use strict';

/**
 * config/cashFloor.js — 買い側キャッシュフロア v1 設定
 *
 * 現金比率が下限に近づくにつれて日次買付額を線形に逓減させ、暴落逆張り用の
 * 資金余力を残すための「買い側ブレーキ」。売却は一切発生させない（利確は
 * 財務戦略部＝財前ミナの専任のまま。churn source を増やさない）。
 *
 * 設計仕様: 買い側キャッシュフロア v1 設計 / 2026-09-07 確定
 *
 * 【判定の単位】
 *   現金比率（cashRatioPct）… 時価基準の % 値（portfolio_status.cash_ratio と同じ）
 *   bu(y)Amount / baseAmount   … 買い注文と同じ「取得原価相当額」の円
 *
 * 数値はこのファイルでのみ管理し、lib/signalAggregator.js にハードコードしない。
 * env で上書き可能（主にテスト・段階検証用）。
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// 現金比率・金額のパース。'' / null / undefined は Number() だと 0 に化けるため
// parseFloat を使い、数値化できないものは NaN のまま返す（signalAggregator と同じ流儀）。
const pf = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};

// ── フロア水準 ───────────────────────────────────────────────
// SOFT 以上: 通常買付（逓減なし）。財前ミナ ACTIVATE_BELOW_PCT と揃える。
// SOFT 未満 HARD 超: baseAmount を線形係数 (cr - hard)/(soft - hard) で逓減。
// HARD 以下: 買付見送り（通常時）。
// CRASH 以下: 暴落例外時でも買付見送り（最終下限）。
const CASH_FLOOR_SOFT_PCT   = num(process.env.CASH_FLOOR_SOFT_PCT, 20);
const CASH_FLOOR_HARD_PCT   = num(process.env.CASH_FLOOR_HARD_PCT, 10);
const CASH_FLOOR_CRASH_PCT  = num(process.env.CASH_FLOOR_CRASH_PCT, 5);

// ── 暴落例外の発火条件（どちらか一方で ON）──────────────────
// 暴落局面では逆張り用に HARD ではなく CRASH まで買いを許可する。
const CRASH_FG_MAX          = num(process.env.CASH_FLOOR_CRASH_FG_MAX, 25);      // Fear&Greed これ以下
const CRASH_NASDAQ_DROP_PCT = num(process.env.CASH_FLOOR_CRASH_NASDAQ_DROP_PCT, -3.0); // NASDAQ 前日比 これ以下

// ── 逓減後の最小発注額 ───────────────────────────────────────
// これ未満に縮小されたら 0（＝買付見送り）に丸める。orderManager の下限（¥1,000）と揃える。
const MIN_ORDER_AMOUNT      = num(process.env.CASH_FLOOR_MIN_ORDER_AMOUNT, 1000);

/**
 * 暴落シグナル判定（純粋関数）。
 * @param {{fearGreed?:number|string, nasdaqChangePct?:number|string}} mkt
 * @returns {boolean}
 */
function isCrashSignal({ fearGreed, nasdaqChangePct } = {}) {
  const fg = Number(fearGreed);
  const nd = Number(nasdaqChangePct);
  return (Number.isFinite(fg) && fg <= CRASH_FG_MAX)
      || (Number.isFinite(nd) && nd <= CRASH_NASDAQ_DROP_PCT);
}

/**
 * 買付予算の決定（純粋関数）。
 *
 *   cashRatioPct 数値化不可         -> baseAmount 素通し（既存挙動を変えない・安全側）
 *   cashRatioPct >= SOFT            -> baseAmount 素通し
 *   cashRatioPct <= floor           -> 0（買付見送り）  ※floor = crash ? CRASH : HARD
 *   floor < cashRatioPct < SOFT     -> floorTo1000(baseAmount * factor)、ただし
 *                                      ・cashJpy を超えない
 *                                      ・MIN_ORDER_AMOUNT 未満なら 0
 *     factor = (cashRatioPct - floor) / (SOFT - floor)   （0〜1）
 *
 * @param {object} args
 * @param {number|string} args.cashRatioPct  現在の現金比率（%）
 * @param {number|string} [args.cashJpy]     現在の現金残高（円）。逓減後でも残高は超えない
 * @param {number|string} args.baseAmount    フロア適用前の買付額（円）
 * @param {boolean}       [args.crashSignal] 暴落例外を有効にするか（isCrashSignal() の結果）
 * @param {object}        [args.cfg]         このモジュール（テスト時に差し替え可）
 * @returns {{amount:number, factor:number, note:string, floorPct:number}}
 */
function resolveBuyBudget({ cashRatioPct, cashJpy = Infinity, baseAmount, crashSignal = false, cfg = module.exports }) {
  const base = Math.max(0, num(baseAmount, 0));
  const cr   = pf(cashRatioPct);
  const soft = cfg.CASH_FLOOR_SOFT_PCT;
  const floorPct = crashSignal ? cfg.CASH_FLOOR_CRASH_PCT : cfg.CASH_FLOOR_HARD_PCT;

  if (!Number.isFinite(cr)) {
    return { amount: base, factor: 1, note: '', floorPct };
  }
  if (cr >= soft) {
    return { amount: base, factor: 1, note: '', floorPct };
  }
  if (cr <= floorPct) {
    return {
      amount: 0, factor: 0, floorPct,
      note: `現金比率${cr}%が下限${floorPct}%以下のため、買付を見送りました。`,
    };
  }

  const factor = (cr - floorPct) / (soft - floorPct);
  let amt = Math.floor((base * factor) / 1000) * 1000;
  const parsedCash = pf(cashJpy);
  const cashCap = Number.isFinite(parsedCash) ? Math.max(0, parsedCash) : Infinity;
  amt = Math.min(amt, cashCap);

  if (amt < cfg.MIN_ORDER_AMOUNT) {
    return {
      amount: 0, factor, floorPct,
      note: `現金比率${cr}%が下限圏のため、現金フロア抑制後の買付額が下限未満となり見送りました。`,
    };
  }
  return {
    amount: amt, factor, floorPct,
    note: `現金比率${cr}%が下限圏（${floorPct}〜${soft}%）のため、現金フロアにより買付を¥${amt.toLocaleString()}に抑制しました。`,
  };
}

module.exports = {
  CASH_FLOOR_SOFT_PCT,
  CASH_FLOOR_HARD_PCT,
  CASH_FLOOR_CRASH_PCT,
  CRASH_FG_MAX,
  CRASH_NASDAQ_DROP_PCT,
  MIN_ORDER_AMOUNT,
  isCrashSignal,
  resolveBuyBudget,
};
