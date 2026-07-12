'use strict';

const cron          = require('node-cron');
const secretary     = require('./secretary');
const dataFetcher   = require('./lib/dataFetcher');
const capitalEvents = require('./lib/capitalEvents');
const weekly        = require('./agents/weekly');

const { writeLog, writeError } = (() => {
  const log = (tag, msg) => console.log(`[${tag}] ${msg}`);
  const err = (tag, e)   => console.error(`[${tag}] ERROR:`, e.message);
  return { writeLog: log, writeError: err };
})();

// ── スケジュール定義 ─────────────────────────────────────────
const SCHEDULES = [
  {
    name: 'NAV取得（前営業日基準価格）',
    cron: '30 11 * * 1-5',
    type: 'nav',   // secretary.run() を呼ばず writeNavPrices() のみ実行
  },
  {
    name:        '日刊AI Capital市場会議',
    cron:        '0 12 * * 1-5',
    skipPublish: false,
  },
  {
    name: '月次資金積立（＋ボーナス）',
    cron: '0 9 1 * *',   // 毎月1日 9:00 JST
    type: 'capital',
  },
  {
    name: '週刊 AI Capital レポート',
    cron: '30 17 * * 5',   // 毎週金曜 17:30 JST（日刊会議の後）
    type: 'weekly',
  },
];

let reportChannel = null;
let isRunning     = false;

async function notify(msg) {
  writeLog('scheduler', msg);
  if (reportChannel) await reportChannel.send(msg).catch(() => {});
}

async function executeNav(schedule) {
  try {
    await notify(`▶ ${schedule.name} 開始`);
    const date   = dataFetcher.prevBusinessDayJST();
    const result = await dataFetcher.writeNavPrices(date);
    const ok     = result?.results?.filter(r => r.nav != null) ?? [];
    const lines  = ok.map(r => `${r.asset_name}: ¥${Number(r.nav).toLocaleString()}`).join(' / ');
    await notify(`📈 **NAV取得完了** (${date})\n${lines}`);
  } catch (err) {
    writeError('scheduler', err);
    await notify(`❌ ${schedule.name} エラー: ${err.message}`);
  }
}

async function executeCapital(schedule) {
  try {
    await notify(`▶ ${schedule.name} 開始`);

    const jstDate = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    const period  = jstDate.slice(0, 7);  // 'YYYY-MM'
    const month   = parseInt(jstDate.slice(5, 7), 10);

    // 初期資金（未登録なら自動登録）
    await capitalEvents.ensureInitialCapital();

    // 月次積立 ¥200,000
    const monthly = await capitalEvents.addMonthlyInjection(period);
    if (monthly) {
      await notify(
        `💰 **月次積立**: ¥${parseInt(monthly.amount).toLocaleString()}` +
        ` (${period}) 累計元本=¥${parseInt(monthly.running_total).toLocaleString()}`
      );
    } else {
      await notify(`💰 月次積立 ${period} は登録済み（スキップ）`);
    }

    // ボーナス ¥1,000,000（7月・12月のみ）
    if (month === 7 || month === 12) {
      const bonusPeriod = `${period}-bonus`;
      const bonus = await capitalEvents.addBonusInjection(bonusPeriod);
      if (bonus) {
        await notify(
          `🎁 **ボーナス積立**: ¥${parseInt(bonus.amount).toLocaleString()}` +
          ` (${bonusPeriod}) 累計元本=¥${parseInt(bonus.running_total).toLocaleString()}`
        );
      } else {
        await notify(`🎁 ボーナス ${bonusPeriod} は登録済み（スキップ）`);
      }
    }

    await notify(`✅ ${schedule.name} 完了`);
  } catch (err) {
    writeError('scheduler', err);
    await notify(`❌ ${schedule.name} エラー: ${err.message}`);
  }
}

function currentWeekMondayFriday() {
  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const today    = new Date(`${todayStr}T00:00:00Z`);
  const dow      = today.getUTCDay();
  const monday   = new Date(today);
  monday.setUTCDate(today.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  const friday   = new Date(monday);
  friday.setUTCDate(monday.getUTCDate() + 4);
  const fmt = d => d.toISOString().slice(0, 10);
  return [fmt(monday), fmt(friday)];
}

async function executeWeekly(schedule) {
  try {
    await notify(`▶ ${schedule.name} 開始`);
    const [start, end] = currentWeekMondayFriday();
    const result = await weekly.publishWeekly(start, end);
    if (result.noteUrl) {
      await notify(`📄 **週刊レポート下書き保存完了** (${start}〜${end})\n${result.noteUrl}`);
    } else {
      await notify(`⚠️ ${schedule.name}: note.com 下書き保存に失敗しました（本文は生成済み）`);
    }
    await notify(`✅ ${schedule.name} 完了`);
  } catch (err) {
    writeError('scheduler', err);
    await notify(`❌ ${schedule.name} エラー: ${err.message}`);
  }
}

async function execute(schedule) {
  if (schedule.type === 'nav') {
    return executeNav(schedule);
  }
  if (schedule.type === 'capital') {
    return executeCapital(schedule);
  }
  if (schedule.type === 'weekly') {
    return executeWeekly(schedule);
  }
  if (isRunning) {
    writeLog('scheduler', `スキップ（実行中）: ${schedule.name}`);
    return;
  }
  isRunning = true;
  try {
    await notify(`▶ ${schedule.name} 開始`);
    const result = await secretary.run({
      skipPublish: schedule.skipPublish,
      onProgress:  msg => notify(msg),
    });

    if (result.finalDecision) {
      const d = result.finalDecision;
      await notify(
        `📊 **最終判断**: ${d.final_signal}` +
        (d.target_asset ? ` | ${d.target_asset}` : '') +
        (d.amount ? ` | ¥${parseInt(d.amount).toLocaleString()}` : '')
      );
    }

    if (result.order) {
      await notify(
        `📋 **発注記録**: \`${result.order.order_id}\` ${result.order.asset_name} ¥${parseInt(result.order.amount).toLocaleString()} (pending)`
      );
    }

    if (result.article) {
      await notify(`📝 **X投稿候補**\n\`\`\`\n${result.article.x.slice(0, 280)}\n\`\`\``);
      const noteLines = result.article.note.split('\n');
      const preview   = noteLines.slice(0, 10).join('\n');
      await notify(`📄 **note記事（冒頭）**\n${preview.slice(0, 800)}`);
    }

    await notify(`✅ ${schedule.name} 完了`);
  } catch (err) {
    writeError('scheduler', err);
    await notify(`❌ ${schedule.name} エラー: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

function init(client, channel) {
  reportChannel = channel;

  for (const s of SCHEDULES) {
    cron.schedule(s.cron, () => execute(s), { timezone: 'Asia/Tokyo' });
    writeLog('scheduler', `登録: ${s.name} [${s.cron} JST] publish=${!s.skipPublish}`);
  }

  writeLog('scheduler', '✅ スケジューラー起動完了（AI Capital v2）');
}

module.exports = { init };
