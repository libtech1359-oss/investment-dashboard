'use strict';

/**
 * sheets.js — GAS Web App 経由でスプレッドシートを読み書きする
 * googleapis / サービスアカウント不要。完全無料。
 */

function gasUrl() {
  const url = process.env.GAS_V2_URL;
  if (!url) throw new Error('GAS_V2_URL が .env に未設定');
  return url;
}

// ── サーキットブレーカー（2026-08-14追加） ──────────────────────
// 個々の呼び出しのtimeout/retryはこのブレーカーの対象外・現状のまま変更しない。
// このブレーカーは「ネットワーク自体が落ちている」連続失敗（fetch例外＝AbortError/
// DNS失敗/接続不能等）だけをカウントし、HTTPステータスエラー（往復は成功している）は
// カウントしない。連続失敗が閾値に達したら、以降の呼び出しはtimeout/retryを一切試みず
// 即座に失敗させ、クールダウン明けに自動復帰する。DNS障害時に多数のcall siteがそれぞれ
// フルのtimeout+retryコストを払って累積時間が膨れ上がるのを防ぐ（2026-08-14の
// パイプライン長時間化インシデントを受けて追加）。
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS       = 60 * 1000;
let consecutiveFailures = 0;
let circuitOpenUntil    = 0;

function circuitBreakerGuard() {
  if (Date.now() < circuitOpenUntil) {
    const remainingSec = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
    throw new Error(
      `[sheets] サーキットブレーカー作動中（連続${consecutiveFailures}回のネットワーク失敗のため、` +
      `あと${remainingSec}秒はクールダウン中・呼び出しを即時スキップ）`
    );
  }
}

function recordSheetsSuccess() {
  consecutiveFailures = 0;
}

function recordSheetsFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && Date.now() >= circuitOpenUntil) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    console.warn(
      `[sheets] サーキットブレーカー作動: 連続${consecutiveFailures}回のネットワーク失敗 → ` +
      `${CIRCUIT_COOLDOWN_MS / 1000}秒間クールダウン`
    );
  }
}

// テスト用: ブレーカー状態を初期化する
function _resetCircuitBreaker() {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

// GAS Web App はコールドスタート等で稀にタイムアウト/404を返すため、1回だけ自動リトライする。
// 2026-07-08 の signalAggregator失敗（Step 3: "This operation was aborted"）・
// 審査部エラー（GAS POST HTTP 404）はこのタイムアウトが原因だった。
async function fetchT(url, opts = {}, ms = 30000, retries = 1) {
  circuitBreakerGuard();
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(tid);
      recordSheetsSuccess();
      if (!res.ok && attempt < retries) {
        console.warn(`[sheets] HTTP ${res.status} → ${attempt + 1}/${retries}回目のリトライ`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(tid);
      lastErr = err;
      if (attempt < retries) {
        console.warn(`[sheets] ${err.message} → ${attempt + 1}/${retries}回目のリトライ`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      recordSheetsFailure();
      throw err;
    }
  }
  throw lastErr;
}

// ── 全行取得 ─────────────────────────────────────────────────
async function getRows(sheetName) {
  const res  = await fetchT(`${gasUrl()}?sheet=${encodeURIComponent(sheetName)}`, {}, 45000);
  if (!res.ok) throw new Error(`GAS GET ${sheetName} HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(`GAS: ${data.error}`);
  return Array.isArray(data) ? data : [];
}

// ── 日付でフィルタ（単日）─────────────────────────────────
async function getRowsByDate(sheetName, date) {
  const res  = await fetchT(`${gasUrl()}?sheet=${encodeURIComponent(sheetName)}&date=${encodeURIComponent(date)}`);
  if (!res.ok) throw new Error(`GAS GET ${sheetName} HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(`GAS: ${data.error}`);
  return Array.isArray(data) ? data : [];
}

// ── 日付範囲でフィルタ（週間集計用）─────────────────────────
async function getRowsByDateRange(sheetName, startDate, endDate) {
  const rows = await getRows(sheetName);
  return rows.filter(r => {
    const day = (r.date || r.timestamp || '').slice(0, 10);
    return day >= startDate && day <= endDate;
  });
}

// ── 最新1行（date降順） ───────────────────────────────────
async function getLatestRow(sheetName) {
  const res  = await fetchT(`${gasUrl()}?sheet=${encodeURIComponent(sheetName)}&action=latest`);
  if (!res.ok) throw new Error(`GAS GET ${sheetName} HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(`GAS: ${data.error}`);
  return data ?? null;
}

// ── 指定日時点での最新1行（date <= 指定日のうち末尾） ─────────
// 過去日の記事を再生成する際、getLatestRow()だと常に「今の最新」を
// 返してしまうため、その日の状態を復元するために使う。
async function getLatestRowAsOf(sheetName, date) {
  const rows = await getRows(sheetName);
  const filtered = rows.filter(r => (r.date || r.timestamp || '').slice(0, 10) <= date);
  return filtered.length > 0 ? filtered[filtered.length - 1] : null;
}

// ── POST 共通 ─────────────────────────────────────────────
async function post(body, ms = 15000) {
  const res = await fetchT(gasUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }, ms);
  if (!res.ok) throw new Error(`GAS POST HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(`GAS: ${data.error}`);
  return data;
}

// ── 行を追加 ─────────────────────────────────────────────
async function appendRow(sheetName, data) {
  return post({ sheet: sheetName, action: 'append', data });
}

// ── Upsert（キー列が一致すれば更新、なければ追加）────────
async function upsertRow(sheetName, keys, data) {
  return post({ sheet: sheetName, action: 'upsert', keys: Array.isArray(keys) ? keys : [keys], data });
}

// ── シート全体置換（positionsなど） ───────────────────────
async function replaceSheet(sheetName, headers, rows) {
  // GAS経由では行ごとにupsertするのが安全
  for (const row of rows) {
    await upsertRow(sheetName, ['asset_name'], row);
  }
}

// ── シート全行削除（ヘッダー行は残す） ─────────────────────
async function clearSheet(sheetName) {
  return post({ action: 'clear_sheet', sheet: sheetName });
}

module.exports = {
  getRows, getRowsByDate, getRowsByDateRange, getLatestRow, getLatestRowAsOf,
  appendRow, upsertRow, replaceSheet, clearSheet, post,
  _resetCircuitBreaker, CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_COOLDOWN_MS,
};
