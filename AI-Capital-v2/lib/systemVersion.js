'use strict';

/**
 * systemVersion.js — AI Capital バージョン管理
 *
 * config/systemVersion.json を唯一の正本とする（package.jsonはnpmのメタデータであり、
 * AI Capitalの「対外的な版数」とは意味が異なるため分離した）。
 * 重大変更（development.MAJOR_EVENT_TYPES 該当）が自動検出された時のみ、
 * scripts/auto-devlog.js から bumpMinor() が呼ばれ、マイナーバージョンが繰り上がる。
 *
 *   例: 2.3.0 → 2.4.0（パッチ番号は常に0にリセットし、意味を持たせない）
 *
 * 表示用の短縮形（例: "v2.4"）は toDisplay() で得られる。Weekly記事はこの表示形式を使う。
 * history には過去の全バンプが (version, date, reason) で積み上がる — CHANGELOG.mdの
 * 機械可読版に相当し、development_logs側の記録と突き合わせる際の正本になる。
 */

const fs   = require('fs');
const path = require('path');

const VERSION_PATH = path.join(__dirname, '../config/systemVersion.json');

function nowJSTTimestamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ');
}

function readFile() {
  if (!fs.existsSync(VERSION_PATH)) {
    return { version: '2.0.0', updated_at: null, history: [] };
  }
  const data = JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8'));
  if (!Array.isArray(data.history)) data.history = [];
  return data;
}

function writeFile(data) {
  fs.writeFileSync(VERSION_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || '0.0.0');
  if (!m) return { major: 0, minor: 0, patch: 0 };
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function toDisplay({ major, minor }) {
  return `v${major}.${minor}`;
}

/**
 * 現在のバージョンを取得する
 * @returns {{ major: number, minor: number, patch: number, raw: string, display: string }}
 */
function getVersion() {
  const data = readFile();
  const semv = parseSemver(data.version);
  return { ...semv, raw: data.version, display: toDisplay(semv) };
}

/**
 * マイナーバージョンを1つ繰り上げる（重大変更検出時のみ呼ぶ）
 * @param {string} [reason] - なぜ繰り上げたか（development_logsのtitle等）。historyに記録される。
 * @returns {{ previous: {raw:string,display:string}, next: {raw:string,display:string} }}
 */
function bumpMinor(reason) {
  const data = readFile();
  const cur  = parseSemver(data.version);
  const next = { major: cur.major, minor: cur.minor + 1, patch: 0 };
  const nextRaw = `${next.major}.${next.minor}.${next.patch}`;

  const previous = { raw: data.version, display: toDisplay(cur) };
  const updatedAt = nowJSTTimestamp();

  data.version    = nextRaw;
  data.updated_at = updatedAt;
  data.history.push({ version: nextRaw, date: updatedAt, reason: reason || null });
  writeFile(data);

  return { previous, next: { raw: nextRaw, display: toDisplay(next) } };
}

module.exports = { VERSION_PATH, getVersion, bumpMinor, toDisplay };
