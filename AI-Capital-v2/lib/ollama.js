'use strict';

const { Ollama } = require('ollama');

// undici カスタムフェッチは think:false が効かなくなる問題があるため使用しない
// （undici 使用時: done_reason=length で全トークンが思考に消費され content が空になる）
const client = new Ollama({
  host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
});

const MODEL = process.env.OLLAMA_MODEL || 'gemma4:e4b';

async function ask(system, user, opts = {}) {
  const { _format, think: _think, ...ollamaOpts } = opts;

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat({
        model:  MODEL,
        think:  false,   // トップレベルに置く必要がある（options内では無効）
        options: {
          temperature: 0.3,
          num_predict: 3000,
          num_ctx:     16384,
          ...ollamaOpts,
        },
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user   },
        ],
      });
      return response.message.content.trim();
    } catch (err) {
      if (attempt < MAX_RETRIES && err.message?.includes('fetch failed')) {
        const wait = 5000 * (attempt + 1);
        console.warn(`[ollama] retry ${attempt + 1}/${MAX_RETRIES} in ${wait / 1000}s`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { ask };
