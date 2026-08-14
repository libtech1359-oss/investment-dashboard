'use strict';

// isHeartbeatStale は純粋関数（引数のhbオブジェクトのみを見る）のため、
// 実際の data/health_heartbeat.json には一切触れずに安全にテストできる。
// writeHeartbeat/readHeartbeat（実ファイルI/O）はここでは呼ばない。

const test   = require('node:test');
const assert = require('node:assert/strict');

const { isHeartbeatStale } = require('../lib/health');

test('isHeartbeatStale: pipelineRunning=false なら常にfalse', () => {
  assert.equal(isHeartbeatStale({ pipelineRunning: false, pid: 111 }, 999), false);
  assert.equal(isHeartbeatStale(null, 999), false);
  assert.equal(isHeartbeatStale(undefined, 999), false);
});

test('isHeartbeatStale: pidが現在のプロセスと一致し、開始直後ならfalse（実際に稼働中）', () => {
  const hb = {
    pipelineRunning: true,
    pid: 999,
    pipelineStartedAt: new Date().toISOString(),
  };
  assert.equal(isHeartbeatStale(hb, 999), false);
});

test('isHeartbeatStale: pidが現在のプロセスと異なればtrue（再起動後の残留データ）', () => {
  const hb = {
    pipelineRunning: true,
    pid: 111, // 別（既に死んだ）プロセスのpid
    pipelineStartedAt: new Date().toISOString(), // 開始直後でもpid不一致なら残留データ
  };
  assert.equal(isHeartbeatStale(hb, 999), true);
});

test('isHeartbeatStale: pidが一致していても、staleMsを大幅に超えていればtrue（保険）', () => {
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const hb = {
    pipelineRunning: true,
    pid: 999,
    pipelineStartedAt: fourHoursAgo,
  };
  assert.equal(isHeartbeatStale(hb, 999, 3 * 60 * 60 * 1000), true);
});

test('isHeartbeatStale: pidが一致し、staleMs未満ならfalse（正常に長時間実行中の可能性）', () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const hb = {
    pipelineRunning: true,
    pid: 999,
    pipelineStartedAt: oneHourAgo,
  };
  assert.equal(isHeartbeatStale(hb, 999, 3 * 60 * 60 * 1000), false);
});
