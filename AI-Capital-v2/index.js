'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

// ── 多重起動防止 ───────────────────────────────────────────
const PID_FILE = path.join(__dirname, '.pid');
(function checkSingleInstance() {
  if (fs.existsSync(PID_FILE)) {
    const existing = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    let alive = false;
    try { process.kill(existing, 0); alive = true; } catch {}
    if (alive) { console.error(`❌ 既に起動中 (PID: ${existing})`); process.exit(1); }
    fs.unlinkSync(PID_FILE);
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => { try { fs.unlinkSync(PID_FILE); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT',  () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
})();

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const scheduler   = require('./scheduler');
const secretary   = require('./secretary');
const publisher   = require('./agents/publisher');
const sheets      = require('./lib/sheets');
const orderManager = require('./lib/orderManager');
const health      = require('./lib/health');

const { DISCORD_TOKEN, CEO_CHANNEL = 'ai-v2秘書' } = process.env;
if (!DISCORD_TOKEN) { console.error('❌ DISCORD_TOKEN 未設定'); process.exit(1); }

// ── stale heartbeat リセット（起動時のみ・条件付き） ──────────────
// 2026-08-14: pm2再起動やクラッシュでプロセスが中断すると、finally節を通らないため
// health_heartbeat.json の pipelineRunning:true が永久に残り、watchdogが「実際は動いて
// いないパイプライン」を延々とハング扱いする誤検知が発生した。
// ただし単純に毎回falseへ上書きするのは危険（万一プロセスが瞬断・即再起動され、実際に
// 前のインスタンスがまだ稼働中のheartbeatを誤って消してしまうケースを避けるため）。
// 上の多重起動防止チェックにより、この時点で「同名アプリの生きたプロセスは自分だけ」が
// 保証されているため、heartbeat.pid が自分の process.pid と異なる場合は
// 100%別インスタンス（既に死んでいる）のものと判定できる。
(function reconcileStaleHeartbeat() {
  const hb = health.readHeartbeat();
  if (!hb || !hb.pipelineRunning) return;

  if (health.isHeartbeatStale(hb, process.pid)) {
    console.warn(
      `[startup] stale heartbeat検出（pid: ${hb.pid ?? '不明'} / 現在pid: ${process.pid} / ` +
      `pipelineStartedAt: ${hb.pipelineStartedAt ?? '不明'}）→ pipelineRunning をリセットします`
    );
    health.writeHeartbeat({ pipelineRunning: false, pipelineTask: null, pipelineStartedAt: null });
  } else {
    console.log('[startup] heartbeatは現在のプロセスの実行中状態と一致しているためリセットしません');
  }
})();

console.log(`
╔══════════════════════════════════════════╗
║     AI Capital v2 — Sheets基盤           ║
║  データ: Googleスプレッドシート統合        ║
║  投票集計: LLMなし機械判定               ║
║  記事生成: 最終工程のみ                  ║
╚══════════════════════════════════════════╝
`);

// ── ユーティリティ ────────────────────────────────────────
function splitMessage(text, maxLen = 1900) {
  const chunks = [];
  while (text.length > maxLen) { chunks.push(text.slice(0, maxLen)); text = text.slice(maxLen); }
  if (text) chunks.push(text);
  return chunks;
}

// ── スラッシュコマンドハンドラー ────────────────────────────

async function handleV2Run(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply('⏳ AI Capital v2 パイプライン実行中...\n`データ → 分析 → 投票 → 集約 → 発注 → 記事`');

  try {
    const result = await secretary.run({
      skipPublish: false,
      onProgress:  async msg => {
        await interaction.followUp({ content: msg, flags: 64 }).catch(() => {});
      },
    });

    const d = result.finalDecision;
    const lines = [
      `✅ **AI Capital v2 実行完了** ${result.date}`,
      '',
      d ? `**最終判断**: ${d.final_signal}${d.target_asset ? ` | ${d.target_asset}` : ''}${d.amount ? ` | ¥${parseInt(d.amount).toLocaleString()}` : ''}` : '最終判断: なし',
      result.order ? `**発注記録**: \`${result.order.order_id}\` ${result.order.asset_name} ¥${parseInt(result.order.amount).toLocaleString()}` : '発注: なし',
      '',
      result.article?.noteUrl ? `**note下書き**: ${result.article.noteUrl}` : '',
      result.article ? `**X投稿候補**:\n${result.article.x}` : '',
    ].filter(l => l !== undefined);

    await interaction.editReply(lines.join('\n').slice(0, 1900));
  } catch (err) {
    await interaction.editReply(`❌ エラー: ${err.message}`);
  }
}

// 記事のみ再生成（Step1〜4は一切呼ばない）。
// publisher.publish(date) は final_decisions/agent_recommendations/orders 等を
// Sheetsから読み取るだけの自己完結関数のため、データ取得・投票・発注（Step1〜4）を
// 再実行するリスクなしに、既に完了済みの日の記事だけを安全に再生成できる。
// 2026-08-14: 手動スクリプトでの応急対応に代わる恒久コマンドとして追加。
async function handleV2Article(interaction) {
  await interaction.deferReply({ flags: 64 });
  const dateOpt = interaction.options.getString('日付');
  const date    = dateOpt || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  await interaction.editReply(`⏳ 記事のみ再生成中... (${date})\n※Step1〜4（データ取得・投票・発注）は実行しません`);

  try {
    const article = await publisher.publish(date);
    const lines = [
      `**記事再生成完了** ${date}`,
      '',
      article.validationFailed
        ? '⚠️ 整合性チェック未通過・要確認（下書きのみ保存、公開は見送り）'
        : '✅ Validator PASS',
      article.chartsIncomplete ? `⚠️ グラフ埋め込み ${article.graphsEmbedded ?? 0}/2 枚（要確認）` : '',
      '',
      article.noteUrl ? `**note下書き**: ${article.noteUrl}` : '',
      article.fallbackDraftUrl ? `**note下書き（フォールバック）**: ${article.fallbackDraftUrl}` : '',
      article.x ? `**X投稿候補**:\n${article.x}` : '',
    ].filter(l => l !== undefined);

    await interaction.editReply(lines.join('\n').slice(0, 1900));
  } catch (err) {
    await interaction.editReply(`❌ エラー: ${err.message}`);
  }
}

async function handleV2Status(interaction) {
  await interaction.deferReply({ flags: 64 });
  try {
    const [latestMkt, latestDecision, recentOrders] = await Promise.allSettled([
      sheets.getLatestRow('market_data'),
      sheets.getLatestRow('final_decisions'),
      orderManager.getRecentOrders(5),
    ]);

    const mkt = latestMkt.status === 'fulfilled' ? latestMkt.value : null;
    const dec = latestDecision.status === 'fulfilled' ? latestDecision.value : null;
    const orders = recentOrders.status === 'fulfilled' ? recentOrders.value : [];

    const embed = new EmbedBuilder()
      .setTitle('📊 AI Capital v2 — ステータス')
      .setColor(0x6c8aff)
      .setTimestamp();

    if (mkt) {
      embed.addFields({
        name:  '🌍 最新市場データ',
        value: `日付: ${mkt.date}\nFear & Greed: ${mkt.fear_greed}\nVIX: ${mkt.vix}\nNASDAQ: ${mkt.nasdaq100}%`,
        inline: true,
      });
    }

    if (dec) {
      embed.addFields({
        name:  '🎯 最終判断',
        value: `${dec.date}\nシグナル: **${dec.final_signal}**\n対象: ${dec.target_asset || 'なし'}`,
        inline: true,
      });
    }

    if (orders.length > 0) {
      embed.addFields({
        name:  '📋 直近注文',
        value: orders.map(o => `\`${o.order_id}\` ${o.asset_name} ¥${parseInt(o.amount).toLocaleString()} [${o.status}]`).join('\n'),
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(`❌ エラー: ${err.message}`);
  }
}

async function handleV2Votes(interaction) {
  await interaction.deferReply({ flags: 64 });
  const date = interaction.options.getString('日付') ||
    new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  try {
    const votes = await sheets.getRowsByDate('agent_votes', date);
    if (votes.length === 0) {
      await interaction.editReply(`📭 ${date} の投票データがありません`);
      return;
    }
    const lines = [`**🗳️ 部署投票記録 ${date}**`, ''];
    const SIGNAL_ICON = { BUY: '🟢', ACCUMULATE: '📈', WAIT: '⚪', DEFEND: '🛡', SELL: '🔴' };
    votes.forEach(v => {
      const icon = SIGNAL_ICON[v.signal] ?? '❓';
      lines.push(`${icon} **${v.department}**: ${v.signal}(${v.confidence}%)\n　└ ${v.comment}`);
    });
    await interaction.editReply(lines.join('\n').slice(0, 1900));
  } catch (err) {
    await interaction.editReply(`❌ エラー: ${err.message}`);
  }
}

async function handleV2Orders(interaction) {
  await interaction.deferReply({ flags: 64 });
  try {
    const orders = await orderManager.getRecentOrders(10);
    if (orders.length === 0) {
      await interaction.editReply('📭 注文履歴がありません');
      return;
    }
    const STATUS_ICON = { pending: '⏳', ordered: '📤', filled: '✅', cancelled: '❌', sold: '💰' };
    const lines = ['**📋 注文履歴**', ''];
    orders.forEach(o => {
      const icon = STATUS_ICON[o.status] ?? '❓';
      lines.push(`${icon} \`${o.order_id}\` ${o.date} **${o.asset_name}** ¥${parseInt(o.amount).toLocaleString()} [${o.status}]`);
    });
    await interaction.editReply(lines.join('\n').slice(0, 1900));
  } catch (err) {
    await interaction.editReply(`❌ エラー: ${err.message}`);
  }
}

// ── コマンドテーブル ──────────────────────────────────────
const SLASH_HANDLERS = {
  'v2-run':     handleV2Run,
  'v2-article': handleV2Article,
  'v2-status':  handleV2Status,
  'v2-votes':   handleV2Votes,
  'v2-orders':  handleV2Orders,
};

// ── Discord クライアント ──────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', () => {
  console.log(`✅ AI Capital v2 起動: ${client.user.tag}`);
  client.user.setActivity('📊 v2 Sheets基盤で観測中', { type: 3 });

  const reportChannel = client.channels.cache.find(
    c => c.name === CEO_CHANNEL && c.isTextBased()
  ) ?? null;
  if (reportChannel) console.log(`📡 チャンネル: #${CEO_CHANNEL}`);
  else console.log(`⚠️ チャンネル "${CEO_CHANNEL}" が見つかりません`);

  scheduler.init(client, reportChannel);

  // ── ハートビート（watchdog.js が監視） ─────────────────────
  const heartbeatTick = () => health.writeHeartbeat({
    discordStatus: client.isReady() ? 'connected' : 'disconnected',
  });
  heartbeatTick();
  setInterval(heartbeatTick, 2 * 60 * 1000);

  client.on('shardDisconnect',   () => health.writeHeartbeat({ discordStatus: 'disconnected' }));
  client.on('shardReconnecting', () => health.writeHeartbeat({ discordStatus: 'reconnecting' }));
  client.on('shardResume',       () => health.writeHeartbeat({ discordStatus: 'connected' }));
  client.on('shardError',        () => health.writeHeartbeat({ discordStatus: 'error' }));
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const handler = SLASH_HANDLERS[interaction.commandName];
  if (!handler) return;
  try {
    await handler(interaction);
  } catch (err) {
    console.error(`[ERROR] /${interaction.commandName}:`, err.message);
    const msg = { content: `❌ エラー: ${err.message}`, flags: 64 };
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
