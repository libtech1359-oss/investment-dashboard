'use strict';
require('dotenv').config();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, 'data/note_session.json');
const DRAFT_URL = 'https://editor.note.com/notes/nc81d93879580/edit/';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    storageState: SESSION_FILE,
  });
  const page = await context.newPage();
  await page.goto(DRAFT_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 本文テキストを取得
  const bodyText = await page.evaluate(() => {
    const ed = document.querySelector('.ProseMirror');
    return ed ? ed.innerText : '(editor not found)';
  });

  // 画像位置を確認（スクロールをトップに戻してから測定）
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  const imgInfo = await page.evaluate(() => {
    const ed = document.querySelector('.ProseMirror');
    if (!ed) return [];
    const imgs = ed.querySelectorAll('img, figure');
    return Array.from(imgs).map((el, i) => {
      const rect = el.getBoundingClientRect();
      return { index: i, tag: el.tagName, top: Math.round(rect.top), alt: el.alt || el.src?.slice(-20) || '' };
    });
  });

  console.log('=== 記事テキスト（先頭500文字）===');
  console.log(bodyText.slice(0, 500));
  console.log('\n=== 記事テキスト（末尾500文字）===');
  console.log(bodyText.slice(-500));
  console.log('\n=== 全文文字数 ===', bodyText.length);
  console.log('\n=== 画像位置 ===');
  console.log(JSON.stringify(imgInfo, null, 2));

  // スクリーンショット
  await page.screenshot({ path: path.join(__dirname, 'data/draft_check_top.png'), fullPage: false });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, 'data/draft_check_mid.png'), fullPage: false });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, 'data/draft_check_btm.png'), fullPage: false });

  // 全文も保存
  fs.writeFileSync(path.join(__dirname, 'data/draft_body.txt'), bodyText, 'utf8');
  console.log('\n全文を data/draft_body.txt に保存しました');

  await browser.close();
})();
