'use strict';

/**
 * index.js は多重起動防止（.pidロック）・Discordログイン・DISCORD_TOKEN未設定時のprocess.exit(1)
 * など起動時副作用を持つため、require()して直接実行するのは安全ではない。
 * そのため、/v2-weekly-article ハンドラが weekly.publishWeekly() のみを呼び出し、
 * Step1〜4（secretary.run/orderManager/signalAggregator/dataFetcher/scheduler.execute）を
 * 一切呼び出さないことを、ソースコードの静的検査で確認する（tests/v2ArticleCommand.test.js と同じ手法）。
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const indexSrc = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

function extractFunctionBody(src, functionName) {
  const startMatch = src.match(new RegExp(`(?:async )?function ${functionName}\\([^)]*\\)\\s*\\{`));
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

test('/v2-weekly-article ハンドラは weekly.publishWeekly のみを呼び、Step1〜4を呼ばない', () => {
  const body = extractFunctionBody(indexSrc, 'handleV2WeeklyArticle');

  assert.match(body, /weekly\.publishWeekly\(/, 'weekly.publishWeekly() を呼ぶべき');
  assert.doesNotMatch(body, /secretary\.run\(/,      'secretary.run()（Step1〜4）を呼んではならない');
  assert.doesNotMatch(body, /orderManager\./,         'orderManager（発注処理）を呼んではならない');
  assert.doesNotMatch(body, /signalAggregator\./,     'signalAggregator（売買判断）を呼んではならない');
  assert.doesNotMatch(body, /dataFetcher\./,          'dataFetcher（日次データ取得）を呼んではならない');
  assert.doesNotMatch(body, /capitalEvents\.(add|append)/, 'capital_events書き込みを呼んではならない');
  assert.doesNotMatch(body, /scheduler\.execute\(/,   'scheduler.execute()（フルパイプライン）を呼んではならない');
  assert.doesNotMatch(body, /publisher\.publish\(/,   '日刊publisher.publish()を呼んではならない');
});

test('/v2-weekly-article はSLASH_HANDLERSに登録されている', () => {
  assert.match(indexSrc, /'v2-weekly-article':\s*handleV2WeeklyArticle/);
});

test('/v2-weekly-article は register.js でも定義されている', () => {
  const registerSrc = fs.readFileSync(path.join(__dirname, '../register.js'), 'utf8');
  assert.match(registerSrc, /\.setName\('v2-weekly-article'\)/);
});

test('weekly.publishWeekly は Step1〜4・注文・portfolio_status更新・capital_events書き込みモジュールをrequireしていない（構造的に実行不可能なことの確認）', () => {
  const weeklySrc = fs.readFileSync(path.join(__dirname, '../agents/weekly.js'), 'utf8');
  assert.doesNotMatch(weeklySrc, /require\(['"]\.\.\/secretary['"]\)/);
  assert.doesNotMatch(weeklySrc, /require\(['"]\.\.\/lib\/orderManager['"]\)/);
  assert.doesNotMatch(weeklySrc, /require\(['"]\.\.\/lib\/signalAggregator['"]\)/);
  assert.doesNotMatch(weeklySrc, /require\(['"]\.\.\/lib\/dataFetcher['"]\)/);

  const weeklyFactsSrc = fs.readFileSync(path.join(__dirname, '../lib/weeklyFacts.js'), 'utf8');
  assert.doesNotMatch(weeklyFactsSrc, /upsertRow|appendRow|addEvent|addMonthlyInjection|addBonusInjection/);
});

test('参考: /v2-article（日刊単独再生成）は引き続き publisher.publish のみを呼ぶ（週刊コマンド追加で壊れていないことの確認）', () => {
  const body = extractFunctionBody(indexSrc, 'handleV2Article');
  assert.match(body, /publisher\.publish\(/);
  assert.doesNotMatch(body, /weekly\.publishWeekly\(/);
});
