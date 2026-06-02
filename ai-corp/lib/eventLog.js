'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'data', 'event_log.jsonl');

function ensureDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function append(event) {
  ensureDir();
  fs.appendFileSync(LOG_FILE, JSON.stringify(event) + '\n', 'utf8');
}

function read(limit = 50) {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean)
    .slice(-limit)
    .reverse();
}

module.exports = { append, read };
