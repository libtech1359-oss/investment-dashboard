'use strict';

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = path.join(__dirname, '..', 'memory.db');
const db      = new Database(DB_PATH);

// ── テーブル初期化 ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS policies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT    NOT NULL DEFAULT 'general',
    content    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    instruction TEXT   NOT NULL,
    summary    TEXT    NOT NULL,
    fg_value   INTEGER,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );

  CREATE TABLE IF NOT EXISTS memories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );

  CREATE TABLE IF NOT EXISTS ceo_profile (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    profile    TEXT    NOT NULL DEFAULT '{}',
    updated_at TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );

  INSERT OR IGNORE INTO ceo_profile (id, profile) VALUES (1, '{}');
`);

// ── Prepared statements ────────────────────────────────────
const stmt = {
  insertPolicy:   db.prepare("INSERT INTO policies (category, content) VALUES (?, ?)"),
  allPolicies:    db.prepare("SELECT * FROM policies ORDER BY created_at DESC"),
  deletePolicy:   db.prepare("DELETE FROM policies WHERE id = ?"),

  insertDecision: db.prepare("INSERT INTO decisions (session_id, instruction, summary, fg_value) VALUES (?, ?, ?, ?)"),
  recentDecisions:db.prepare("SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?"),
  deleteDecision: db.prepare("DELETE FROM decisions WHERE id = ?"),

  insertNote:     db.prepare("INSERT INTO notes (content) VALUES (?)"),
  allNotes:       db.prepare("SELECT * FROM notes ORDER BY created_at DESC"),
  deleteNote:     db.prepare("DELETE FROM notes WHERE id = ?"),

  insertMemory:   db.prepare("INSERT INTO memories (type, content) VALUES (?, ?)"),
  recentMemories: db.prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT ?"),
  memoriesByType: db.prepare("SELECT * FROM memories WHERE type = ? ORDER BY created_at DESC LIMIT ?"),

  getProfile:     db.prepare("SELECT profile FROM ceo_profile WHERE id = 1"),
  setProfile:     db.prepare("UPDATE ceo_profile SET profile = ?, updated_at = datetime('now', '+9 hours') WHERE id = 1"),
};

// ── policies ───────────────────────────────────────────────
function savePolicy(category, content) {
  return stmt.insertPolicy.run(category, content);
}
function getPolicies() {
  return stmt.allPolicies.all();
}
function deletePolicy(id) {
  return stmt.deletePolicy.run(id);
}

// ── decisions ──────────────────────────────────────────────
function saveDecision(sessionId, instruction, summary, fgValue = null) {
  return stmt.insertDecision.run(sessionId, instruction, summary, fgValue);
}
function getRecentDecisions(limit = 5) {
  return stmt.recentDecisions.all(limit);
}
function deleteDecision(id) {
  return stmt.deleteDecision.run(id);
}

// ── notes ──────────────────────────────────────────────────
function saveNote(content) {
  return stmt.insertNote.run(content);
}
function getNotes() {
  return stmt.allNotes.all();
}
function deleteNote(id) {
  return stmt.deleteNote.run(id);
}

// ── ceo_profile ───────────────────────────────────────────

const DEFAULT_PROFILE = {
  risk_tolerance:     null,   // 'low' | 'medium' | 'high'
  investment_horizon: null,   // 'short' | 'medium' | 'long'
  preferred_sectors:  [],     // ['AI', 'Space', ...]
  excluded_sectors:   [],
  max_drawdown:       null,   // 最大許容下落率(%)
  cash_reserve_min:   null,   // 最低現金(円)
  vix_threshold:      null,   // VIX上限（超えたら買わない）
  fg_buy_zone:        null,   // [下限, 上限] Fear&Greedの買いゾーン
  monthly_investment: null,   // 月次投資額(円)
};

function getCeoProfile() {
  const row = stmt.getProfile.get();
  return { ...DEFAULT_PROFILE, ...JSON.parse(row?.profile || '{}') };
}

function setCeoProfileField(key, value) {
  const profile = getCeoProfile();
  profile[key]  = value;
  stmt.setProfile.run(JSON.stringify(profile));
  return profile;
}

function profileToText(profile) {
  const labels = {
    risk_tolerance:     'リスク許容度',
    investment_horizon: '投資期間',
    preferred_sectors:  '優先セクター',
    excluded_sectors:   '除外セクター',
    max_drawdown:       '最大許容下落率',
    cash_reserve_min:   '最低現金',
    vix_threshold:      'VIX上限',
    fg_buy_zone:        'F&G買いゾーン',
    monthly_investment: '月次投資額',
  };
  const lines = [];
  for (const [k, label] of Object.entries(labels)) {
    const v = profile[k];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    let display = Array.isArray(v) ? v.join(', ') : String(v);
    if (k === 'cash_reserve_min' || k === 'monthly_investment') display = '¥' + Number(v).toLocaleString('ja-JP');
    if (k === 'max_drawdown')    display += '%';
    if (k === 'vix_threshold')   display += '以上で買わない';
    if (k === 'fg_buy_zone')     display = `${v[0]}〜${v[1]}`;
    lines.push(`・${label}: ${display}`);
  }
  return lines.join('\n');
}

// ── memories テーブル ─────────────────────────────────────
function saveMemory(type, content) {
  return stmt.insertMemory.run(type, content);
}
function getRecentMemories(limit = 10) {
  return stmt.recentMemories.all(limit);
}
function getMemoriesByType(type, limit = 5) {
  return stmt.memoriesByType.all(type, limit);
}

// ── エージェントへ渡す記憶コンテキスト ──────────────────────
function buildMemoryContext() {
  const profile   = getCeoProfile();
  const profileTxt = profileToText(profile);
  const policies  = getPolicies();
  const decisions = getRecentDecisions(5);
  const notes     = getNotes();
  const agentMems = getRecentMemories(6);
  const lines     = [];

  // 構造化プロファイルを最優先で提示
  if (profileTxt) {
    lines.push('【CEOプロファイル（構造化）】');
    lines.push(profileTxt);
    lines.push('');
  }

  if (policies.length > 0) {
    lines.push('【CEO方針・投資ルール（テキスト）】');
    policies.forEach(p => lines.push(`・[${p.category}] ${p.content}`));
    lines.push('');
  }

  if (decisions.length > 0) {
    lines.push('【直近の投資判断履歴】');
    decisions.forEach(d => lines.push(`・${d.created_at.slice(0, 10)} 「${d.instruction.slice(0, 30)}…」→ ${d.summary}`));
    lines.push('');
  }

  if (agentMems.length > 0) {
    lines.push('【エージェント分析の記憶】');
    agentMems.forEach(m => lines.push(`・[${m.type}] ${m.content.slice(0, 80)}`));
    lines.push('');
  }

  if (notes.length > 0) {
    lines.push('【CEOメモ】');
    notes.forEach(n => lines.push(`・${n.content}`));
  }

  return lines.join('\n');
}

module.exports = {
  savePolicy, getPolicies, deletePolicy,
  saveDecision, getRecentDecisions, deleteDecision,
  saveNote, getNotes, deleteNote,
  saveMemory, getRecentMemories, getMemoriesByType,
  getCeoProfile, setCeoProfileField, profileToText,
  buildMemoryContext,
};
