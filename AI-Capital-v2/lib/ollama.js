'use strict';

const { Ollama } = require('ollama');

// undici カスタムフェッチは think:false が効かなくなる問題があるため使用しない
// （undici 使用時: done_reason=length で全トークンが思考に消費され content が空になる）
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const MODEL = process.env.OLLAMA_MODEL || 'gemma4:e4b';

// 非ストリーミングAPI（client.chat with stream未指定）はollamaパッケージ側にabort手段が
// 一切ないため、サーバー側が応答を返さなくなると永久にハングする（2026-08-06/07に発生）。
// stream:true にして AbortableAsyncIterator 経由で client.abort() できるようにし、
// タイムアウト時は接続を切ってOllama側の生成スロットも解放する。
//
// 2026-08-24判明: 6分という値は「ハング検知」ではなく単に短すぎた。CPU推論オンリー環境
// （user_hardware参照）でnum_ctx 32768の記事生成呼び出しは正常時でも6分を超えることがあり、
// 実際にハングしていないのに毎回abortされていた（watchdog.js側は既に記事生成全体の
// 実測46分を踏まえ90分のstale閾値へ調整済みだったが、個々のOllama呼び出し1回分の
// タイムアウトである本値だけ据え置きだった）。15分に引き上げ、それでも応答がない場合のみ
// 本当のハングとして扱う。
const DEFAULT_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 15 * 60 * 1000;

// 2026-08-20判明: client.abort()はongoingStreamedRequests配列に登録された「ストリーム
// 開始後」のリクエストしか中断できない。従来はタイマーを await client.chat() の後で
// セットしていたため、Ollamaサーバーが初回応答（接続確立）自体を返さなくなった場合
// （サーバー側ハング）はタイムアウトが一切効かず永久に待ち続けていた（2026-08-19/20の
// 記事生成ハングの原因）。fetchに直接AbortSignalを渡し、接続確立からタイムアウト対象に含める。
async function chatOnce(system, user, timeoutMs, ollamaOpts) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => {
    console.warn(`[ollama] ${timeoutMs / 1000}秒応答なし → abort`);
    ctrl.abort();
  }, timeoutMs);

  // 呼び出しごとに使い捨てクライアントを作り、そのfetchにだけ今回のsignalを紐付ける
  // （モジュール単位の共有clientだとsignalを個別のリクエストに割り当てられないため）。
  const client = new Ollama({
    host:  OLLAMA_HOST,
    fetch: (url, opts) => fetch(url, { ...opts, signal: ctrl.signal }),
  });

  try {
    const stream = await client.chat({
      model:  MODEL,
      think:  false,   // トップレベルに置く必要がある（options内では無効）
      stream: true,
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

    let content = '';
    for await (const part of stream) {
      content += part.message?.content || '';
    }
    return content.trim();
  } catch (err) {
    if (err.name === 'AbortError' || /abort/i.test(err.message || '')) {
      throw new Error(`[ollama] タイムアウト（${timeoutMs / 1000}秒応答なし）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function ask(system, user, opts = {}) {
  const { _format, think: _think, timeoutMs = DEFAULT_TIMEOUT_MS, ...ollamaOpts } = opts;

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await chatOnce(system, user, timeoutMs, ollamaOpts);
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
