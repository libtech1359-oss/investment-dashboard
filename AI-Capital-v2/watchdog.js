'use strict';

require('dotenv').config();

/**
 * watchdog.js — AI Capital v2 セルフヒーリング監視プロセス
 *
 * ai-v2-secretary とは別のPM2プロセスとして常駐し、5分ごとに
 * health_heartbeat.json と PM2プロセス状態を確認する。
 * 自身の生存は PM2 の autorestart に任せる（監視者を監視する入れ子は作らない）。
 */

const cron   = require('node-cron');
const fs     = require('fs');
const path   = require('path');
const util   = require('util');
const exec   = util.promisify(require('child_process').exec);

const health = require('./lib/health');
const sheets = require('./lib/sheets');

const TARGET_APP        = 'ai-v2-secretary';
const TICK_CRON         = '*/5 * * * *';
const HEARTBEAT_FRESH_MS = 10 * 60 * 1000;   // ハートビートが10分以内なら生存とみなす
const PIPELINE_STUCK_MS  = 20 * 60 * 1000;   // パイプラインが20分以上running状態ならハング疑い
const HEALTHY_LOG_INTERVAL_MS = 30 * 60 * 1000; // 健全時は30分に1回だけ記録

const { DISCORD_TOKEN, GUILD_ID, CEO_CHANNEL = 'ai-v2秘書' } = process.env;

const STATE_FILE = path.join(__dirname, 'data', 'watchdog_state.json');

// ── 状態ファイル ───────────────────────────────────────────
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastHealthyLogAt: null, incident: null };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── PM2プロセス状態取得 ────────────────────────────────────
async function getPm2Status(appName) {
  const { stdout } = await exec('pm2 jlist');
  const list = JSON.parse(stdout);
  const proc = list.find(p => p.name === appName);
  return proc ? proc.pm2_env.status : 'not_found';
}

// ── 総合ヘルスチェック ─────────────────────────────────────
async function checkHealth() {
  const reasons = [];
  const now = Date.now();

  let pm2Status = 'unknown';
  try {
    pm2Status = await getPm2Status(TARGET_APP);
  } catch (err) {
    reasons.push(`pm2 jlist 失敗: ${err.message}`);
  }
  if (pm2Status !== 'online') reasons.push(`PM2ステータス異常: ${pm2Status}`);

  const hb = health.readHeartbeat();
  if (!hb) {
    reasons.push('ハートビートファイルが存在しない');
  } else {
    const age = now - new Date(hb.updatedAt).getTime();
    if (age > HEARTBEAT_FRESH_MS) reasons.push(`ハートビート更新が古い（${Math.round(age / 60000)}分前）`);
    if (hb.discordStatus !== 'connected') reasons.push(`Discord接続状態: ${hb.discordStatus}`);
    if (hb.pipelineRunning && hb.pipelineStartedAt) {
      const runMs = now - new Date(hb.pipelineStartedAt).getTime();
      if (runMs > PIPELINE_STUCK_MS) {
        reasons.push(`パイプライン "${hb.pipelineTask}" が${Math.round(runMs / 60000)}分間実行中（ハング疑い）`);
      }
    }
  }

  return { healthy: reasons.length === 0, reasons, pm2Status, heartbeat: hb };
}

// ── Discord通知（REST直叩き・gatewayログイン不要） ────────────
// ai-v2-secretary が完全に停止していても通知できるよう、discord.jsのgatewayではなく
// 既存のDISCORD_TOKENでREST APIを直接叩く。
let cachedChannelId = null;

async function resolveChannelId() {
  if (cachedChannelId) return cachedChannelId;
  const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, {
    headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Discord channels API HTTP ${res.status}`);
  const channels = await res.json();
  const ch = channels.find(c => c.name === CEO_CHANNEL);
  if (!ch) throw new Error(`チャンネル "${CEO_CHANNEL}" が見つかりません`);
  cachedChannelId = ch.id;
  return cachedChannelId;
}

async function notifyDiscord(content) {
  try {
    const channelId = await resolveChannelId();
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method:  'POST',
      headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content }),
    });
    if (!res.ok) console.warn(`[watchdog] Discord通知失敗: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[watchdog] Discord通知失敗: ${err.message}`);
  }
}

// ── health_log シートへの記録 ───────────────────────────────
async function logHealth({ status, checkType, restartCount = 0, recoveryResult = 'N/A', errorDetail = '', action = 'NONE' }) {
  try {
    await sheets.appendRow('health_log', {
      timestamp:        new Date().toISOString(),
      service:          TARGET_APP,
      status,
      check_type:       checkType,
      restart_count:    String(restartCount),
      recovery_result:  recoveryResult,
      error_detail:     errorDetail,
      action,
    });
  } catch (err) {
    console.warn(`[watchdog] health_log 書き込み失敗: ${err.message}`);
  }
}

// ── 異常時の対応（PM2再起動2回 → 失敗確定・手動対応待ち） ───────────
async function handleUnhealthy(state, result) {
  const errorDetail = result.reasons.join(' / ');

  if (!state.incident) {
    state.incident = { startedAt: new Date().toISOString(), attempts: 0, failureNotified: false };
    await notifyDiscord(
      `⚠️ **AI Capital Health Check**\n${TARGET_APP} との接続異常を検知しました。\n${errorDetail}\n自動復旧を開始します。`
    );
  }

  if (state.incident.failureNotified) {
    // 3回目の失敗通知は済んでいる。復旧するまで手動対応待ち（PC再起動は行わない）。
    return;
  }

  const attempts = state.incident.attempts + 1;
  state.incident.attempts = attempts;

  if (attempts <= 2) {
    let restartOk = true;
    try {
      await exec(`pm2 restart ${TARGET_APP}`);
    } catch (err) {
      restartOk = false;
      console.error('[watchdog] pm2 restart 失敗:', err.message);
    }
    await logHealth({
      status: 'OFFLINE', checkType: 'incident', restartCount: attempts,
      recoveryResult: 'PENDING', errorDetail, action: 'RESTART',
    });
    await notifyDiscord(
      `🔧 **AI Capital Health Check**\n${TARGET_APP} を再起動しました（試行${attempts}回目）。\n` +
      `結果: ${restartOk ? '実行完了（次回チェックで復旧確認）' : '再起動コマンド自体が失敗'}`
    );
    writeState(state);
    return;
  }

  // 3回目: 再起動2回とも復旧しなかった → 失敗確定（手動対応をお願いする）
  state.incident.failureNotified = true;
  await logHealth({
    status: 'OFFLINE', checkType: 'incident', restartCount: attempts,
    recoveryResult: 'FAILED', errorDetail, action: 'NOTIFY',
  });
  await notifyDiscord(
    `❌ **AI Capital Health Check**\n${TARGET_APP} の自動復旧に失敗しました。\n結果：FAILED（3回目）\n${errorDetail}\n手動でのご確認をお願いします。`
  );
  writeState(state);
}

// ── メインtick ─────────────────────────────────────────────
async function tick() {
  const state  = readState();
  const result = await checkHealth();

  if (result.healthy) {
    console.log('[watchdog] OK', JSON.stringify({ pm2: result.pm2Status }));

    if (state.incident) {
      const attempts = state.incident.attempts;
      await logHealth({
        status: 'ONLINE', checkType: 'incident', restartCount: attempts,
        recoveryResult: 'SUCCESS', action: 'NONE',
      });
      await notifyDiscord(`✅ **AI Capital Health Check**\n${TARGET_APP} の復旧を確認しました（再起動${attempts}回目で復旧）。`);
      state.incident = null;
      writeState(state);
      return;
    }

    const last = state.lastHealthyLogAt ? new Date(state.lastHealthyLogAt).getTime() : 0;
    if (Date.now() - last >= HEALTHY_LOG_INTERVAL_MS) {
      await logHealth({ status: 'ONLINE', checkType: 'routine' });
      state.lastHealthyLogAt = new Date().toISOString();
      writeState(state);
    }
    return;
  }

  console.warn('[watchdog] 異常検知:', result.reasons.join(' / '));
  await handleUnhealthy(state, result);
}

if (require.main === module) {
  console.log('✅ ai-v2-watchdog 起動');
  tick().catch(err => console.error('[watchdog] tick エラー:', err.message));
  cron.schedule(TICK_CRON, () => {
    tick().catch(err => console.error('[watchdog] tick エラー:', err.message));
  });
}

module.exports = { checkHealth, handleUnhealthy, tick, readState, writeState, notifyDiscord, logHealth };
