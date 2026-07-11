'use strict';

/**
 * note.com 初回ログイン用スクリプト
 * headful でブラウザを起動し、手動ログイン後にセッションを保存する。
 * 初回または期限切れ時に一度だけ実行する。
 *
 *   node lib/noteLogin.js
 */

const path = require('path');
const SESSION_FILE = path.join(__dirname, '../data/note_session.json');

async function main() {
  const { chromium } = require('playwright');

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await context.newPage();

  await page.goto('https://note.com/login', { waitUntil: 'domcontentloaded' });

  console.log('\n============================================');
  console.log('  ブラウザが開きました。');
  console.log('  note.com にログインしてください。');
  console.log('  ログイン後、自動的にセッションが保存されます。');
  console.log('  タイムアウト: 5分');
  console.log('============================================\n');

  await page.waitForURL(
    url => !url.href.includes('/login') && !url.href.includes('/signup'),
    { timeout: 300000 }
  );

  console.log(`ログイン完了: ${page.url()}`);
  await context.storageState({ path: SESSION_FILE });
  console.log(`セッション保存済み: ${SESSION_FILE}`);
  await browser.close();
  console.log('完了。次回から note.com への自動下書き保存が利用できます。');
}

main().catch(err => { console.error('エラー:', err.message); process.exit(1); });
