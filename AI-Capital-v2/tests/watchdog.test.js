'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const cp     = require('child_process');

// watchdog.js は `util.promisify(require('child_process').exec)` を require 時点で
// 固定するため、fake pm2 jlist 結果を返す差し替えは watchdog.js を require する前に
// 行う必要がある。
let fakePm2List = [{ name: 'ai-v2-secretary', pm2_env: { status: 'online' }, pid: 999 }];
const originalExec = cp.exec;
cp.exec = (cmd, cb) => {
  if (/pm2 jlist/.test(cmd)) {
    cb(null, { stdout: JSON.stringify(fakePm2List) });
    return;
  }
  return originalExec(cmd, cb);
};

const watchdog = require('../watchdog');
const health   = require('../lib/health');

function setFakePm2(list) { fakePm2List = list; }

test('PIPELINE_STUCK_MS は90分に設定されている（2026-08-14実測に基づく再調整）', () => {
  assert.equal(watchdog.PIPELINE_STUCK_MS, 90 * 60 * 1000);
});

test('fetchWithTimeout: fetchがハングしても指定タイムアウトで中断される（DNS障害の無限待機防止）', async () => {
  const originalFetch = global.fetch;
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    // 実際のDNS障害を模して永久に応答しないfetchを再現。abort時のみ reject する。
    opts?.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });

  const start = Date.now();
  await assert.rejects(
    () => watchdog.fetchWithTimeout('https://discord.com/api/v10/x', {}, 200),
    /AbortError|aborted/i
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `指定タイムアウト(200ms)付近で中断されるべき（実測: ${elapsed}ms）`);

  global.fetch = originalFetch;
});

test('checkHealth: heartbeat.pidがpm2の実pidと一致する場合、長時間runningならハング疑いとして検出する', async () => {
  setFakePm2([{ name: 'ai-v2-secretary', pm2_env: { status: 'online' }, pid: 999 }]);
  const originalReadHeartbeat = health.readHeartbeat;
  health.readHeartbeat = () => ({
    updatedAt: new Date().toISOString(),
    discordStatus: 'connected',
    pipelineRunning: true,
    pipelineTask: 'テストパイプライン',
    pid: 999, // pm2の実pidと一致
    pipelineStartedAt: new Date(Date.now() - 100 * 60 * 1000).toISOString(), // 100分前
  });

  const result = await watchdog.checkHealth();
  health.readHeartbeat = originalReadHeartbeat;

  assert.equal(result.healthy, false);
  assert.ok(result.reasons.some(r => /ハング疑い/.test(r)), 'ハング疑いの理由が含まれるべき');
  assert.equal(result.staleHeartbeat, false);
});

test('checkHealth: heartbeat.pidがpm2の実pidと不一致（stale）の場合はハング扱いにせずSTALE_HEARTBEATとして区別する', async () => {
  setFakePm2([{ name: 'ai-v2-secretary', pm2_env: { status: 'online' }, pid: 999 }]);
  const originalReadHeartbeat = health.readHeartbeat;
  health.readHeartbeat = () => ({
    updatedAt: new Date().toISOString(),
    discordStatus: 'connected',
    pipelineRunning: true,
    pipelineTask: 'テストパイプライン',
    pid: 111, // 別（既に死んだ）プロセスのpid
    pipelineStartedAt: new Date(Date.now() - 100 * 60 * 1000).toISOString(), // 100分前でも
  });

  const result = await watchdog.checkHealth();
  health.readHeartbeat = originalReadHeartbeat;

  assert.equal(result.staleHeartbeat, true, 'stale heartbeatとして区別されるべき');
  assert.ok(!result.reasons.some(r => /ハング疑い/.test(r)), 'stale時はハング疑いの理由を出さないべき');
  assert.equal(result.healthy, true, 'PM2オンライン・Discord接続済みなら健全と判定されるべき');
});

test('checkHealth: 正常時（pid一致・短時間実行）は健全と判定される', async () => {
  setFakePm2([{ name: 'ai-v2-secretary', pm2_env: { status: 'online' }, pid: 999 }]);
  const originalReadHeartbeat = health.readHeartbeat;
  health.readHeartbeat = () => ({
    updatedAt: new Date().toISOString(),
    discordStatus: 'connected',
    pipelineRunning: false,
    pipelineTask: null,
    pid: 999,
    pipelineStartedAt: null,
  });

  const result = await watchdog.checkHealth();
  health.readHeartbeat = originalReadHeartbeat;

  assert.equal(result.healthy, true);
  assert.deepEqual(result.reasons, []);
});

after(() => { cp.exec = originalExec; });
