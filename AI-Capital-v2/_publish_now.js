'use strict';
require('dotenv').config();

const publisher = require('./agents/publisher');

const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
console.log(`[publish_now] 日付: ${date}`);

publisher.publish(date)
  .then(result => {
    console.log('\n=== 完了 ===');
    console.log('note URL:', result.noteUrl || '（未取得）');
    process.exit(0);
  })
  .catch(err => {
    console.error('[publish_now] エラー:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
