'use strict';
require('dotenv').config();

const publisher = require('./agents/publisher');

const date = process.argv[2] || '2026-07-23';

(async () => {
  console.log(`[regen] 記事再生成開始: ${date}`);
  try {
    const result = await publisher.publish(date);
    console.log('\n=== 完了 ===');
    console.log('note URL:', result?.noteUrl || '(URL未取得)');
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('[regen] 失敗:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
  process.exit(0);
})();
