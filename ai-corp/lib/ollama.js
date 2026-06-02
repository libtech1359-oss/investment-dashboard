'use strict';

const { Ollama } = require('ollama');

const client = new Ollama({
  host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
});

const MODEL = process.env.OLLAMA_MODEL || 'gemma4:e4b';

/**
 * Ollamaにチャットリクエストを送る共通ラッパー
 * @param {string} system  - システムプロンプト
 * @param {string} user    - ユーザーメッセージ
 * @param {object} opts    - Ollamaオプション上書き（temperature等）
 * @returns {Promise<string>} AIの返答テキスト
 */
async function ask(system, user, opts = {}) {
  const response = await client.chat({
    model: MODEL,
    think: false,
    options: {
      temperature: 0.3,
      num_predict: 600,
      ...opts,
    },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user   },
    ],
  });
  return response.message.content.trim();
}

module.exports = { ask };
