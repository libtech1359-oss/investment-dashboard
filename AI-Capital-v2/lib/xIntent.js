'use strict';

/**
 * xIntent.js — X（旧Twitter）の「投稿画面を開くリンク」を生成する。
 *
 * 経緯: X API の POST /2/tweets が 2026-08-26 以降 HTTP 402（Payment Required）を
 * 返すようになり（無料枠の書き込みアクセス喪失）、自動投稿もDiscordの投稿ボタンも
 * すべて失敗するようになった。$200/月の有料プランは個人運用では非現実的なため、
 * 「生成済みの予告編テキスト入りでXの投稿画面が開くリンクを1タップ踏む」運用へ切替。
 *
 * Web Intent はAPIキー不要・課金不要で、スマホではXアプリの投稿画面が
 * 本文プリセット済みで開く（送信前に編集も可能）。
 */

// Discordのメッセージ本文上限（2000字）に対する安全マージン。
const DISCORD_LIMIT = 1900;

// X Web Intent。twitter.com/intent/tweet も同義だが、現行の推奨ドメインは x.com。
function buildIntentUrl(text) {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

// 予告編テキストをそのまま見せるコードブロック（コピペ用フォールバックも兼ねる）。
function buildTextBlock(text) {
  return `📝 **X投稿候補**\n\`\`\`\n${text}\n\`\`\``;
}

// ワンタップ投稿リンクの1行。URLがDiscord上限を超える長文ツイートの場合は
// リンクを貼れないため null を返し、呼び出し側はコピペ運用にフォールバックする。
function buildIntentLine(text) {
  const url = buildIntentUrl(text);
  if (url.length > DISCORD_LIMIT) return null;
  return `▶ ワンタップ投稿（Xの投稿画面が開きます）: ${url}`;
}

/**
 * 単独メッセージとして送る前提の通知本文（テキストブロック＋リンク行）。
 * scheduler.js の notifyXCandidate() が使用。
 */
function buildCandidateMessage(text) {
  const line = buildIntentLine(text);
  return line
    ? `${buildTextBlock(text)}\n${line}`
    : `${buildTextBlock(text)}\n（本文が長いためリンク生成不可。上のテキストをコピーしてXに貼り付けてください）`;
}

module.exports = { buildIntentUrl, buildTextBlock, buildIntentLine, buildCandidateMessage };
