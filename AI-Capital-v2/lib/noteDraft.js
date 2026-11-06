'use strict';

/**
 * note.com 下書き自動保存モジュール（v2用）
 * 事前に `node lib/noteLogin.js` でセッションを保存しておく必要がある。
 */

const path = require('path');
const fs   = require('fs');

const SESSION_FILE = path.join(__dirname, '../data/note_session.json');

function log(msg) { console.log(`[noteDraft] ${msg}`); }

function extractTitle(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : 'AI Capital市場会議';
}

function extractBody(markdown) {
  return markdown.replace(/^#\s+.+\n\n?/, '').trim();
}

async function closeCropModalIfOpen(page) {
  try {
    const overlay = page.locator('.CropModal__overlay, [class*="CropModal"], [class*="cropModal"]').first();
    if (!await overlay.isVisible({ timeout: 1500 }).catch(() => false)) return false;
    log('CropModal 検出 → 「保存」でクロップ確定');
    const saveBtn = page.locator('button:has-text("保存")').last();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(3000);
      return true;
    }
    const cancelBtn = page.locator('button:has-text("キャンセル")').last();
    if (await cancelBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await cancelBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch (_) {}
  return false;
}

/**
 * 本文中のマーカー位置に画像を挿入する（DragEvent 方式）
 * Playwright ネイティブ API で要素座標を取得し、ウィンドウスクロールを正確にリセットする。
 * @param {Page} page
 * @param {string} marker  例: '▼HISTORY▼'
 * @param {string|null} imagePath
 * @returns {Promise<boolean>}
 */
async function insertImage(page, marker, imagePath) {
  async function removeMarker() {
    try {
      await page.evaluate((m) => {
        const ed = document.querySelector('.ProseMirror');
        if (!ed) return;
        const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent.includes(m)) {
            node.textContent = node.textContent.replace(m, '');
            return;
          }
        }
      }, marker);
    } catch (_) {}
  }

  // 画像挿入後にマーカー段落をSelection+キーボード操作で削除する
  // textContent直接操作はProseMirrorがセレクションをリセットするため使わない
  async function cleanupMarkerParagraph() {
    try {
      const found = await page.evaluate((m) => {
        const ed = document.querySelector('.ProseMirror');
        if (!ed) return false;
        const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent.includes(m)) {
            const parent = node.parentElement || ed;
            // 段落全体を選択（ProseMirrorのキーボードハンドラに任せる）
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(parent);
            sel.removeAllRanges();
            sel.addRange(range);
            return true;
          }
        }
        return false;
      }, marker);
      if (found) {
        log(`[debug] マーカー段落を選択 → Delete+Backspace で除去 [${marker}]`);
        await page.waitForTimeout(100);
        await page.keyboard.press('Delete');    // マーカーテキストを削除（段落は空になる）
        await page.waitForTimeout(300);         // ProseMirrorの再描画を待つ
        await page.keyboard.press('Backspace'); // 空段落を削除
        await page.waitForTimeout(300);
      } else {
        log(`[debug] マーカーテキスト見つからず（分割済み or 挿入に吸収）[${marker}]`);
      }
    } catch (_) {}
  }

  if (!imagePath || !fs.existsSync(imagePath)) {
    log(`画像なし → マーカー除去: ${marker}`);
    await removeMarker();
    return false;
  }

  log(`画像挿入開始 [${marker}]: ${path.basename(imagePath)}`);

  const imgBefore = await page.evaluate(() =>
    document.querySelectorAll('.ProseMirror img').length
  ).catch(() => 0);

  try {
    // ① scrollIntoView でスクロールコンテナ（window/カスタムdiv問わず）をスクロール → 再計測
    const posInfo = await page.evaluate(async ({ markerText }) => {
      const ed = document.querySelector('.ProseMirror');
      if (!ed) return null;
      const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.includes(markerText)) {
          const parent = node.parentElement || ed;
          // note.com が独自スクロールコンテナを使っていても正しくスクロールされる
          parent.scrollIntoView({ block: 'center', behavior: 'instant' });
          await new Promise(r => setTimeout(r, 400));
          // テキストノード自身の Rect（同一 <p> 内の2行目でも正確に取れる）
          const range = document.createRange();
          range.selectNodeContents(node);
          const tRect = range.getBoundingClientRect();
          const pRect = parent.getBoundingClientRect();
          return {
            cx:  pRect.left + pRect.width / 2,
            cy:  tRect.top + tRect.height / 2,
            tag: parent.tagName,
            ph:  parent.offsetHeight,
          };
        }
      }
      return null;
    }, { markerText: marker });

    if (!posInfo) {
      log(`DragEvent失敗 [${marker}]: no-marker`);
      return false;
    }
    log(`[debug] ${marker}: tag=${posInfo.tag} ph=${posInfo.ph} cx=${Math.round(posInfo.cx)} cy=${Math.round(posInfo.cy)}`);

    const cy = posInfo.cy;
    const cx = posInfo.cx;
    log(`[debug] ${marker} drop coords: cx=${Math.round(cx)}, cy=${Math.round(cy)}`);

    // ④ クリックでカーソルをマーカー段落に移動（マーカーは画像挿入後に cleanupMarkerParagraph で削除）
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(150);

    // ⑤ DataTransfer + DragEvent で画像ドロップ（正確な座標を渡す）
    const b64 = fs.readFileSync(imagePath).toString('base64');
    const res = await page.evaluate(async ({ b64, x, y }) => {
      try {
        const ed = document.querySelector('.ProseMirror');
        if (!ed) return 'no-editor';
        const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob());
        const file = new File([blob], 'chart.png', { type: 'image/png' });
        const dt   = new DataTransfer();
        dt.items.add(file);
        const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y };
        ed.dispatchEvent(new DragEvent('dragenter', opts));
        await new Promise(r => setTimeout(r, 80));
        ed.dispatchEvent(new DragEvent('dragover',  opts));
        await new Promise(r => setTimeout(r, 80));
        ed.dispatchEvent(new DragEvent('drop',      opts));
        return 'ok';
      } catch (e) { return String(e); }
    }, { b64, x: cx, y: cy });

    if (res === 'ok') {
      await page.waitForTimeout(5000);
      await closeCropModalIfOpen(page);
      await page.waitForTimeout(2000);
      const imgAfter = await page.evaluate(() =>
        document.querySelectorAll('.ProseMirror img').length
      ).catch(() => 0);
      if (imgAfter > imgBefore) {
        await cleanupMarkerParagraph();
        log(`画像挿入完了 [${marker}] (img ${imgBefore}→${imgAfter})`);
        return true;
      }
      log(`drop後 img 数変化なし [${marker}] → リトライ`);
      await page.waitForTimeout(3000);
      const imgRetry = await page.evaluate(() =>
        document.querySelectorAll('.ProseMirror img').length
      ).catch(() => 0);
      if (imgRetry > imgBefore) {
        await cleanupMarkerParagraph();
        log(`画像挿入完了（リトライ） [${marker}] (img ${imgBefore}→${imgRetry})`);
        return true;
      }
      log(`画像挿入失敗 [${marker}]`);
      return false;
    }
    log(`DragEvent失敗 [${marker}]: ${res}`);
  } catch (e) {
    log(`DragEvent エラー [${marker}]: ${e.message}`);
  }

  await removeMarker();
  return false;
}

/**
 * アイキャッチ画像をアップロードする
 * note.com UI: 「画像を追加」→「画像をアップロード」の2ステップ
 */
async function uploadEyecatch(page, thumbPath) {
  if (!thumbPath || !fs.existsSync(thumbPath)) {
    log('アイキャッチ: 画像なし（スキップ）');
    return false;
  }
  log(`アイキャッチアップロード開始: ${path.basename(thumbPath)}`);
  try {
    const eyecatchBtn = page.locator('[aria-label="画像を追加"]').first();
    await eyecatchBtn.waitFor({ state: 'visible', timeout: 8000 });
    await eyecatchBtn.click();
    await page.waitForTimeout(500);

    const uploadOption = page.locator('button:has-text("画像をアップロード")').first();
    await uploadOption.waitFor({ state: 'visible', timeout: 5000 });
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      uploadOption.click(),
    ]);
    await fc.setFiles(thumbPath);
    await page.waitForTimeout(5000);
    await closeCropModalIfOpen(page);
    log('アイキャッチアップロード完了');
    return true;
  } catch (e) {
    log(`アイキャッチアップロード失敗（スキップ）: ${e.message.slice(0, 80)}`);
    return false;
  }
}

/**
 * テキストを ProseMirror 向け HTML に変換する
 * \n\n → </p><p>（段落区切り）
 * \n   → <br>（ソフト改行）
 */
function textToEditorHtml(text) {
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return text
    .split(/\n{2,}/)
    .filter(seg => seg.trim())
    .map(seg => {
      // `▼HR▼` だけの段落はnoteの区切り線（<hr>）にする（Markdownの `---` は記事検証Rule 9で禁止のため専用マーカー）
      if (seg.trim() === '▼HR▼') return '<hr>';
      const inner = seg.split('\n').map(esc).join('<br>');
      return `<p>${inner}</p>`;
    })
    .join('');
}

/**
 * 本文を HTML として ProseMirror に直接注入する
 * insertText + Enter では段落が作られないため innerHTML を使う。
 * ProseMirror の MutationObserver が変更を検知して段落構造を正規化する。
 */
async function insertViaHtml(page, text) {
  const html = textToEditorHtml(text);
  await page.evaluate((html) => {
    const ed = document.querySelector('.ProseMirror');
    if (!ed) return;
    ed.innerHTML = html;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }, html);
  await page.waitForTimeout(1500);
}

/**
 * URLだけの段落をnoteのリンクカード（external-article埋め込み）に変換する。
 * innerHTML一括注入ではURLがただのテキストのままになるため、エディタ上でURLを
 * 打ち直してEnterを押し、note標準の自動カード化を発火させる。
 * 失敗しても記事本体は壊れない（URLテキストのまま残る）ので例外は握りつぶして false を返す。
 */
async function embedLinkCards(page, urlPrefix = 'https://note.com/') {
  let done = 0;
  try {
    const urls = await page.evaluate((prefix) =>
      [...document.querySelectorAll('.ProseMirror > p')]
        .map(p => p.textContent.trim())
        .filter(t => t.startsWith(prefix) && !/\s/.test(t)),
      urlPrefix);
    for (const url of urls) {
      const para = page.locator('.ProseMirror > p', { hasText: url }).first();
      if (!(await para.count())) continue;
      await para.scrollIntoViewIfNeeded();
      await para.click();
      // 段落末尾→Shift+Homeで段落全体を選択（Backspace/Deleteは段落結合を起こすので使わない）し、
      // 選択範囲に上書きでURLをタイプ→Enterでnote標準のカード化を発火させる（実機検証済み。
      // pasteイベント方式は選択が無視されて不安定だった）。
      await page.keyboard.press('End');
      await page.keyboard.press('Shift+Home');
      await page.waitForTimeout(300);
      await page.keyboard.type(url, { delay: 5 });
      await page.waitForTimeout(1500);
      await page.keyboard.press('Enter');
      const ok = await page.locator(`.ProseMirror figure[data-src="${url}"]`)
        .first().waitFor({ state: 'attached', timeout: 15000 }).then(() => true).catch(() => false);
      log(ok ? `リンクカード化: ${url}` : `リンクカード化失敗（URLテキストのまま）: ${url}`);
      if (ok) done++;
    }
  } catch (e) {
    log(`リンクカード化エラー（無視して続行）: ${e.message}`);
  }
  return done;
}

/**
 * 「公開に進む」パネルへ遷移し、タグを入力して「投稿する」まで自動で行う。
 * note.com側のUI変更・reCAPTCHA等で失敗した場合は例外を投げる（呼び出し元が
 * 下書き保存へフォールバックする前提）。2026-08-24にヘッドレスで動作確認済みの
 * セレクタを使用しているが、実際に「投稿する」を最後まで押す検証はまだ行っていない
 * （テスト目的で実記事を公開するわけにいかないため）。
 */
async function publishArticle(page, tags) {
  const proceedBtn = page.locator('button:has-text("公開に進む")').first();
  await proceedBtn.waitFor({ state: 'visible', timeout: 10000 });
  await proceedBtn.click();
  await page.waitForTimeout(2000);

  if (tags && tags.length > 0) {
    const tagInput = page.locator('input[placeholder="ハッシュタグを追加する"]').first();
    await tagInput.waitFor({ state: 'visible', timeout: 10000 });
    for (const tag of tags) {
      await tagInput.click();
      await tagInput.type(tag);
      await page.waitForTimeout(400);
      await tagInput.press('Enter');
      await page.waitForTimeout(400);
    }
  }

  const postBtn = page.locator('button:has-text("投稿する")').first();
  await postBtn.waitFor({ state: 'visible', timeout: 10000 });
  await postBtn.click();
  await page.waitForTimeout(1500);

  // 確認ダイアログが追加で出るケースへの保険（未確認のUIパターン）
  const confirmBtn = page.locator('button:has-text("OK"), button:has-text("公開する"), button:has-text("はい")').first();
  if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await confirmBtn.click();
  }

  // 2026-08-24判明: 公開後は note.com/{account}/n/{id} へ遷移すると想定していたが、実際は
  // editor.note.com 上に留まったまま「記事が公開されました」の完了モーダルが表示されるだけ
  // だった。旧実装はpage.waitForURL()のタイムアウトを握りつぶした上でURL形式チェックに
  // かかって「公開失敗」として例外を投げていたが、投稿自体は実際には成功していた
  // （note.com上で確認済み）。URL遷移ではなく完了モーダルの出現で成否を判定する。
  const publishedModal = page.locator('text=記事が公開されました').first();
  const success = await publishedModal
    .waitFor({ state: 'visible', timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  if (!success) {
    throw new Error(`公開完了モーダルが表示されませんでした（現在URL: ${page.url()}）`);
  }

  // editor.note.com/notes/{id}/publish/ 形式の現在URLからnoteIdを抽出し、
  // 公開後の記事URL（note.com/{account}/n/{id}）を構築する（IDはeditor URLと共通）。
  const m = page.url().match(/\/notes\/([a-zA-Z0-9]+)/);
  const noteId  = m ? m[1] : null;
  const account = process.env.NOTE_ID;
  if (!noteId || !account) {
    throw new Error(`公開URLの構築に失敗しました（noteId=${noteId}, account=${account}）`);
  }
  return `https://note.com/${account}/n/${noteId}`;
}

/**
 * note.com に下書き保存、または公開まで行う
 * @param {{ title?: string, body: string, thumbPath?: string, historyChartPath?: string, chartPath?: string,
 *   publish?: boolean, tags?: string[] }} opts
 *   publish=true でもグラフ埋め込みが2枚とも成功しなかった場合は下書き保存にフォールバックする。
 * @returns {{ success: boolean, url: string, historyEmbedded: boolean, chartEmbedded: boolean,
 *   published: boolean, publishError: string|null }}
 *   historyEmbedded/chartEmbedded は対応するimagePathが渡され、実際にnote.comのProseMirror内へ
 *   画像挿入できた場合のみtrue（Graphs Embedded集計に使用）。published=falseの場合、urlは下書きの
 *   編集URL（本人以外アクセス不可）。
 */
async function saveDraft({ title, body, thumbPath, historyChartPath, chartPath, publish = false, tags = [] }) {
  const { chromium } = require('playwright');

  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error('note.com セッション未設定。node lib/noteLogin.js を実行してください。');
  }

  const noteTitle = title || extractTitle(body);
  const noteBody  = extractBody(body);

  log(`開始: "${noteTitle}"`);

  const browser = await chromium.launch({ headless: true });
  let page;

  try {
    const context = await browser.newContext({
      viewport:     { width: 1280, height: 900 },
      userAgent:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      storageState: SESSION_FILE,
    });
    page = await context.newPage();

    log('新規記事ページへ移動');
    await page.goto('https://note.com/notes/new', { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (page.url().includes('/login') || page.url().includes('/signup')) {
      throw new Error('note.com セッション期限切れ。node lib/noteLogin.js を再実行してください。');
    }

    // テキスト記事タイプの選択
    const textTypeBtn = page.locator('button:has-text("テキスト"), a:has-text("テキスト"), [data-type="text"]').first();
    if (await textTypeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await textTypeBtn.click();
      await page.waitForTimeout(2000);
    }

    // アイキャッチアップロード
    await uploadEyecatch(page, thumbPath || null);

    // タイトル入力
    log('タイトル入力');
    const titleLocator = page.locator([
      'textarea[placeholder*="タイトル"]',
      'input[placeholder*="タイトル"]',
      '[data-placeholder*="タイトル"]',
      '.p-title__textarea',
    ].join(', ')).first();
    await titleLocator.waitFor({ state: 'visible', timeout: 15000 });
    await titleLocator.click();
    await titleLocator.fill(noteTitle);

    // 本文入力
    log('本文入力');
    const bodyLocator = page.locator([
      '.ProseMirror',
      '[class*="editor__body"] [contenteditable="true"]',
      'div[contenteditable="true"]:not([class*="title"])',
    ].join(', ')).first();
    await bodyLocator.waitFor({ state: 'visible', timeout: 15000 });
    await bodyLocator.click();
    await page.waitForTimeout(300);
    // マーカーを独立 <p> に配置（scrollIntoView で正確な座標を取得するため）
    const processedBody = noteBody
      .replace(/\n*(▼[A-Z]+▼)\n*/g, '\n\n$1\n\n')
      .replace(/\n{3,}/g, '\n\n');
    await insertViaHtml(page, processedBody);
    await embedLinkCards(page);

    // 段落数デバッグ
    const pCount = await page.evaluate(() =>
      document.querySelectorAll('.ProseMirror > *').length
    ).catch(() => 0);
    log(`[debug] editor child count after insert: ${pCount}`);

    // 画像挿入: ▼HISTORY▼ → 面グラフ（上段）、▼CHART▼ → 円グラフ（ファンドセクション）
    // 戻り値（true/false）は呼び出し元がGraphs Embeddedの集計に使うため必ず捕捉する。
    const historyEmbedded = await insertImage(page, '▼HISTORY▼', historyChartPath || null);
    // 1枚目挿入後: エディタ状態を安定させてから2枚目を試みる
    await page.waitForTimeout(4000);
    try {
      // ページ最下部にスクロールして ▼CHART▼ を表示させてからフォーカスリセット
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
      await page.click('.ProseMirror');
      await page.waitForTimeout(1500);
    } catch (_) {}
    const chartEmbedded = await insertImage(page, '▼CHART▼', chartPath || null);

    await closeCropModalIfOpen(page);

    // グラフが両方きちんと埋め込めた場合のみ「公開に進む」を試みる。片方でも埋め込みに
    // 失敗していれば、publish=trueが渡されていても下書き保存にフォールバックする
    // （embed成否はここまでの処理結果でしか判定できないため、呼び出し元では判断できない）。
    let finalUrl;
    let published = false;
    let publishError = null;

    if (publish && historyEmbedded && chartEmbedded) {
      try {
        finalUrl = await publishArticle(page, tags);
        published = true;
        log(`公開完了: ${finalUrl}`);
      } catch (err) {
        publishError = err.message;
        log(`公開失敗のため下書き保存にフォールバックします: ${err.message}`);
        try {
          const dbgPath = path.join(__dirname, '../data/note_publish_debug.png');
          await page.screenshot({ path: dbgPath, fullPage: true });
          log(`公開失敗デバッグスクリーンショット: ${dbgPath}`);
        } catch (_) {}
        // 公開設定パネルが開いたままの場合はエディタへ戻す
        const cancelBtn = page.locator('button:has-text("キャンセル")').first();
        if (await cancelBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await cancelBtn.click();
          await page.waitForTimeout(1000);
        }
      }
    }

    if (!published) {
      // 下書き保存
      log('下書き保存ボタンをクリック');
      const saveBtnLocator = page.locator([
        'button:has-text("下書き保存")',
        'button:has-text("下書きに保存")',
        '[aria-label="下書き保存"]',
      ].join(', ')).first();

      try {
        await saveBtnLocator.waitFor({ state: 'visible', timeout: 10000 });
        await saveBtnLocator.click();
        await page.waitForTimeout(3000);
        finalUrl = page.url();
        log(`下書き保存完了: ${finalUrl}`);
      } catch (_) {
        finalUrl = page.url();
        if (!finalUrl.includes('/new') && finalUrl.includes('note.com')) {
          log(`auto-saved とみなす (URL: ${finalUrl})`);
        } else {
          throw new Error(`下書き保存ボタン未検出 (URL: ${finalUrl})`);
        }
      }
    }

    await context.storageState({ path: SESSION_FILE });
    // historyEmbedded/chartEmbedded: 対応するchartPathが渡されなかった場合はinsertImage()が
    // false（画像なし→マーカー除去のみ）を返す。呼び出し元は渡したパスの有無と合わせて判定すること。
    return { success: true, url: finalUrl, historyEmbedded, chartEmbedded, published, publishError };

  } catch (err) {
    try {
      if (page) {
        const dbgPath = path.join(__dirname, '../data/note_debug.png');
        await page.screenshot({ path: dbgPath, fullPage: false });
        log(`デバッグスクリーンショット: ${dbgPath}`);
      }
    } catch (_) {}
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { saveDraft, extractTitle, extractBody };
