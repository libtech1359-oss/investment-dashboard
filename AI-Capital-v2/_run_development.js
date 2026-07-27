'use strict';
/**
 * _run_development.js — 開発ログ手動登録スクリプト
 *
 * 使い方:
 *   node _run_development.js            # 初回ログ（PHASE1_COMPLETION）を登録
 *   node _run_development.js --dry-run  # 保存なし・確認のみ
 *
 * NOTE: 保存する場合は development_logs シートへ書き込みます。
 */
require('dotenv').config();

const {
  BOOTSTRAP_LOG,
  buildDevelopmentLog,
  saveDevelopmentLog,
} = require('./agents/development');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('開発ログ確認\n');

  const { log, meta } = await buildDevelopmentLog(BOOTSTRAP_LOG, '2026-06-28');

  console.log('--- メタデータ ---');
  console.log(JSON.stringify(meta, null, 2));
  console.log('\n--- ログ内容 ---');
  console.log(JSON.stringify(log, null, 2));

  if (dryRun) {
    console.log('\n✅ dry-run 完了（保存なし）');
    return;
  }

  console.log('\n保存中...');
  await saveDevelopmentLog(BOOTSTRAP_LOG, '2026-06-28');
  console.log('✅ development_logs シートへ保存完了');
}

main().catch(e => {
  console.error('エラー:', e.message);
  process.exit(1);
});
