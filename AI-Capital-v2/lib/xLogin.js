'use strict';

/**
 * X（旧Twitter）初回ログイン用スクリプト
 * headful でブラウザを起動し、手動ログイン後にセッション(cookie)を保存する。
 * 初回または期限切れ時に一度だけ実行する。
 *
 *   node lib/xLogin.js
 *
 * 保存先: data/x_session.json （Playwright storageState 形式）
 * これを使って公開後に x.com/intent/post から自動ポストする（[[lib/xAutoPost.js]]）。
 * X API は使わない（2026-08-26 以降 402 のため）。ブラウザセッションでの投稿。
 */

const path = require('path');
const X_SESSION_FILE = path.join(__dirname, '../data/x_session.json');

async function main() {
  const { chromium } = require('playwright');

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await context.newPage();

  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

  console.log('\n============================================');
  console.log('  ブラウザが開きました。');
  console.log('  X（@AICapital_jp）にログインしてください。');
  console.log('  ホーム(x.com/home)まで進んだら自動保存されます。');
  console.log('  タイムアウト: 5分');
  console.log('============================================\n');

  await page.waitForURL(
    url => /x\.com\/home/.test(url.href) || /x\.com\/[A-Za-z0-9_]+$/.test(url.href),
    { timeout: 300000 }
  );

  console.log(`ログイン完了: ${page.url()}`);
  await context.storageState({ path: X_SESSION_FILE });
  console.log(`セッション保存済み: ${X_SESSION_FILE}`);
  await browser.close();
  console.log('完了。次回の記事公開から X への自動ポストが有効になります。');
}

main().catch(err => { console.error('エラー:', err.message); process.exit(1); });
