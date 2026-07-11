'use strict';

/**
 * thumbnailGenerator.js — アイキャッチサムネイル生成
 * ai capital組織.png をベースに記事番号・日付をオーバーレイする。
 * sharp 不要（Playwright でレンダリング）。
 */

const fs   = require('fs');
const path = require('path');

const SOURCE_IMAGE = path.join(__dirname, '../../ai-corp/agents/ai capital組織.png');
const THUMB_DIR    = path.join(__dirname, '../data/thumbnails');

/**
 * @param {string} articleId  例: AC-2026-0001
 * @param {string} date       例: 2026-06-25
 * @returns {Promise<string>} 生成した PNG の絶対パス
 */
async function generate(articleId, date) {
  const { chromium } = require('playwright');

  if (!fs.existsSync(SOURCE_IMAGE)) {
    throw new Error(`組織画像が見つかりません: ${SOURCE_IMAGE}`);
  }

  const imgBase64  = fs.readFileSync(SOURCE_IMAGE).toString('base64');
  const [, mm, dd] = date.split('-');
  const dateLabel  = `${mm}/${dd}`;
  const idLabel    = articleId.replace('AC-', '#');

  const W = 1280, H = 640;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;overflow:hidden;width:${W}px;height:${H}px">
<div style="position:relative;width:${W}px;height:${H}px">
  <img src="data:image/png;base64,${imgBase64}"
       style="width:100%;height:100%;object-fit:cover;display:block">
  <div style="
    position:absolute;top:20px;right:20px;
    background:rgba(0,0,0,0.62);
    border-radius:12px;
    padding:14px 24px;
    text-align:center;
    min-width:160px;
  ">
    <div style="color:#fff;font-size:32px;font-weight:bold;font-family:sans-serif;line-height:1.2">${dateLabel}</div>
    <div style="color:#90c4ff;font-size:18px;font-family:sans-serif;margin-top:6px">${idLabel}</div>
  </div>
</div>
</body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: W, height: H });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    const outPath = path.join(THUMB_DIR, `${articleId}.png`);
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: W, height: H } });
    return outPath;
  } finally {
    await browser.close();
  }
}

module.exports = { generate };
