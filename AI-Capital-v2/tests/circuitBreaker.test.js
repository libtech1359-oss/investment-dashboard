'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

process.env.GAS_V2_URL = process.env.GAS_V2_URL || 'http://example.invalid/exec';

const sheets = require('../lib/sheets');

function installFailingFetch() {
  const original = global.fetch;
  global.fetch = async () => {
    throw new Error('simulated network down (DNS failure)');
  };
  return () => { global.fetch = original; };
}

test('サーキットブレーカー: 連続失敗が閾値に達すると以降は即時失敗する', async (t) => {
  sheets._resetCircuitBreaker();
  const restore = installFailingFetch();
  t.after(restore);

  // 閾値回数まではこれまで通りtimeout+retryを経て失敗する（既存挙動は変更しない）
  for (let i = 0; i < sheets.CIRCUIT_FAILURE_THRESHOLD; i++) {
    await assert.rejects(() => sheets.getRows('test_sheet'));
  }

  // 閾値超過後は、fetchすら試みず即座に失敗する（サーキットブレーカー作動）
  const start = Date.now();
  await assert.rejects(
    () => sheets.getRows('test_sheet'),
    /サーキットブレーカー作動中/
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `ブレーカー作動時は即時失敗すべき（実測: ${elapsed}ms）`);
});

test('サーキットブレーカー: リセット後は通常のtimeout/retry経路に戻る', async (t) => {
  const restore = installFailingFetch();
  t.after(restore);

  sheets._resetCircuitBreaker();
  const start = Date.now();
  await assert.rejects(() => sheets.getRows('test_sheet'));
  const elapsed = Date.now() - start;
  // 通常経路は1回リトライ前の1秒バックオフを挟むため、ブレーカー作動時より明確に遅い
  assert.ok(elapsed >= 900, `リセット後は通常のretry遅延を経るべき（実測: ${elapsed}ms）`);
});

test('サーキットブレーカー: 成功時は連続失敗カウントがリセットされる', async (t) => {
  sheets._resetCircuitBreaker();
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    if (callCount <= 2) throw new Error('simulated failure');
    return { ok: true, json: async () => ([]) };
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(() => sheets.getRows('test_sheet')); // 1回目失敗
  await assert.doesNotReject(() => sheets.getRows('test_sheet')); // 2回目成功 → カウントリセット

  // 以降また失敗させても、直前の成功でカウントがリセットされているため
  // 閾値未満の失敗ではブレーカーは作動しない（通常のエラーメッセージになる）
  global.fetch = async () => { throw new Error('simulated failure again'); };
  let caught = null;
  try {
    await sheets.getRows('test_sheet');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'エラーが発生するべき');
  assert.ok(!/サーキットブレーカー/.test(caught.message), `ブレーカー作動メッセージであってはならない: ${caught.message}`);
});
