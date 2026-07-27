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

module.exports = { readHeartbeat, writeHeartbeat, HEARTBEAT_FILE };
