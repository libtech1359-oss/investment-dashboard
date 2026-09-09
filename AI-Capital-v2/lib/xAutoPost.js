'use strict';

/**
 * xAutoPost.js — 記事公開後、note が出すのと同等の X 投稿文（記事タイトル＋URL）で
 * x.com/intent/post を開き、ブラウザセッションで「ポスト」まで自動クリックする。
 *
 * X API は使わない（2026-08-26 以降 402）。data/x_session.json（node lib/xLogin.js で作成）の
 * ログイン cookie を note セッションとマージして Playwright に読ませる。
 *
 * セッションが無い／ポストに失敗した場合は {posted:false, intentUrl} を返し、
 * 呼び出し側は従来どおり Discord のワンタップリンクにフォールバックする。
 */

const path = require('path');
const fs   = require('fs');

const NOTE_SESSION_FILE = path.join(__dirname, '../data/note_session.json');
const X_SESSION_FILE    = path.join(__dirname, '../data/x_session.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(m) { console.log(`[xAutoPost] ${m}`); }

function hasXSession() {
  return fs.existsSync(X_SESSION_FILE);
}

/** note と X の storageState を1つにマージ（cookie / origins を結合） */
function mergedStorageState() {
  const read = f => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { cookies: [], origins: [] });
  const a = read(NOTE_SESSION_FILE);
  const b = read(X_SESSION_FILE);
  return {
    cookies: [...(a.cookies || []), ...(b.cookies || [])],
    origins: [...(a.origins || []), ...(b.origins || [])],
  };
}

/** note の X シェアと同等の投稿文。改行区切りでタイトル＋URL。 */
function buildShareText(title, publicUrl) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  return `${t}\n${publicUrl}`;
}

function intentUrl(text) {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

/**
 * @param {{title:string, publicUrl:string, text?:string, dryRun?:boolean, timeoutMs?:number}} opts
 * @returns {Promise<{posted:boolean, intentUrl:string, text:string, reason?:string}>}
 */
async function postToX({ title, publicUrl, text, dryRun = false, timeoutMs = 45000 }) {
  const body = text || buildShareText(title, publicUrl);
  const url  = intentUrl(body);

  if (!hasXSession()) {
    log('x_session.json 無し → 自動ポスト不可（node lib/xLogin.js を実行）');
    return { posted: false, intentUrl: url, text: body, reason: 'no_session' };
  }

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: UA,
      storageState: mergedStorageState(),
    });
    const page = await context.newPage();
    log(`intent を開く: ${url.slice(0, 90)}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(3500);

    // ログインウォールに落ちていないか
    if (/\/i\/flow\/login|\/login|onboarding\/web/.test(page.url())) {
      log('X ログインセッション切れ → node lib/xLogin.js を再実行');
      return { posted: false, intentUrl: url, text: body, reason: 'session_expired' };
    }

    // 本文が composer に載っているか（載っていなければ手打ち）
    const box = page.locator('[data-testid^="tweetTextarea_"]').first();
    if (await box.isVisible({ timeout: 8000 }).catch(() => false)) {
      const cur = (await box.innerText().catch(() => '')) || '';
      if (cur.trim().length < 3) {
        await box.click();
        await page.keyboard.type(body, { delay: 8 });
        await page.waitForTimeout(500);
      }
    } else {
      log('composer が見つからない');
      return { posted: false, intentUrl: url, text: body, reason: 'no_composer' };
    }

    const postBtn = page.locator(
      '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'
    ).first();
    const btnReady = await postBtn.isVisible({ timeout: 8000 }).catch(() => false);
    if (!btnReady) {
      log('ポストボタンが見つからない');
      return { posted: false, intentUrl: url, text: body, reason: 'no_post_button' };
    }

    if (dryRun) {
      log('dryRun: ポストボタン確認までで停止（実投稿しない）');
      return { posted: false, intentUrl: url, text: body, reason: 'dry_run_ok' };
    }

    await postBtn.click();
    // 送信成功 = intent 画面から離脱 or トースト表示 or ボタン消滅
    const ok = await Promise.race([
      page.waitForURL(u => !/\/intent\/post/.test(u.href), { timeout: 15000 }).then(() => true).catch(() => false),
      page.locator('text=/ポストを送信しました|Your post was sent|送信しました/').first()
        .waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false),
      postBtn.waitFor({ state: 'detached', timeout: 15000 }).then(() => true).catch(() => false),
    ]);
    log(ok ? 'ポスト完了' : 'ポスト確認できず（送信された可能性はあり）');
    return { posted: !!ok, intentUrl: url, text: body, reason: ok ? undefined : 'unconfirmed' };
  } catch (e) {
    log(`失敗: ${e.message}`);
    return { posted: false, intentUrl: intentUrl(body), text: body, reason: e.message };
  } finally {
    await browser.close();
  }
}

module.exports = { postToX, buildShareText, intentUrl, hasXSession, mergedStorageState };
