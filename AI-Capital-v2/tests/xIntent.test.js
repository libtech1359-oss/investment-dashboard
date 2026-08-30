'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildIntentUrl, buildIntentLine, buildCandidateMessage } = require('../lib/xIntent');

// enforceXLength 通過後の典型的な予告編（X加重280以内・実運用で概ね150〜210字）。
const TWEET = [
  '📊 AI Capital 市場会議',
  '',
  '今日AI社員が最も議論したのは──',
  '📈 NASDAQ100に資金を集中させるか？',
  '🛡️ リスク分散を優先し様子見すべきか？',
  '',
  '続きはnoteで👇',
  'https://note.com/aicapital_jp/n/n1fc331018d57',
  '#AI投資記録',
].join('\n');

test('buildIntentUrl: text= に本文がそのまま復元できる形でエンコードされる', () => {
  const url = buildIntentUrl(TWEET);
  assert.ok(url.startsWith('https://x.com/intent/post?text='));
  const decoded = decodeURIComponent(url.slice('https://x.com/intent/post?text='.length));
  assert.equal(decoded, TWEET);
});

test('buildIntentUrl: & や # や改行が生のまま混入しない（クエリを壊さない）', () => {
  const url = buildIntentUrl('a&b #c\nd');
  const query = url.slice(url.indexOf('?text=') + '?text='.length);
  assert.ok(!query.includes('\n'));
  assert.ok(!query.includes(' '));
  assert.equal(query.split('&').length, 1, '生の & でクエリが分割されてはいけない');
});

test('buildIntentLine: 実運用サイズの予告編ならリンク行を返し、Discord上限(1900)に収まる', () => {
  const line = buildIntentLine(TWEET);
  assert.ok(line, 'リンク行が生成されるはず');
  assert.ok(line.length <= 1900, `想定内の長さのはず (${line.length})`);
});

test('buildIntentLine: URLが上限を超える長文は null（コピペ運用へフォールバック）', () => {
  // 日本語1文字≒9字にエンコードされるため、約230字で1900を突破する。
  const huge = 'あ'.repeat(400);
  assert.equal(buildIntentLine(huge), null);
});

test('buildCandidateMessage: 本文コードブロックとリンク行を含み、単一メッセージで送れる', () => {
  const msg = buildCandidateMessage(TWEET);
  assert.ok(msg.includes('```'), 'コピペ用コードブロックを含む');
  assert.ok(msg.includes(TWEET), '予告編本文をそのまま含む');
  assert.ok(msg.includes('https://x.com/intent/post?text='), 'ワンタップ投稿リンクを含む');
  assert.ok(msg.length <= 2000, `Discordメッセージ上限に収まる (${msg.length})`);
});

test('buildCandidateMessage: 長文でリンクが貼れない場合もコピペ本文は必ず残す', () => {
  const huge = 'あ'.repeat(400);
  const msg = buildCandidateMessage(huge);
  assert.ok(msg.includes(huge), '本文は落とさない');
  assert.ok(!msg.includes('https://x.com/intent/post'), '貼れないリンクは載せない');
  assert.ok(msg.includes('コピー'), 'コピペ運用への案内を出す');
});
