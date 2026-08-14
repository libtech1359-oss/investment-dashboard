'use strict';

/**
 * index.js は多重起動防止（.pidロック）・Discordログイン・DISCORD_TOKEN未設定時のprocess.exit(1)
 * など起動時副作用を持つため、require()して直接実行するのは安全ではない。
 * そのため、/v2-article ハンドラがStep1〜4（secretary.run/orderManager/scheduler.execute）を
 * 一切呼び出さないことを、ソースコードの静的検査で確認する。
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const indexSrc = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

function extractFunctionBody(src, functionName) {
  const startMatch = src.match(new RegExp(`async function ${functionName}\\([^)]*\\)\\s*\\{`));
  assert.ok(startMatch, `${functionName} が index.js に見つかりません`);
  const startIdx = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = startIdx;
  while (depth > 0 && i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(startIdx, i - 1);
}

test('/v2-article ハンドラは publisher.publish のみを呼び、Step1〜4（secretary.run/orderManager/scheduler）を呼ばない', () => {
  const body = extractFunctionBody(indexSrc, 'handleV2Article');

  assert.match(body, /publisher\.publish\(/, 'publisher.publish() を呼ぶべき');
  assert.doesNotMatch(body, /secretary\.run\(/, 'secretary.run()（Step1〜4）を呼んではならない');
  assert.doesNotMatch(body, /orderManager\./, 'orderManager（発注処理）を呼んではならない');
  assert.doesNotMatch(body, /scheduler\.execute\(/, 'scheduler.execute()（フルパイプライン）を呼んではならない');
});

test('/v2-article はSLASH_HANDLERSに登録されている', () => {
  assert.match(indexSrc, /'v2-article':\s*handleV2Article/);
});

test('/v2-article は register.js でも定義されている', () => {
  const registerSrc = fs.readFileSync(path.join(__dirname, '../register.js'), 'utf8');
  assert.match(registerSrc, /\.setName\('v2-article'\)/);
});

test('参考: handleV2Run（フルパイプライン）は引き続き secretary.run を呼ぶ（他コマンドを壊していないことの確認）', () => {
  const body = extractFunctionBody(indexSrc, 'handleV2Run');
  assert.match(body, /secretary\.run\(/);
});
