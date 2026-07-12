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

// GAS Web App はコールドスタート等で稀にタイムアウト/404を返すため、1回だけ自動リトライする。
// 2026-07-08 の signalAggregator失敗（Step 3: "This operation was aborted"）・
// 審査部エラー（GAS POST HTTP 404）はこのタイムアウトが原因だった。
async function fetchT(url, opts = {}, ms = 30000, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(tid);
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

module.exports = { getRows, getRowsByDate, getRowsByDateRange, getLatestRow, getLatestRowAsOf, appendRow, upsertRow, replaceSheet, post };
