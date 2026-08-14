'use strict';

/**
 * health.js — watchdog.js と index.js/scheduler.js が共有するハートビートファイルの読み書き
 */

const fs   = require('fs');
const path = require('path');

const HEARTBEAT_FILE = path.join(__dirname, '..', 'data', 'health_heartbeat.json');

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeHeartbeat(partial) {
  const current = readHeartbeat() ?? {};
  const next = {
    ...current,
    ...partial,
    pid:       process.pid,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(next, null, 2));
  return next;
}

// heartbeatの pipelineRunning:true が「stale」（既に死んだ別プロセスの残留データ）かどうかを
// 判定する。単体テスト可能にするため index.js のリセット処理から分離（2026-08-14追加）。
// pidMismatch: 多重起動防止（index.jsの.pidロック）により、この判定を呼ぶ時点で「同名アプリの
//   生きたプロセスは自分だけ」が保証されているため、heartbeat.pid が currentPid と異なれば
//   100%別（既に死んだ）インスタンスの残留データと判定できる。
// tooOld: pid欠落等の想定外ケースに備えた時間ベースの保険（既定3時間＝通常のパイプラインが
//   超えることはない）。
function isHeartbeatStale(hb, currentPid, staleMs = 3 * 60 * 60 * 1000) {
  if (!hb || !hb.pipelineRunning) return false;
  const pidMismatch = hb.pid != null && hb.pid !== currentPid;
  const startedAtMs = hb.pipelineStartedAt ? new Date(hb.pipelineStartedAt).getTime() : null;
  const tooOld       = startedAtMs != null && (Date.now() - startedAtMs) > staleMs;
  return pidMismatch || tooOld;
}

module.exports = { readHeartbeat, writeHeartbeat, HEARTBEAT_FILE, isHeartbeatStale };
