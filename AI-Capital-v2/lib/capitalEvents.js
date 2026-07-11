'use strict';

/**
 * capitalEvents.js — 資金イベント管理
 *
 * capital_events シートを唯一の元本ソースとして扱う。
 * 「総元本 = 全イベントの amount 合計」でポートフォリオ現金を計算する。
 *
 * 対応 event_type（switch 不要の加算方式で将来拡張可能）:
 *   initial_capital   — 初期資金（1回のみ）
 *   monthly_injection — 毎月積立（20万円）
 *   bonus_injection   — ボーナス（7月・12月 各100万円）
 *   manual_injection  — 将来: 臨時入金
 *   special_injection — 将来: 特別追加資金
 *
 * 二重登録防止:
 *   event_type + period の組み合わせがシートに存在すれば登録をスキップ。
 *   period 例: 'initial' / '2026-07' / '2026-07-bonus'
 */

const sheets = require('./sheets');
const crypto = require('crypto');

// ── 定数 ─────────────────────────────────────────────────────

const INITIAL_CAPITAL_AMOUNT = 10_000_000;  // ¥10,000,000
const MONTHLY_AMOUNT         =    200_000;  // ¥200,000
const BONUS_AMOUNT           =  1_000_000;  // ¥1,000,000

const EVENT_TYPES = {
  INITIAL_CAPITAL:    'initial_capital',
  MONTHLY_INJECTION:  'monthly_injection',
  BONUS_INJECTION:    'bonus_injection',
  MANUAL_INJECTION:   'manual_injection',   // 将来用
  SPECIAL_INJECTION:  'special_injection',  // 将来用
};

// ── ユーティリティ ────────────────────────────────────────────

function generateEventId() {
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `EVT-${date}-${rand}`;
}

function nowJSTTimestamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ');
}

function currentYearMonth() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 7); // 'YYYY-MM'
}

// ── 読み取り ──────────────────────────────────────────────────

/**
 * capital_events シートの全イベントを取得する
 * @returns {Promise<object[]>}
 */
async function getAllEvents() {
  return sheets.getRows('capital_events').catch(() => []);
}

/**
 * Google Sheets が 'YYYY-MM' を日付とみなして 'YYYY-MM-01' に変換する挙動を吸収する
 * 例: '2026-07-01' → '2026-07'（GAS 自動変換アーティファクト）
 *     '2026-07-bonus' → '2026-07-bonus'（変換なし: 有効な日付フォーマットではない）
 *     'initial'       → 'initial'（変換なし）
 */
function normalizePeriod(p) {
  return (p ?? '').replace(/^(\d{4}-\d{2})-01$/, '$1');
}

/**
 * 指定の event_type + period が既に登録されているか確認する（二重登録防止）
 * normalizePeriod を使って GAS の日付自動変換を吸収する。
 * @param {string} eventType
 * @param {string} period
 * @returns {Promise<boolean>}
 */
async function existsEvent(eventType, period) {
  const events   = await getAllEvents();
  const normTarget = normalizePeriod(period);
  return events.some(e =>
    e.event_type === eventType && normalizePeriod(e.period) === normTarget
  );
}

/**
 * 累計元本を計算する。
 * asOfDate（YYYY-MM-DD）を渡すと、その日付以前に発生したイベントのみを集計する。
 * period が 'initial' のイベントは常に含める。
 * period が 'YYYY-MM' / 'YYYY-MM-DD' / 'YYYY-MM-bonus' のイベントは
 * 月初日（YYYY-MM-01）が asOfDate 以下の場合のみ含める。
 *
 * @param {string|null} asOfDate - 集計基準日（YYYY-MM-DD）。省略時は当日（JST）
 * @returns {Promise<number>}
 */
async function calcTotalPrincipal(asOfDate = null) {
  try {
    const events = await getAllEvents();
    if (events.length === 0) {
      console.warn('[capitalEvents] capital_events が空 — 初期値 ¥10,000,000 を使用');
      return INITIAL_CAPITAL_AMOUNT;
    }

    const cutoff = asOfDate
      ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

    const applicable = events.filter(e => {
      const period = normalizePeriod(e.period ?? '');
      if (period === 'initial') return true;           // 初期資金は常に含める
      const m = period.match(/^(\d{4}-\d{2})/);
      if (!m) return true;                             // パース不可は安全側で含める
      const periodStart = m[1] + '-01';                // 月初日に変換して比較
      return periodStart <= cutoff;
    });

    const total = applicable.reduce((sum, e) => sum + parseInt(e.amount || 0, 10), 0);

    if (applicable.length < events.length) {
      const skipped = events.length - applicable.length;
      console.log(`[capitalEvents] calcTotalPrincipal(${cutoff}): ${applicable.length}件集計, ${skipped}件除外（将来分）→ ¥${total.toLocaleString()}`);
    }

    return total;
  } catch (err) {
    console.warn(`[capitalEvents] calcTotalPrincipal 失敗 — 初期値を使用: ${err.message}`);
    return INITIAL_CAPITAL_AMOUNT;
  }
}

// ── 書き込み（汎用） ──────────────────────────────────────────

/**
 * 資金イベントを capital_events シートへ追加する（汎用）
 * running_total は既存レコードの合計 + 今回の amount で計算する。
 *
 * 将来の event_type 追加時もこの関数をそのまま使用できる。
 *
 * @param {{ event_type: string, period: string, amount: number, description: string }} opts
 * @returns {Promise<object>} 登録したレコード
 */
async function addEvent({ event_type, period, amount, description }) {
  const events       = await getAllEvents();
  const prevTotal    = events.reduce((s, e) => s + parseInt(e.amount || 0, 10), 0);
  const runningTotal = prevTotal + amount;

  const row = {
    event_id:      generateEventId(),
    event_type,
    period,
    amount:        String(amount),
    running_total: String(runningTotal),
    description,
    created_at:    nowJSTTimestamp(),
  };

  await sheets.appendRow('capital_events', row);
  console.log(
    `[capitalEvents] ${event_type} 登録: ¥${amount.toLocaleString()} (${period})` +
    ` 累計元本=¥${runningTotal.toLocaleString()}`
  );
  return row;
}

// ── 個別イベント登録 ──────────────────────────────────────────

/**
 * 初期資金 ¥10,000,000 を登録する（initial_capital が未登録の場合のみ）
 * システム初回起動時に一度だけ実行される。
 * @returns {Promise<object|null>} 登録したレコード、または null（スキップ時）
 */
async function ensureInitialCapital() {
  if (await existsEvent(EVENT_TYPES.INITIAL_CAPITAL, 'initial')) {
    return null; // 既に登録済み — 何もしない
  }
  return addEvent({
    event_type:  EVENT_TYPES.INITIAL_CAPITAL,
    period:      'initial',
    amount:      INITIAL_CAPITAL_AMOUNT,
    description: 'Initial Capital',
  });
}

/**
 * 月次積立 ¥200,000 を登録する（同じ period は1回のみ）
 * @param {string} [periodStr] - 'YYYY-MM' 形式（省略時は当月）
 * @returns {Promise<object|null>}
 */
async function addMonthlyInjection(periodStr) {
  const period = periodStr ?? currentYearMonth();
  if (await existsEvent(EVENT_TYPES.MONTHLY_INJECTION, period)) {
    console.log(`[capitalEvents] 月次積立 ${period} 登録済み — スキップ`);
    return null;
  }
  return addEvent({
    event_type:  EVENT_TYPES.MONTHLY_INJECTION,
    period,
    amount:      MONTHLY_AMOUNT,
    description: 'Monthly Capital Injection',
  });
}

/**
 * ボーナス追加 ¥1,000,000 を登録する（7月・12月、同じ period は1回のみ）
 * @param {string} [periodStr] - 'YYYY-MM-bonus' 形式（省略時は当月-bonus）
 * @returns {Promise<object|null>}
 */
async function addBonusInjection(periodStr) {
  const period = periodStr ?? `${currentYearMonth()}-bonus`;
  if (await existsEvent(EVENT_TYPES.BONUS_INJECTION, period)) {
    console.log(`[capitalEvents] ボーナス ${period} 登録済み — スキップ`);
    return null;
  }
  return addEvent({
    event_type:  EVENT_TYPES.BONUS_INJECTION,
    period,
    amount:      BONUS_AMOUNT,
    description: 'Bonus Capital Injection',
  });
}

// ── エクスポート ──────────────────────────────────────────────

module.exports = {
  EVENT_TYPES,
  INITIAL_CAPITAL_AMOUNT,
  MONTHLY_AMOUNT,
  BONUS_AMOUNT,
  calcTotalPrincipal,
  ensureInitialCapital,
  addMonthlyInjection,
  addBonusInjection,
  addEvent,
  getAllEvents,
};
