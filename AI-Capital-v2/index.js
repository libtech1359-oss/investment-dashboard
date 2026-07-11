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
const sheets      = require('./lib/sheets');
const orderManager = require('./lib/orderManager');

const { DISCORD_TOKEN, CEO_CHANNEL = 'ai-v2秘書' } = process.env;
if (!DISCORD_TOKEN) { console.error('❌ DISCORD_TOKEN 未設定'); process.exit(1); }

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
      result.article ? `**X投稿候補**:\n${result.article.x.slice(0, 280)}` : '',
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
  'v2-run':    handleV2Run,
  'v2-status': handleV2Status,
  'v2-votes':  handleV2Votes,
  'v2-orders': handleV2Orders,
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
