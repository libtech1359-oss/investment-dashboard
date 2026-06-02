'use strict';

const { execSync }             = require('child_process');
const path                     = require('path');
const { writeLog, writeError } = require('../core/logger');

// D:\AI (git repo root)
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TARGETS = [
  'ai-corp/reports',
  'ai-corp/data/event_log.jsonl',
];

/**
 * reports + event_log を commit して push する
 * @param {string} label  コミットメッセージのラベル (例: 'morning 2026-06-01')
 * @returns {boolean}  コミットが発生したかどうか
 */
function sync(label) {
  try {
    const run = cmd => execSync(cmd, { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim();

    // ステージング
    run(`git add ${TARGETS.join(' ')}`);

    // 差分がなければスキップ
    try {
      run('git diff --cached --exit-code');
      writeLog('gitSync', `変更なし — スキップ: ${label}`);
      return false;
    } catch {
      // exit code 1 = 差分あり → 続行
    }

    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    const msg  = `auto: ${label} ${date}`;

    run(`git commit -m "${msg}"`);
    run('git push origin main');

    writeLog('gitSync', `push 完了: ${msg}`);
    return true;

  } catch (err) {
    writeError('gitSync', err);
    return false;
  }
}

module.exports = { sync };
