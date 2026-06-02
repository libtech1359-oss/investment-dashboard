'use strict';

const cron        = require('node-cron');
const secretary   = require('./secretary');
const lock        = require('./lib/lock');
const systemState = require('./lib/systemState');
const { generateId }          = require('./lib/taskId');
const taskStore               = require('./lib/taskStore');
const reportWriter            = require('./lib/reportWriter');
const publisher               = require('./agents/publisher');
const gitSync                 = require('./lib/gitSync');
const { writeLog, writeError } = require('./core/logger');

// ── スケジュール定義 ────────────────────────────────────────
// 追加・変更はここだけ

const SCHEDULES = [
  {
    name: '朝の市場分析',
    icon: '🌅',
    cron: '0 7 * * 1-5',   // 月〜金 07:00 JST
    instruction: '朝の定期市場分析。各指数の前日比・今日の注目ポイント・午前中の投資方針を報告してください。',
    reportType: 'morning',
  },
  {
    name: '昼のポートフォリオ確認',
    icon: '🌞',
    cron: '0 12 * * 1-5',  // 月〜金 12:00 JST
    instruction: '昼のポートフォリオ確認。午前の動き・現在の含み益状況・午後の方針を簡潔に報告してください。',
  },
  {
    name: '引け後レポート',
    icon: '🌇',
    cron: '30 15 * * 1-5', // 月〜金 15:30 JST（東証引け後）
    instruction: '本日の引け後レポート。日中の値動きまとめ・ポートフォリオへの影響・明日の注目点を報告してください。',
    reportType: 'close',
  },
  {
    name: '週次レポート',
    icon: '📅',
    cron: '0 16 * * 5',    // 金曜 16:00 JST
    instruction: '週次総括レポート。今週の市場動向・ポートフォリオの変化・来週の戦略方針を総合的に報告してください。',
    reportType: 'weekly',
  },
];

// ── イベント監視設定 ────────────────────────────────────────

const CRASH_THRESHOLD = parseFloat(process.env.CRASH_THRESHOLD || '-3.0');
const MONITOR_INTERVAL = 5 * 60 * 1000; // 5分

let crashFiredDate = null; // 同日の二重発火防止

// ── 初期化 ──────────────────────────────────────────────────

let reportChannel = null;

async function init(client) {
  const channelName = process.env.REPORT_CHANNEL || process.env.CEO_CHANNEL || 'ai秘書';
  reportChannel = client.channels.cache.find(
    c => c.name === channelName && c.isTextBased()
  );

  if (!reportChannel) {
    writeLog('scheduler', `⚠️ レポートチャンネル "${channelName}" が見つかりません。スケジューラー無効。`);
    return;
  }

  // 時刻トリガー登録
  for (const s of SCHEDULES) {
    cron.schedule(s.cron, () => fireSchedule(s), { timezone: 'Asia/Tokyo' });
    writeLog('scheduler', `登録: ${s.icon} ${s.name}  [${s.cron} JST]`);
  }

  // NASDAQ急落モニター開始
  startCrashMonitor();

  writeLog('scheduler', `✅ スケジューラー起動 / チャンネル: #${channelName} / 急落閾値: ${CRASH_THRESHOLD}%`);
}

// ── 時刻トリガー ────────────────────────────────────────────

function fireSchedule(schedule) {
  if (systemState.isHalted()) {
    writeLog('scheduler', `🛑 スキップ（停止中）: ${schedule.name}`);
    return;
  }
  if (lock.isLocked()) {
    writeLog('scheduler', `⏭ スキップ（処理中）: ${schedule.name}`);
    return;
  }
  execute(schedule.icon, schedule.name, schedule.instruction, 'scheduler', schedule.reportType || null).catch(
    err => writeError('scheduler', err)
  );
}

// ── NASDAQ急落モニター ──────────────────────────────────────

function startCrashMonitor() {
  setInterval(async () => {
    try {
      const pct = await fetchNasdaqChangePct();
      if (pct === null) return;

      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

      if (pct <= CRASH_THRESHOLD && crashFiredDate !== today && !systemState.isHalted()) {
        crashFiredDate = today;
        writeLog('scheduler', `🚨 NASDAQ急落検知: ${pct.toFixed(2)}%`);
        const instruction = `緊急事態: NASDAQが${pct.toFixed(2)}%急落しています。`
          + `緊急リスク監査・保有ポートフォリオへの影響・即時対応方針を報告してください。`;
        await execute('🚨', `NASDAQ緊急監査 (${pct.toFixed(1)}%)`, instruction, 'crash-monitor');
      }
    } catch (err) {
      writeError('scheduler', err);
    }
  }, MONITOR_INTERVAL);

  writeLog('scheduler', `NASDAQ監視開始 (閾値: ${CRASH_THRESHOLD}%, ${MONITOR_INTERVAL / 60000}分ごと)`);
}

async function fetchNasdaqChangePct() {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 8000);
    const res  = await fetch(
      'https://query1.finance.yahoo.com/v7/finance/spark?symbols=%5ENDX&range=1d&interval=1m',
      { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }
    ).finally(() => clearTimeout(tid));
    if (!res.ok) return null;
    const meta = (await res.json())?.spark?.result?.[0]?.response?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const prev = meta.previousClose || meta.chartPreviousClose;
    return prev ? (meta.regularMarketPrice - prev) / prev * 100 : null;
  } catch (_) {
    return null;
  }
}

// ── 共通実行 ────────────────────────────────────────────────

function splitMessage(text, maxLen = 1900) {
  const chunks = [];
  while (text.length > maxLen) { chunks.push(text.slice(0, maxLen)); text = text.slice(maxLen); }
  if (text) chunks.push(text);
  return chunks;
}

async function execute(icon, name, instruction, source, reportType = null) {
  if (!reportChannel) return;

  const taskId = generateId();
  taskStore.create(taskId, `[${source}] ${name}`, source);
  writeLog('scheduler', `実行: ${name} [${taskId}]`);

  lock.lock();
  try {
    await reportChannel.send(`${icon} **${name}**\n\`${taskId}\` 処理中…`);
    const report = await secretary.handle(instruction, taskId);
    for (const chunk of splitMessage(report)) await reportChannel.send(chunk);

    if (reportType) {
      const task     = taskStore.get(taskId);
      const filePath = reportWriter.write(reportType, task);
      writeLog('scheduler', `内部レポート保存: ${filePath}`);

      // publisher agent: 公開用コンテンツ生成
      try {
        writeLog('scheduler', `publisher 起動 [${taskId}]`);
        const publishResult = await publisher.publish(task);
        const { notePath, xPath } = reportWriter.writePublic(reportType, publishResult);
        writeLog('scheduler', `公開レポート保存: ${notePath}`);
        await reportChannel.send(
          `📄 内部レポート → \`${filePath}\`\n` +
          `📝 note用 → \`${notePath}\`\n` +
          `🐦 X用:\n\`\`\`\n${publishResult.x}\n\`\`\``
        );
      } catch (pubErr) {
        writeError('scheduler', pubErr);
        await reportChannel.send(`⚠️ publisher エラー（内部レポートは保存済み）: ${pubErr.message}`).catch(() => {});
      }

      // GitHub へ自動 push
      const pushed = gitSync.sync(`${reportType} report`);
      if (pushed) {
        await reportChannel.send(`📦 GitHub に push しました`);
      }
    }

    await reportChannel.send(`\`✅ ${taskId} 完了\``);
    writeLog('scheduler', `完了: ${name} [${taskId}]`);
  } catch (err) {
    writeError('scheduler', err);
    await reportChannel.send(`❌ **${name}** エラー: ${err.message}`).catch(() => {});
  } finally {
    lock.unlock();
  }
}

module.exports = { init };
