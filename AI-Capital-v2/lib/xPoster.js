'use strict';

/**
 * X（旧Twitter）投稿モジュール。
 * OAuth 1.0a ユーザーコンテキスト（API Key/Secret + Access Token/Secret）で
 * POST /2/tweets を叩く。X Developer Portal で作成したAppの認証情報が必要。
 */

const { TwitterApi } = require('twitter-api-v2');

function getClient() {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    throw new Error('X API認証情報が未設定です（.envのX_API_KEY等を確認してください）');
  }
  return new TwitterApi({
    appKey:       X_API_KEY,
    appSecret:    X_API_SECRET,
    accessToken:  X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_SECRET,
  });
}

/**
 * @param {string} text 投稿本文（280字制限はX側で検証される）
 * @returns {Promise<{ id: string, url: string }>}
 */
async function postTweet(text) {
  const client = getClient();
  const { data } = await client.v2.tweet(text);
  return { id: data.id, url: `https://x.com/i/web/status/${data.id}` };
}

module.exports = { postTweet };
