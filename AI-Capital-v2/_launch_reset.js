'use strict';

/**
 * _launch_reset.js — AI Capital V2 正式運用開始前リセット
 *
 * 実施内容:
 *   1. 運用データシートを全削除（ヘッダー保持）
 *   2. portfolio_status に初期状態を設定
 *   3. 状態確認レポート出力
 *
 * 実行: node -r dotenv/config _launch_reset.js
 */

require('dotenv').config();
const sheets = require('./lib/sheets');

const LAUNCH_DATE  = '2026-06-26';
const INITIAL_CASH = 10_000_000;

// クリア対象シート（マスター系は含めない）
const CLEAR_SHEETS = [
  'orders',
  'positions',
  'portfolio_status',
  'agent_votes',
  'agent_recommendations',
  'department_recommendations',
  'final_decisions',
  'article_decisions',
  'candidate_assets',
  'market_snapshot',
];

// 保持するシート（確認用）
const PRESERVE_SHEETS = [
  'nav_prices',
  'asset_master',
  'settings',
];

async function clearAll() {
  console.log('=== AI Capital V2 正式運用開始リセット ===\n');
  console.log(`運用開始日: ${LAUNCH_DATE}`);
  console.log(`初期資産:   ¥${INITIAL_CASH.toLocaleString()}\n`);

  // ── Step 1: データシートをクリア ────────────────────────
  console.log('--- Step 1: 運用データ全削除（ヘッダー保持） ---');
  for (const sheetName of CLEAR_SHEETS) {
    try {
      const result = await sheets.post({ action: 'clear_sheet', sheet: sheetName });
      const status = result.status || 'cleared';
      const rows   = result.rows_deleted ?? '?';
      console.log(`  ✓ ${sheetName}: ${status} (${rows}行削除)`);
    } catch (err) {
      console.error(`  ✗ ${sheetName}: エラー — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300)); // GAS レート制限対策
  }

  // ── Step 2: portfolio_status 初期状態を設定 ─────────────
  console.log('\n--- Step 2: portfolio_status 初期状態設定 ---');
  const initialPf = {
    date:          LAUNCH_DATE,
    total_assets:  String(INITIAL_CASH),
    cash:          String(INITIAL_CASH),
    pending:       '0',
    invested:      '0',
    unrealized_pl: '0',
    cash_ratio:    '100',
    positions_json: '[]',
    note:          'V2正式運用開始',
  };

  try {
    await sheets.upsertRow('portfolio_status', ['date'], initialPf);
    console.log(`  ✓ portfolio_status 初期行挿入完了`);
    console.log(`    総資産: ¥${INITIAL_CASH.toLocaleString()}`);
    console.log(`    現金:   ¥${INITIAL_CASH.toLocaleString()}`);
    console.log(`    現金比率: 100%`);
  } catch (err) {
    console.error(`  ✗ portfolio_status 挿入失敗: ${err.message}`);
  }

  // ── Step 3: 確認レポート ────────────────────────────────
  console.log('\n--- Step 3: 確認レポート ---');

  // portfolio_status 確認
  try {
    const pf = await sheets.getLatestRow('portfolio_status');
    if (pf) {
      console.log(`  portfolio_status (最新行):`);
      console.log(`    date: ${pf.date}`);
      console.log(`    total: ¥${parseInt(pf.total_assets||0).toLocaleString()}`);
      console.log(`    cash:  ¥${parseInt(pf.cash||0).toLocaleString()}`);
      console.log(`    cash_ratio: ${pf.cash_ratio}%`);
    } else {
      console.log('  ✗ portfolio_status: データなし');
    }
  } catch (err) {
    console.error(`  ✗ portfolio_status 確認失敗: ${err.message}`);
  }

  // クリア対象シートの行数確認（全てヘッダー行のみ = 0データ行）
  console.log('\n  クリア済みシート（データ行数）:');
  for (const sheetName of ['orders', 'final_decisions', 'article_decisions', 'agent_votes']) {
    try {
      const rows = await sheets.getRows(sheetName);
      const icon = rows.length === 0 ? '✓' : '⚠️';
      console.log(`    ${icon} ${sheetName}: ${rows.length}行`);
    } catch (err) {
      console.log(`    ? ${sheetName}: 確認失敗`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // 保持シートの行数確認
  console.log('\n  保持シート（行数確認）:');
  for (const sheetName of PRESERVE_SHEETS) {
    try {
      const rows = await sheets.getRows(sheetName);
      console.log(`    ✓ ${sheetName}: ${rows.length}行`);
    } catch (err) {
      console.log(`    ? ${sheetName}: 確認失敗`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n=== リセット完了 ===');
  console.log(`次回実行 2026-06-26 12:00 から V2正式運用開始`);
  console.log(`初回記事番号: AC-2026-0001（article_decisions行数=0なので自動的に0001）`);
}

clearAll().catch(err => {
  console.error('\n致命的エラー:', err.message);
  process.exit(1);
});
