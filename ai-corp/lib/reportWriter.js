'use strict';

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const TYPE_LABEL  = { morning: '朝', close: '引け後', weekly: '週次' };

function write(type, task) {
  const date  = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const now   = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const label = TYPE_LABEL[type] || type;

  const lines = [
    '# AI投資法人 日次監査レポート',
    `**${date} ${label} | ${task.id}**`,
    '',
  ];

  if (task.market?.content) {
    lines.push('## 市場分析', task.market.content, '');
  }
  if (task.risk?.content) {
    lines.push('## リスク', task.risk.content, '');
  }
  if (task.devil?.content) {
    lines.push("## 反対意見（Devil's Advocate）", task.devil.content, '');
  }
  if (task.audit?.content) {
    lines.push('## 監査');
    if (task.audit.verdict) lines.push(`**判定: ${task.audit.verdict}**`);
    lines.push(task.audit.content, '');
  }

  lines.push('---', `*AI Capital 自動生成 | ${now}*`);

  const dir = path.join(REPORTS_DIR, type);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${date}.md`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

/**
 * publisher agent の出力を公開用ファイルとして保存する
 * @param {string} type  'morning' | 'close' | 'weekly'
 * @param {{ note: string, x: string }} publishResult
 * @returns {{ notePath: string, xPath: string }}
 */
function writePublic(type, publishResult) {
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const dir  = path.join(REPORTS_DIR, type, 'public');
  fs.mkdirSync(dir, { recursive: true });

  const notePath = path.join(dir, `${date}_note.md`);
  const xPath    = path.join(dir, `${date}_x.txt`);

  fs.writeFileSync(notePath, publishResult.note, 'utf8');
  fs.writeFileSync(xPath,    publishResult.x,    'utf8');

  return { notePath, xPath };
}

module.exports = { write, writePublic };
