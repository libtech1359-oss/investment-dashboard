'use strict';

const fs   = require('fs');
const path = require('path');

const TASKS_DIR = path.join(__dirname, '..', 'data', 'tasks');

function ensureDir() {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function filePath(id) {
  return path.join(TASKS_DIR, `${id}.json`);
}

function create(id, title, source) {
  ensureDir();
  const task = {
    id,
    title: title.slice(0, 100),
    source,
    status: 'running',
    createdAt: new Date().toISOString(),
    completedAt: null,
    decisionId: null,
    secretary:    null,
    market:       null,
    portfolio:    null,
    risk:         null,
    devil:        null,
    audit:        null,
    final_report: null,
  };
  fs.writeFileSync(filePath(id), JSON.stringify(task, null, 2), 'utf8');
  return task;
}

function patch(id, updates) {
  if (!id) return null;
  const file = filePath(id);
  if (!fs.existsSync(file)) return null;
  const task    = JSON.parse(fs.readFileSync(file, 'utf8'));
  const updated = { ...task, ...updates };
  fs.writeFileSync(file, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

function get(id) {
  const file = filePath(id);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function list(limit = 20) {
  ensureDir();
  return fs.readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-limit)
    .reverse()
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')); } catch (_) { return null; } })
    .filter(Boolean);
}

module.exports = { create, patch, get, list };
