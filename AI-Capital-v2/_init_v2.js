'use strict';

/**
 * _init_v2.js — AI Capital V2 正式運用開始初期化スクリプト
 *
 * 用途: 旧テストデータ・移行期間データをクリアし、
 *       2026-06-25 を V2 運用開始日として基準状態を確定する。
 *
 * 実行: node -r dotenv/config _init_v2.js
 */

require('dotenv').config();
const sheets = require('./lib/sheets');

// ── 定数 ─────────────────────────────────────────────────────
const LAUNCH_DATE      = '2026-06-25';
const INITIAL_CASH     = 10_000_000;
const CLEAR_SHEETS     = [
  'orders',
  'positions',
  'agent_votes',
  'candidate_assets',
  'portfolio_status',
  'final_decisions',
  'article_decisions',
  'agent_recommendations',
  'department_recommendations',
  'market_snapshot',
];

// ── シート全行クリア ──────────────────────────────────────────
async function clearSheet(name) {
  const result = await sheets.post({ action: 'clear_sheet', sheet: name });
  return result.rows_deleted ?? 0;
}

// ── メイン処理 ───────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log(' AI Capital V2 初期化開始');
  console.log(` 運用開始日: ${LAUNCH_DATE}  初期資金: ¥${INITIAL_CASH.toLocaleString()}`);
  console.log('='.repeat(60));

  // Step 1: 初期化前の行数を確認
  console.log('\n[Step 1] 初期化前の行数確認');
  const beforeCounts = {};
  for (const name of CLEAR_SHEETS) {
    const rows = await sheets.getRows(name).catch(() => null);
    beforeCounts[name] = rows === null ? '(シートなし)' : rows.length + '行';
    console.log(`  ${name}: ${beforeCounts[name]}`);
  }

  // Step 2: 対象シートを全クリア
  console.log('\n[Step 2] シート初期化中...');
  const clearResults = {};
  for (const name of CLEAR_SHEETS) {
    try {
      const deleted = await clearSheet(name);
      clearResults[name] = `削除 ${deleted}行`;
      console.log(`  ✓ ${name}: ${deleted}行削除`);
    } catch (err) {
      clearResults[name] = `エラー: ${err.message}`;
      console.error(`  ✗ ${name}: ${err.message}`);
    }
  }

  // Step 3: portfolio_status 初回レコード作成
  console.log('\n[Step 3] portfolio_status 初回レコード作成');
  const jstNow = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ');
  const initPf = {
    timestamp:          jstNow,
    date:               LAUNCH_DATE,
    total_assets:       String(INITIAL_CASH),
    cash:               String(INITIAL_CASH),
    invested:           '0',
    pending:            '0',
    unrealized_pl:      '0',
    cash_ratio:         '100',
    source_orders:      '0',
    source_positions:   '0',
    pending_json:       '[]',
    positions_json:     '[]',
  };

  await sheets.appendRow('portfolio_status', initPf);
  console.log(`  ✓ portfolio_status 初期レコード作成`);
  console.log(`    timestamp: ${jstNow}`);
  console.log(`    cash: ¥${INITIAL_CASH.toLocaleString()}  pending: ¥0  invested: ¥0`);

  // Step 4: 検証レポート
  console.log('\n[Step 4] 初期化後の確認');
  await new Promise(r => setTimeout(r, 2000)); // GAS 反映待ち

  const [pf, ordersRows, posRows, votesRows, mktRows] = await Promise.all([
    sheets.getLatestRow('portfolio_status').catch(() => null),
    sheets.getRows('orders').catch(() => []),
    sheets.getRows('positions').catch(() => []),
    sheets.getRows('agent_votes').catch(() => []),
    sheets.getRows('article_decisions').catch(() => []),
  ]);

  console.log('\n' + '='.repeat(60));
  console.log(' 初期化完了レポート');
  console.log('='.repeat(60));
  console.log('\n■ portfolio_status 最新状態');
  if (pf) {
    console.log(`  timestamp:    ${pf.timestamp}`);
    console.log(`  date:         ${pf.date}`);
    console.log(`  total_assets: ¥${parseInt(pf.total_assets).toLocaleString()}`);
    console.log(`  cash:         ¥${parseInt(pf.cash).toLocaleString()}`);
    console.log(`  pending:      ¥${parseInt(pf.pending).toLocaleString()}`);
    console.log(`  invested:     ¥${parseInt(pf.invested).toLocaleString()}`);
    console.log(`  cash_ratio:   ${pf.cash_ratio}%`);
    const t = parseInt(pf.total_assets), c = parseInt(pf.cash),
          p = parseInt(pf.pending), i = parseInt(pf.invested);
    console.log(`  整合性: ${c}+${p}+${i} = ${c+p+i} ${c+p+i === t ? '✓ OK' : '✗ NG (expected ' + t + ')'}`);
  } else {
    console.log('  (レコードなし)');
  }

  console.log('\n■ 残存レコード数（すべて 0 が正常）');
  console.log(`  orders:            ${ordersRows.length}件`);
  console.log(`  positions:         ${posRows.length}件`);
  console.log(`  agent_votes:       ${votesRows.length}件`);
  console.log(`  article_decisions: ${mktRows.length}件`);

  console.log('\n■ 記事採番（次回記事番号）');
  const nextNum = `AC-${LAUNCH_DATE.slice(0, 4)}-${String(mktRows.length + 1).padStart(4, '0')}`;
  console.log(`  次回: ${nextNum}`);

  console.log('\n' + '='.repeat(60));
  console.log(' V2 正式運用開始状態の確定が完了しました');
  console.log(`  運用開始日: ${LAUNCH_DATE}`);
  console.log(`  初期資金: ¥${INITIAL_CASH.toLocaleString()}`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('初期化エラー:', err.message);
  process.exit(1);
});
