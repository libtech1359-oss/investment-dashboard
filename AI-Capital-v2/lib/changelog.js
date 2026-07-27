'use strict';

/**
 * changelog.js — CHANGELOG.md 自動更新
 *
 * development_logs へ記録された「重大変更（バージョンが上がった変更）」だけを
 * 反映する。OTHER判定や軽微な変更はCHANGELOGには書かない（development_logs側の
 * 監査ログとしてのみ残る）。scripts/auto-devlog.js からのみ呼ばれる想定。
 *
 * フォーマット（新しいバージョンが先頭・降順）:
 *   ## v2.4 (2026-07-26)
 *   - 総合評価方式へ移行（評価ロジック変更）
 */

const fs   = require('fs');
const path = require('path');

const CHANGELOG_PATH = path.join(__dirname, '../CHANGELOG.md');
const HEADER = [
  '# AI Capital Changelog',
  '',
  'AI Capitalの開発履歴。development_logsで自動検出された重大変更のみを記録する（新しい順）。',
  '',
].join('\n');

function readLines() {
  if (!fs.existsSync(CHANGELOG_PATH)) return HEADER.split('\n');
  return fs.readFileSync(CHANGELOG_PATH, 'utf8').split('\n');
}

/**
 * CHANGELOG.mdへ1エントリ追記する。
 * 同じバージョンの見出しが既にあればその直下に箇条書きを追加、無ければ新規見出しを
 * 先頭（最初の "## " 見出しの直前）に挿入する。
 * @param {{ version: string, date: string, title: string, type: string }} entry
 */
function appendEntry({ version, date, title, type }) {
  const lines   = readLines();
  const heading = `## ${version} (${date})`;
  const bullet  = `- ${title}（${type}）`;

  const headingIdx = lines.findIndex(l => l.trim() === heading);

  if (headingIdx >= 0) {
    let insertAt = headingIdx + 1;
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
    while (insertAt < lines.length && lines[insertAt].startsWith('- ')) insertAt++;
    lines.splice(insertAt, 0, bullet);
  } else {
    const firstHeadingIdx = lines.findIndex(l => l.startsWith('## '));
    const insertAt = firstHeadingIdx >= 0 ? firstHeadingIdx : lines.length;
    const block = insertAt === lines.length
      ? [heading, bullet, '']
      : [heading, bullet, ''];
    lines.splice(insertAt, 0, ...block);
  }

  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
  fs.writeFileSync(CHANGELOG_PATH, out, 'utf8');
}

module.exports = { appendEntry, CHANGELOG_PATH };
