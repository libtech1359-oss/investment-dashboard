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

function fetchT(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
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

module.exports = { getRows, getRowsByDate, getRowsByDateRange, getLatestRow, appendRow, upsertRow, replaceSheet, post };
