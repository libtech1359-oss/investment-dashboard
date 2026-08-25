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

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const scheduler   = require('./scheduler');
const secretary   = require('./secretary');
const publisher   = require('./agents/publisher');
const weekly      = require('./agents/weekly');
const sheets      = require('./lib/sheets');
const orderManager = require('./lib/orderManager');
const health      = require('./lib/health');
const pendingXPosts = require('./lib/pendingXPosts');
const xPoster     = require('./lib/xPoster');

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
let staleHeartbeatToRecover = null;
(function reconcileStaleHeartbeat() {
  const hb = health.readHeartbeat();
  if (!hb || !hb.pipelineRunning) return;

  if (health.isHeartbeatStale(hb, process.pid)) {
    console.warn(
      `[startup] stale heartbeat検出（pid: ${hb.pid ?? '不明'} / 現在pid: ${process.pid} / ` +
      `pipelineStartedAt: ${hb.pipelineStartedAt ?? '不明'}）→ pipelineRunning をリセットします`
    );
    staleHeartbeatToRecover = hb;
    health.writeHeartbeat({ pipelineRunning: false, pipelineTask: null, pipelineStartedAt: null });
  } else {
    console.log('[startup] heartbeatは現在のプロセスの実行中状態と一致しているためリセットしません');
  }
})();

// 中断されたパイプラインが「日刊AI Capital市場会議」だった場合、記事生成（Step5）だけを
// 自動リトライする。2026-08-19/20に、pm2 restart（デプロイ）が12:00 JSTの定例実行と
// 重なりパイプラインが記事生成の途中で巻き込まれて消え、その日はnote下書き保存もX投稿
// 候補の通知も一切発生しないまま終わっていたことが判明したため追加。
// final_decisions（Step3の出力）が対象日に存在する場合のみ実行する
// （Step1〜4完了前に中断された場合はデータ不足で誤った記事になるため何もしない）。
async function attemptStaleArticleRecovery(hb, reportChannel) {
  if (hb.pipelineTask !== '日刊AI Capital市場会議' || !hb.pipelineStartedAt) return;
  const date = new Date(hb.pipelineStartedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

  console.log(`[startup] 中断されたパイプライン(${date})の記事のみ自動リトライを試みます`);
  try {
    const decisions = await sheets.getRowsByDate('final_decisions', date);
    if (!decisions || decisions.length === 0) {
      console.warn(`[startup] ${date}のfinal_decisionsが存在しないため自動リトライをスキップ（Step1〜4が未完了の可能性）`);
      if (reportChannel) {
        await reportChannel.send(
          `⚠️ ${date}のパイプラインが記事生成前に中断されたようです。\`/v2-run\` で手動再実行してください。`
        ).catch(() => {});
      }
      return;
    }

    const article = await publisher.publish(date);
    const xReply = await buildXPostReply(article);
    const lines = [
      `🔁 **中断された記事を自動リトライしました** (${date})`,
      '',
      article.validationFailed
        ? '⚠️ 整合性チェック未通過・要確認（下書きのみ保存、公開は見送り）'
        : article.published ? '✅ 公開完了' : '⚠️ 自動公開失敗（下書きのみ・要手動公開）',
      '',
      article.noteUrl ? `**note${article.published ? '記事' : '下書き'}**: ${article.noteUrl}` : '',
      article.fallbackDraftUrl ? `**note下書き（フォールバック）**: ${article.fallbackDraftUrl}` : '',
      xReply.line,
    ].filter(l => l !== undefined && l !== '');

    if (reportChannel) {
      await reportChannel.send({ content: lines.join('\n').slice(0, 1900), components: xReply.components }).catch(() => {});
    }
  } catch (err) {
    console.error('[startup] 記事自動リトライ失敗:', err.message);
    if (reportChannel) {
      await reportChannel.send(`❌ ${date}の記事自動リトライに失敗しました: ${err.message}`).catch(() => {});
    }
  }
}

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

// X投稿候補用の「𝕏に投稿」ボタン行を作る（本文はpendingXPosts.jsに保存し、
// customIdには短いidのみ埋め込む。scheduler.jsのnotifyXCandidate()と同じ仕組み）。
function xPostButtonRow(text) {
  const id = pendingXPosts.create(text);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`xpost:${id}`)
      .setLabel('𝕏 に投稿')
      .setStyle(ButtonStyle.Primary)
  );
}

// note公開が成功している場合はXへ即時自動投稿する。未公開（下書きのみ）の場合や
// 自動投稿自体が失敗した場合は、従来通り手動投稿ボタンを返す。
// @returns {{ line: string, components: object[] }}
async function buildXPostReply(article) {
  if (!article?.x) return { line: '', components: [] };
  if (article.published) {
    try {
      const { url } = await xPoster.postTweet(article.x);
      return { line: `**X投稿**: ✅ 自動投稿しました ${url}`, components: [] };
    } catch (err) {
      console.error('[ERROR] X自動投稿失敗:', err.message);
      return {
        line: `**X投稿**: ⚠️ 自動投稿失敗（${err.message}）。下のボタンで手動投稿できます`,
        components: [xPostButtonRow(article.x)],
      };
    }
  }
  return { line: `**X投稿候補**:\n${article.x}`, components: [xPostButtonRow(article.x)] };
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
    const xReply = await buildXPostReply(result.article);
    const lines = [
      `✅ **AI Capital v2 実行完了** ${result.date}`,
      '',
      d ? `**最終判断**: ${d.final_signal}${d.target_asset ? ` | ${d.target_asset}` : ''}${d.amount ? ` | ¥${parseInt(d.amount).toLocaleString()}` : ''}` : '最終判断: なし',
      result.order ? `**発注記録**: \`${result.order.order_id}\` ${result.order.asset_name} ¥${parseInt(result.order.amount).toLocaleString()}` : '発注: なし',
      '',
      result.article?.noteUrl ? `**note${result.article.published ? '記事' : '下書き'}**: ${result.article.noteUrl}` : '',
      xReply.line,
    ].filter(l => l !== undefined);

    await interaction.editReply({ content: lines.join('\n').slice(0, 1900), components: xReply.components });
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
    const xReply = await buildXPostReply(article);
    const lines = [
      `**記事再生成完了** ${date}`,
      '',
      article.validationFailed
        ? (article.chartsIncomplete
          ? `⚠️ グラフ埋め込み ${article.graphsEmbedded ?? 0}/2 枚のため未公開（下書きのみ保存）`
          : '⚠️ 整合性チェック未通過・要確認（下書きのみ保存、公開は見送り）')
        : article.published ? '✅ 公開完了' : '⚠️ 自動公開失敗（下書きのみ・要手動公開）',
      '',
      article.noteUrl ? `**note${article.published ? '記事' : '下書き'}**: ${article.noteUrl}` : '',
      article.fallbackDraftUrl ? `**note下書き（フォールバック）**: ${article.fallbackDraftUrl}` : '',
      xReply.line,
    ].filter(l => l !== undefined);

    await interaction.editReply({ content: lines.join('\n').slice(0, 1900), components: xReply.components });
  } catch (err) {
    await interaction.editReply(`❌ エラー: ${err.message}`);
  }
}

// 対象週（月〜金）を算出する。scheduler.js の currentWeekMondayFriday() と同じロジックだが、
// weekly.publishWeekly() を直接呼ぶだけの本ハンドラを scheduler.js の内部関数に結合させない
// ため、意図的に同じ小さなロジックをこちらにも保持する（週刊記事単独再生成専用）。
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

/**
 * 週刊記事だけを再生成する正式な入口。
 *
 * 既に確定した1週間分のデータ（market_data / agent_recommendations /
 * department_recommendations / final_decisions / orders / portfolio_status /
 * capital_events）を読み取り専用で集計し直すだけで、weekly.publishWeekly() 以外の
 * 何も呼び出さない。日次データ取得・投票・売買判断・注文・portfolio_status更新・
 * capital_events書き込み（Step1〜4・secretary.run・orderManager・signalAggregator・
 * dataFetcher）は一切実行しない（週刊記事生成ロジック自体がこれらのモジュールを
 * requireしていないため、構造的に実行不可能）。
 */
async function handleV2WeeklyArticle(interaction) {
  await interaction.deferReply({ flags: 64 });
  const startOpt = interaction.options.getString('開始日');
  const endOpt   = interaction.options.getString('終了日');
  const [defaultStart, defaultEnd] = currentWeekMondayFriday();
  const start = startOpt || defaultStart;
  const end   = endOpt   || defaultEnd;
  await interaction.editReply(`⏳ 週刊記事のみ再生成中... (${start}〜${end})\n※Step1〜4（データ取得・投票・発注・portfolio_status更新・capital_events書き込み）は実行しません`);

  try {
    const result = await weekly.publishWeekly(start, end);
    const url = result.noteUrl || result.fallbackDraftUrl;
    const lines = [
      `**週刊記事再生成完了** ${start}〜${end}`,
      '',
      result.approved
        ? '✅ 公開可（Validator PASS・グラフ2/2・AI編集長APPROVED）'
        : '⚠️ 要確認・公開見送り（下書きのみ保存）',
      `グラフ生成 ${result.graphsGenerated ?? 0}/2 枚 ・ 埋め込み ${result.graphsEmbedded ?? 0}/2 枚`,
      '',
      url ? `**note下書き**: ${url}` : '（下書き保存に失敗しました）',
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

// 「𝕏に投稿」ボタン押下時のハンドラー。custom_id (`xpost:<id>`) から
// pendingXPosts.jsに保存済みの本文を引いてX APIへ投稿し、元メッセージの
// ボタンを「投稿済み」表示に差し替える。
async function handleXPostButton(interaction) {
  const id = interaction.customId.slice('xpost:'.length);
  await interaction.deferReply({ flags: 64 });

  const entry = pendingXPosts.get(id);
  if (!entry) {
    await interaction.editReply('⚠️ この投稿候補は見つかりません（期限切れの可能性があります）');
    return;
  }
  if (entry.status === 'posted') {
    await interaction.editReply(`ℹ️ 既に投稿済みです: ${entry.tweetUrl}`);
    return;
  }

  try {
    const { url } = await xPoster.postTweet(entry.text);
    pendingXPosts.markPosted(id, url);
    await interaction.editReply(`✅ Xに投稿しました: ${url}`);

    const postedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`xpost:${id}`)
        .setLabel('✅ 投稿済み')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
    await interaction.message.edit({ components: [postedRow] }).catch(() => {});
  } catch (err) {
    console.error('[ERROR] xpost button:', err.message);
    await interaction.editReply(`❌ 投稿失敗: ${err.message}`);
  }
}

// ── コマンドテーブル ──────────────────────────────────────
const SLASH_HANDLERS = {
  'v2-run':             handleV2Run,
  'v2-article':         handleV2Article,
  'v2-weekly-article':  handleV2WeeklyArticle,
  'v2-status':          handleV2Status,
  'v2-votes':           handleV2Votes,
  'v2-orders':          handleV2Orders,
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

  if (staleHeartbeatToRecover) {
    const hb = staleHeartbeatToRecover;
    staleHeartbeatToRecover = null;
    attemptStaleArticleRecovery(hb, reportChannel).catch(err =>
      console.error('[startup] 記事自動リトライ処理エラー:', err.message)
    );
  }

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
  if (interaction.isButton() && interaction.customId.startsWith('xpost:')) {
    try {
      await handleXPostButton(interaction);
    } catch (err) {
      console.error('[ERROR] xpost button:', err.message);
      const msg = { content: `❌ エラー: ${err.message}`, flags: 64 };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
    return;
  }

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
