'use strict';
/**
 * _reset_operational.js
 * 運用データをリセットし、portfolio_status を初期状態に戻す。
 * nav_prices / asset_master / capital_events は保持する。
 * 実行後、明日のパイプラインから AC-2026-0001 で再スタートする。
 */

require('dotenv').config();
const sheets = require('./lib/sheets');

const SHEETS_TO_CLEAR = [
  'orders',
  'portfolio_status',
  'positions',
  'agent_votes',
  'agent_recommendations',
  'department_recommendations',
  'final_decisions',
  'article_decisions',
  'market_data',
  'market_snapshot',
  'candidate_assets',
  'quality_status',
];

async function clearSheet(name) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sheets.post({ action: 'clear_sheet', sheet: name }, 60000);
      console.log(`  ✅ ${name} クリア完了`);
      return;
    } catch (e) {
      if (attempt < 3) {
        console.log(`  ↩  ${name} リトライ中 (${attempt}/3)...`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.warn(`  ⚠️  ${name} クリア失敗: ${e.message}`);
      }
    }
  }
}

async function initPortfolioStatus() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const ts    = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ');
  await sheets.appendRow('portfolio_status', {
    timestamp:        ts,
    date:             today,
    total_assets:     '10000000',
    cash:             '10000000',
    pending:          '0',
    invested:         '0',
    unrealized_pl:    '0',
    cash_ratio:       '100.0',
    source_orders:    '0',
    source_positions: '0',
    positions_json:   '[]',
    pending_json:     '[]',
    note:             'リセット: 初期状態 ¥10,000,000',
  });
  console.log('  ✅ portfolio_status 初期行を挿入');
}

(async () => {
  console.log('=== 運用データ リセット開始 ===\n');
  console.log('【クリア対象】');
  for (const name of SHEETS_TO_CLEAR) {
    await clearSheet(name);
  }

  console.log('\n【初期状態セットアップ】');
  await initPortfolioStatus();

  console.log('\n=== リセット完了 ===');
  console.log('明日のパイプラインから AC-2026-0001 で再スタートします。');
})();
