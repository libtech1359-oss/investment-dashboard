'use strict';
require('dotenv').config();

const sheets = require('./lib/sheets');

const RESET_SHEETS = [
  'portfolio_status',
  'final_decisions',
  'agent_votes',
  'department_recommendations',
  'agent_recommendations',
  'orders',
  'positions',
];

// リセット後にシードする初期 portfolio_status
const INITIAL_DATE      = '2026-06-26';
const INITIAL_PORTFOLIO = {
  timestamp:         '2026-06-26 00:00:00',
  date:              INITIAL_DATE,
  total_assets:      '10000000',
  cash:              '10000000',
  pending:           '0',
  invested:          '0',
  unrealized_pl:     '0',
  cash_ratio:        '100.0',
  source_orders:     '0',
  source_positions:  '0',
  positions_json:    '[]',
  pending_json:      '[]',
};

(async () => {
  console.log('=== AI Capital v2 シートリセット ===');
  console.log('保持シート: market_data, market_snapshot, nav_prices, asset_master, candidate_assets');
  console.log('');

  // Step 1: 各シートをクリア
  for (const name of RESET_SHEETS) {
    try {
      const res = await sheets.post({ action: 'clear_sheet', sheet: name });
      console.log(`✅ クリア: ${name} → ${JSON.stringify(res)}`);
    } catch (e) {
      console.warn(`⚠️  ${name} クリア失敗: ${e.message}`);
    }
  }

  console.log('');

  // Step 2: portfolio_status の初期行を挿入
  try {
    await sheets.appendRow('portfolio_status', INITIAL_PORTFOLIO);
    console.log('✅ portfolio_status 初期化完了:');
    console.log(`   日付: ${INITIAL_DATE}`);
    console.log(`   総資産: ¥${Number(INITIAL_PORTFOLIO.total_assets).toLocaleString()}`);
    console.log(`   現金:   ¥${Number(INITIAL_PORTFOLIO.cash).toLocaleString()}`);
    console.log(`   現金比率: ${INITIAL_PORTFOLIO.cash_ratio}%`);
  } catch (e) {
    console.error('❌ portfolio_status 初期化失敗:', e.message);
  }

  console.log('');
  console.log('=== リセット完了 ===');
  console.log('スプレッドシートを確認後、_run_date.js を実行してください。');
  process.exit(0);
})();
