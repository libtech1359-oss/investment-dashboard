'use strict';

const fs       = require('fs');
const path     = require('path');
const eventLog = require('./eventLog');

const STATE_FILE = path.join(__dirname, '..', 'system_state.json');
const SAFE_DEFAULT = { trading_enabled: false };

function read() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    // ファイル消失・破損時は安全側（停止）に倒す
    return { ...SAFE_DEFAULT };
  }
}

function write(updates) {
  const next = { ...read(), ...updates };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// trading_enabled が明示的に true の時だけ許可、それ以外はすべて停止
function isHalted() {
  return read().trading_enabled !== true;
}

function halt(reason = 'manual_stop', by = 'unknown', meta = {}) {
  const at = new Date().toISOString();
  eventLog.append({ event: 'halt', reason, by, at, ...meta });
  return write({ trading_enabled: false, halt_reason: reason, halted_by: by, halted_at: at });
}

function resume(by = 'unknown', meta = {}) {
  const at = new Date().toISOString();
  eventLog.append({ event: 'resume', by, at, ...meta });
  return write({ trading_enabled: true, halt_reason: null, halted_by: null, halted_at: null, resumed_by: by, resumed_at: at });
}

module.exports = { read, isHalted, halt, resume };
