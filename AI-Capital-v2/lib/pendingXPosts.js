'use strict';

/**
 * pendingXPosts.js — Discordの「Xに投稿」ボタンから参照するX投稿候補文の一時保存。
 * Discordボタンのcustom_idは100字制限があり本文を直接載せられないため、
 * 短いidだけをcustom_idに埋め込み、本文はこのファイルで引く。
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_FILE = path.join(__dirname, '..', 'data', 'pending_x_posts.json');
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14日超の古い候補は読み込み時に自動整理

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function prune(store) {
  const now = Date.now();
  for (const [id, entry] of Object.entries(store)) {
    if (now - new Date(entry.createdAt).getTime() > MAX_AGE_MS) delete store[id];
  }
  return store;
}

/**
 * @param {string} text X投稿候補文
 * @returns {string} id（Discordボタンのcustom_idに使う短いhex文字列）
 */
function create(text) {
  const store = prune(readAll());
  const id = crypto.randomBytes(6).toString('hex');
  store[id] = { text, status: 'pending', createdAt: new Date().toISOString() };
  writeAll(store);
  return id;
}

function get(id) {
  return readAll()[id] ?? null;
}

function markPosted(id, tweetUrl) {
  const store = readAll();
  if (!store[id]) return;
  store[id].status = 'posted';
  store[id].tweetUrl = tweetUrl;
  store[id].postedAt = new Date().toISOString();
  writeAll(store);
}

module.exports = { create, get, markPosted };
