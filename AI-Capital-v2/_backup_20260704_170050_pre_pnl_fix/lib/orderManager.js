'use strict';

/**
 * orderManager.js
 * final_decisions の信号を受けて orders シートへ発注記録を書き込む。
 * 実際の発注は行わない（管理者が確認後に手動実行）。
 */

const sheets = require('./sheets');
const crypto = require('crypto');

function todayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function generateOrderId() {
  const date = todayJST().replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `ORD-${date}-${rand}`;
}

async function processSignal(finalDecision) {
  if (!finalDecision) return null;

  const { final_signal, target_asset, amount, date } = finalDecision;

  if (!['BUY', 'ACCUMULATE'].includes(final_signal)) {
    console.log(`[orderManager] 発注不要: ${final_signal}`);
    return null;
  }

  if (!target_asset || !amount || parseFloat(amount) < 1000) {
    console.log(`[orderManager] 発注スキップ: 銘柄未定またはamount不足 (target=${target_asset} amount=${amount})`);
    return null;
  }

  // 同日・同銘柄の重複発注チェック
  const existing = await sheets.getRowsByDate('orders', date ?? todayJST());
  const dup = existing.find(o => o.asset_name === target_asset && o.status === 'pending');
  if (dup) {
    console.log(`[orderManager] 重複発注スキップ: ${target_asset} (既存注文ID: ${dup.order_id})`);
    return dup;
  }

  // ── 現金残高事前チェック（orders書き込み前に確認）─────────────
  const pf = await sheets.getLatestRow('portfolio_status').catch(() => null);
  if (pf) {
    const availableCash = parseInt(pf.cash || 0, 10);
    const orderAmount   = parseInt(amount, 10);
    if (availableCash < orderAmount) {
      console.warn(
        `[orderManager] ⚠️ 現金不足のため注文拒否:` +
        ` 利用可能 ¥${availableCash.toLocaleString()}` +
        ` < 注文 ¥${orderAmount.toLocaleString()}` +
        ` (${target_asset})`
      );
      return null;
    }
  } else {
    console.warn('[orderManager] portfolio_status 未取得 — 現金チェックをスキップして続行');
  }

  const order = {
    order_id:   generateOrderId(),
    date:        date ?? todayJST(),
    asset_name:  target_asset,
    amount:      amount,
    status:      'pending',
  };

  await sheets.appendRow('orders', order);
  console.log(`[orderManager] 発注記録: ${order.order_id} ${order.asset_name} ¥${parseInt(order.amount).toLocaleString()}`);

  // portfolio_status を即時更新（publisherが最新状態を読めるよう）
  await updatePortfolioForPendingOrder(order.date, target_asset, parseInt(amount));

  return order;
}

async function updatePortfolioForPendingOrder(runDate, assetName, orderAmt) {
  const pf = await sheets.getLatestRow('portfolio_status').catch(() => null);
  if (!pf) {
    console.warn('[orderManager] portfolio_status 未取得 — 更新スキップ');
    return;
  }

  const prevCash    = parseInt(pf.cash    || 0);
  const prevPending = parseInt(pf.pending || 0);
  const prevTotal   = parseInt(pf.total_assets || 0);
  const newCash     = prevCash - orderAmt;
  const newPending  = prevPending + orderAmt;

  if (newCash < 0) {
    // 事前チェックをすり抜けた場合の最終安全網（通常は到達しない）
    console.warn(`[orderManager] ⚠️ portfolio_status 更新スキップ（現金不足安全網）: cash=¥${prevCash.toLocaleString()} < order=¥${orderAmt.toLocaleString()}`);
    return;
  }

  // pending_json に新規注文を追加
  const pendingJson = JSON.parse(pf.pending_json || '[]');
  pendingJson.push({ name: assetName, amount: String(orderAmt) });

  const newCashRatio = prevTotal > 0 ? (newCash / prevTotal * 100).toFixed(1) : '0.0';
  const timestamp    = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ');

  // upsertRow だと timestamp なしの行が作られ getLatestRow に拾われないため appendRow で新スナップショットを追記する
  await sheets.appendRow('portfolio_status', {
    timestamp,
    date:          runDate,
    total_assets:  pf.total_assets,
    cash:          String(newCash),
    pending:       String(newPending),
    invested:      pf.invested   || '0',
    unrealized_pl: pf.unrealized_pl || '0',
    cash_ratio:    newCashRatio,
    source_orders:    pf.source_orders    || '0',
    source_positions: pf.source_positions || '0',
    positions_json: pf.positions_json || '[]',
    pending_json:   JSON.stringify(pendingJson),
    note:          `発注: ${assetName} ¥${orderAmt.toLocaleString()}`,
  });

  console.log(`[orderManager] portfolio_status更新: cash ¥${prevCash.toLocaleString()} → ¥${newCash.toLocaleString()}, pending +¥${orderAmt.toLocaleString()}`);
}

// 前営業日以前の pending/ordered 注文を自動的に filled へ遷移
// 毎日パイプラインの Step1（dataFetcher.run）冒頭で呼ぶ
async function autoFillPendingOrders(todayDate) {
  const rows = await sheets.getRows('orders').catch(() => []);
  const toFill = rows.filter(o =>
    ['pending', 'ordered'].includes(o.status) &&
    o.date && o.date < todayDate
  );

  if (toFill.length === 0) {
    console.log('[orderManager] 前営業日以前の未約定注文なし');
    return 0;
  }

  for (const o of toFill) {
    await sheets.upsertRow('orders', ['order_id'], { ...o, status: 'filled' });
    console.log(
      `[orderManager] 自動約定: ${o.order_id} ${o.asset_name}` +
      ` ¥${parseInt(o.amount || 0).toLocaleString()} (発注日: ${o.date} → 本日約定)`
    );
  }

  console.log(`[orderManager] 自動約定完了: ${toFill.length}件 filled`);
  return toFill.length;
}

// 注文ステータス更新（pending → ordered/filled/cancelled/sold）
async function updateStatus(order_id, newStatus) {
  const rows = await sheets.getRows('orders');
  const idx  = rows.findIndex(r => r.order_id === order_id);
  if (idx < 0) throw new Error(`注文ID ${order_id} が見つかりません`);

  rows[idx].status = newStatus;
  const headers = ['order_id', 'date', 'asset_name', 'amount', 'status'];
  await sheets.replaceSheet('orders', headers, rows);
  console.log(`[orderManager] 注文ステータス更新: ${order_id} → ${newStatus}`);
}

// 直近N件の注文取得
async function getRecentOrders(n = 10) {
  const rows = await sheets.getRows('orders');
  return rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
}

module.exports = { processSignal, updateStatus, getRecentOrders, autoFillPendingOrders };
