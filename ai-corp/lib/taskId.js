'use strict';

const fs   = require('fs');
const path = require('path');

const COUNTER_FILE = path.join(__dirname, '..', 'data', 'task-counter.json');

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/-/g, '');
}

function generateId() {
  const dir = path.dirname(COUNTER_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let counter = { date: '', seq: 0 };
  if (fs.existsSync(COUNTER_FILE)) {
    try { counter = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')); } catch (_) {}
  }

  const today = todayStr();
  if (counter.date !== today) counter = { date: today, seq: 0 };
  counter.seq++;

  fs.writeFileSync(COUNTER_FILE, JSON.stringify(counter), 'utf8');
  return `task-${today}-${String(counter.seq).padStart(3, '0')}`;
}

module.exports = { generateId };
