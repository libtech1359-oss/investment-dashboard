'use strict';

require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const secretary  = require('./secretary');
const logger     = require('./lib/logger');
const memory     = require('./lib/memory');
const lock        = require('./lib/lock');
const scheduler   = require('./scheduler');
const systemState = require('./lib/systemState');
const eventLog    = require('./lib/eventLog');
const { generateId } = require('./lib/taskId');
const taskStore  = require('./lib/taskStore');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  環境変数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const {
  DISCORD_TOKEN,
  GAS_URL,
  CEO_CHANNEL = 'ai秘書',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN が .env に未設定');
  process.exit(1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ユーティリティ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function fetchT(url, ms = 10000, opts = {}) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  const { headers: extraHeaders, ...restOpts } = opts;
  return fetch(url, {
    signal: ctrl.signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
      ...extraHeaders,
    },
    ...restOpts,
  }).finally(() => clearTimeout(id));
}

const yen     = n => '¥' + Number(n).toLocaleString('ja-JP');
const num     = n => Number(n).toLocaleString('ja-JP');
const pct     = n => (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';
const dirIcon = n => n > 0 ? '📈' : n < 0 ? '📉' : '➡️';

function athJudge(p) {
  if (p <= -30) return { badge: '🟢🟢', label: '強い買い',  color: 0x4ecca3 };
  if (p <= -15) return { badge: '🟢',   label: '買い',      color: 0x7eff6e };
  if (p <=  -5) return { badge: '🟡',   label: '様子見',    color: 0xffd93d };
  if (p <    0) return { badge: '⚪',   label: '高値圏',    color: 0x8b92b8 };
  return               { badge: '🔴',   label: '最高値圏',  color: 0xff6b8a };
}

function fgEmoji(v) {
  if (v <= 25) return '😱';
  if (v <= 45) return '😨';
  if (v <= 55) return '😐';
  if (v <= 75) return '😏';
  return '🤑';
}

const gauge = v => '█'.repeat(Math.round(v / 10)) + '░'.repeat(10 - Math.round(v / 10));

function splitMessage(text, maxLen = 1900) {
  const chunks = [];
  while (text.length > maxLen) {
    chunks.push(text.slice(0, maxLen));
    text = text.slice(maxLen);
  }
  if (text) chunks.push(text);
  return chunks;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GAS・市場データ取得
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function fetchGasData() {
  if (!GAS_URL) throw new Error('GAS_URL が .env に未設定');
  const res  = await fetchT(GAS_URL, 12000);
  if (!res.ok) throw new Error(`GAS HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`GAS: ${data.error}`);
  return data;
}

async function fetchSheet(sheet) {
  if (!GAS_URL) throw new Error('GAS_URL が .env に未設定');
  const res  = await fetchT(GAS_URL + '?sheet=' + encodeURIComponent(sheet), 12000);
  if (!res.ok) throw new Error(`GAS HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(`GAS: ${data.error}`);
  return data;
}

async function fetchMarketQuotes() {
  const YF  = ['^NDX', '^GSPC', 'GC=F', 'USDJPY=X', 'BTC-USD'];
  const tryHost = async host => {
    const res  = await fetchT(host + '/v7/finance/spark?symbols=' + YF.join(',') + '&range=1d&interval=1m', 12000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const results = json?.spark?.result;
    if (!Array.isArray(results) || results.length === 0) throw new Error('結果なし');
    return results.filter(r => r?.response?.[0]?.meta).map(r => {
      const meta = r.response[0].meta;
      const price = meta.regularMarketPrice || 0;
      const prev  = meta.previousClose || meta.chartPreviousClose || price;
      const chg   = price - prev;
      return { symbol: r.symbol, regularMarketPrice: price, regularMarketChange: chg, regularMarketChangePercent: prev ? chg / prev * 100 : 0 };
    });
  };
  let data = [];
  try { data = await Promise.any([tryHost('https://query1.finance.yahoo.com'), tryHost('https://query2.finance.yahoo.com')]); }
  catch (_) {}
  if (!data.find(q => q.symbol === 'USDJPY=X')) {
    try { const r = await fetchT('https://open.er-api.com/v6/latest/USD', 8000); if (r.ok) { const j = await r.json(); if (j?.rates?.JPY) data.push({ symbol: 'USDJPY=X', regularMarketPrice: j.rates.JPY, regularMarketChange: 0, regularMarketChangePercent: 0 }); } } catch (_) {}
  }
  if (!data.find(q => q.symbol === 'BTC-USD')) {
    try { const r = await fetchT('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true', 8000); if (r.ok) { const j = await r.json(); if (j?.bitcoin) data.push({ symbol: 'BTC-USD', regularMarketPrice: j.bitcoin.usd, regularMarketChange: 0, regularMarketChangePercent: j.bitcoin.usd_24h_change || 0 }); } } catch (_) {}
  }
  if (data.length === 0) throw new Error('市場データ取得失敗');
  return data;
}

async function fetchFearGreed() {
  try {
    const res = await fetchT('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', 6000);
    if (res.ok) { const j = await res.json(); if (j?.fear_and_greed?.score) return { value: Math.round(j.fear_and_greed.score), label: j.fear_and_greed.rating }; }
  } catch (_) {}
  try {
    const res = await fetchT('https://api.alternative.me/fng/?limit=1', 6000);
    if (res.ok) { const d = (await res.json()).data[0]; return { value: parseInt(d.value), label: d.value_classification }; }
  } catch (_) {}
  return { value: 50, label: 'Neutral（取得失敗）' };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  スラッシュコマンドハンドラー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleMarket(interaction) {
  await interaction.deferReply();
  const [quotes, fg] = await Promise.all([fetchMarketQuotes(), fetchFearGreed()]);
  const META = {
    'USDJPY=X': { name: '🇺🇸 ドル円',     fmtVal: v => v.toFixed(2) + ' 円' },
    '^NDX':     { name: '📊 NASDAQ 100',  fmtVal: v => v.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) + ' pt' },
    '^GSPC':    { name: '📈 S&P 500',     fmtVal: v => v.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) + ' pt' },
    'GC=F':     { name: '🥇 ゴールド',    fmtVal: v => '$' + v.toFixed(2) + '/oz' },
    'BTC-USD':  { name: '₿ ビットコイン', fmtVal: v => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }) },
  };
  const fields = quotes.filter(q => META[q.symbol]).map(q => {
    const m = META[q.symbol], chg = q.regularMarketChange || 0, p = q.regularMarketChangePercent || 0;
    return { name: m.name, value: `**${m.fmtVal(q.regularMarketPrice || 0)}**\n${dirIcon(chg)} ${(chg >= 0 ? '+' : '') + chg.toFixed(2)} (${pct(p)})`, inline: true };
  });
  await interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle('📊 マーケット概況').setColor(0x6c8aff).addFields(fields)
    .addFields({ name: `${fgEmoji(fg.value)} Fear & Greed Index`, value: `**${fg.value}** — ${fg.label}\n\`${gauge(fg.value)}\`  0 ←恐怖　欲望→ 100`, inline: false })
    .setFooter({ text: '投資管理ダッシュボード | Yahoo Finance' }).setTimestamp()] });
}

async function handlePortfolio(interaction) {
  await interaction.deferReply();
  const { funds, summary } = await fetchGasData();
  const byName = {};
  funds.forEach(f => {
    if (!byName[f.name]) byName[f.name] = { name: f.name, value: 0, principal: 0, units: 0, nav: f.nav || 0 };
    byName[f.name].value += f.value; byName[f.name].principal += f.principal; byName[f.name].units += f.units || 0;
  });
  const fields = Object.values(byName).map(f => {
    const gain = f.value - f.principal, ret = f.principal > 0 ? gain / f.principal * 100 : 0;
    const name = f.name.length > 20 ? f.name.slice(0, 20) + '…' : f.name;
    return { name: dirIcon(gain) + ' ' + name, value: `${yen(f.value)}\n${pct(ret)}${f.nav > 0 ? '\n' + num(Math.round(f.units)) + '口 @ ' + yen(f.nav) : ''}`, inline: true };
  });
  await interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle('💼 ポートフォリオ概要').setColor(summary.gainAmount >= 0 ? 0x4ecca3 : 0xff6b8a)
    .setDescription(`> **合計評価額**　${yen(summary.totalValue)}\n> **合計元本**　　${yen(summary.totalPrincipal)}\n> **合計含み益**　${dirIcon(summary.gainAmount)} **${yen(summary.gainAmount)}**\n> **総収益率**　　**${pct(summary.gainPct)}**\n> **前日比**　　　${dirIcon(summary.dailyChange)} ${yen(summary.dailyChange)}`)
    .addFields(fields).setFooter({ text: `${Object.keys(byName).length} 銘柄 | 基準日: ${summary.date || '—'}` }).setTimestamp()] });
}

async function handleTrades(interaction) {
  await interaction.deferReply();
  const filter = interaction.options.getString('口座') || 'all';
  const raw    = await fetchSheet('trades');
  if (!Array.isArray(raw) || raw.length === 0) { await interaction.editReply({ content: '❌ 取引データがありません' }); return; }
  const all = raw.map(r => ({ date: r['約定日']??r.date??'', account: r['口座']??r.account??'', name: r['銘柄']??r.name??'', type: r['売買']??r.type??'', amount: +(r['金額']??r.amount??0), units: +(r['口数']??r.units??0) })).sort((a, b) => new Date(b.date) - new Date(a.date));
  const filtered = all.filter(t => filter === 'all' ? true : filter === 'tokutei' ? t.account === '特定' : t.account === '成長' || t.account === '積立');
  const recent = filtered.slice(0, 10);
  const buyTotal = all.filter(t => t.type === '買').reduce((s, t) => s + t.amount, 0);
  const sellTotal = all.filter(t => t.type === '売').reduce((s, t) => s + t.amount, 0);
  const filterLabel = filter === 'tokutei' ? '特定口座' : filter === 'nisa' ? 'NISA枠' : '全口座';
  await interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle('📝 直近の取引履歴').setColor(0x6c8aff)
    .setDescription(`**${filterLabel}** | 全 ${filtered.length} 件\n> 🟢 **買合計**　${yen(buyTotal)}\n> 🔴 **売合計**　${yen(sellTotal)}\n> **純投資額**　${yen(buyTotal - sellTotal)}`)
    .addFields(recent.length > 0 ? recent.map(t => ({ name: `${t.type === '買' ? '🟢' : '🔴'} ${t.type} | ${t.date}`, value: `**${t.name}**\n${t.amount ? yen(t.amount) : '—'} ｜ ${t.units ? num(t.units) + '口' : '—'} ｜ ${t.account || '—'}`, inline: true })) : [{ name: '取引データなし', value: '該当なし', inline: false }])
    .setFooter({ text: `直近 ${recent.length} 件` }).setTimestamp()] });
}

async function handleBuy(interaction) {
  await interaction.deferReply();
  const { funds } = await fetchGasData();
  const byName = {};
  funds.forEach(f => { if (!byName[f.name]) byName[f.name] = { name: f.name, value: 0, principal: 0, athPct: f.athPct }; byName[f.name].value += f.value; byName[f.name].principal += f.principal; });
  const fields = Object.values(byName).map(f => {
    const j = athJudge(f.athPct), gain = f.value - f.principal, ret = f.principal > 0 ? gain / f.principal * 100 : 0;
    return { name: `${j.badge} ${f.name.length > 20 ? f.name.slice(0, 20) + '…' : f.name}`, value: `ATH比: **${f.athPct.toFixed(1)}%** → **${j.label}**\n含み益率: ${pct(ret)}　評価額: ${yen(f.value)}`, inline: false };
  });
  await interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle('🔍 買い判断レポート').setColor(0x6c8aff)
    .setDescription('> 🟢🟢 −30%以上 → **強い買い**\n> 🟢 −15〜30% → **買い**\n> 🟡 −5〜15% → **様子見**\n> ⚪ 0〜5% → **高値圏**\n> 🔴 0%以上 → **最高値圏**')
    .addFields(fields).setFooter({ text: '投資管理ダッシュボード' }).setTimestamp()] });
}

async function handleNisa(interaction) {
  await interaction.deferReply();
  const frame = interaction.options.getString('枠') || 'growth';
  const { funds, nisa } = await fetchGasData();
  const remain = frame === 'tsumitate' ? nisa.tsumiRemain : nisa.growthRemain;
  const used   = frame === 'tsumitate' ? nisa.tsumiUsed   : nisa.growthUsed;
  const frameLabel = frame === 'tsumitate' ? `つみたて投資枠（年間 ${yen(nisa.tsumiLimit)}）` : `成長投資枠（年間 ${yen(nisa.growthLimit)}）`;
  const sorted = funds.filter(f => f.account === '特定' && f.value > f.principal).map(f => ({ ...f, retRate: (f.value - f.principal) / f.principal * 100 })).sort((a, b) => b.retRate - a.retRate);
  let rem = remain; const candidates = [], skipped = [];
  sorted.forEach(f => { if (f.value <= rem) { rem -= f.value; candidates.push(f); } else { skipped.push(f); } });
  const fields = candidates.map(f => ({ name: `✅ ${f.name.length > 18 ? f.name.slice(0, 18) + '…' : f.name}`, value: `評価額: **${yen(f.value)}**　含み益率: **+${f.retRate.toFixed(2)}%**\n含み益: ${yen(f.value - f.principal)}`, inline: false }));
  if (skipped.length > 0) fields.push({ name: '⚠️ 枠オーバーのため除外', value: skipped.map(f => `• ${f.name}（${yen(f.value)}）`).join('\n'), inline: false });
  await interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle('🎯 NISA移行候補').setColor(0x4ecca3)
    .setDescription(`**対象枠:** ${frameLabel}\n**今年の利用額:** ${yen(used)}\n**残枠:** ${yen(remain)}\n\n> 特定口座から含み益率の高い順に表示`)
    .addFields(fields.length > 0 ? fields : [{ name: '候補なし', value: '含み益のある銘柄が見つかりません', inline: false }])
    .setFooter({ text: '※ NISA適格性はご自身で確認ください' }).setTimestamp()] });
}

async function handleRules(interaction) {
  await interaction.deferReply();
  const cash = interaction.options.getInteger('現金');
  const crashMode = interaction.options.getBoolean('暴落モード') || false;
  const crashUsed = interaction.options.getInteger('暴落枠使用済み') || 0;
  let NORMAL_MIN = 3_000_000, CRASH_MIN = 2_000_000, CRASH_MAX = 1_000_000;
  try { const { settings } = await fetchGasData(); if (settings.NORMAL_CASH_MIN) NORMAL_MIN = settings.NORMAL_CASH_MIN; if (settings.CRASH_CASH_MIN) CRASH_MIN = settings.CRASH_CASH_MIN; if (settings.CRASH_FUND_MAX) CRASH_MAX = settings.CRASH_FUND_MAX; } catch (_) {}
  const cashMin = crashMode ? CRASH_MIN : NORMAL_MIN;
  const surplus = cash - cashMin, crashRemain = CRASH_MAX - crashUsed;
  const canInvest = surplus >= 0 && (!crashMode || crashRemain > 0);
  const maxInvest = crashMode ? Math.min(surplus, crashRemain) : surplus;
  const cashBar = '🟩'.repeat(cash >= NORMAL_MIN ? 5 : cash >= CRASH_MIN ? 3 : 1) + '⬛'.repeat(cash >= NORMAL_MIN ? 0 : cash >= CRASH_MIN ? 2 : 4);
  const rule1 = cash >= NORMAL_MIN ? ['✅ OK', `現金 ${yen(cash)} ｜ 余剰 **${yen(surplus)}**`] : crashMode && cash >= CRASH_MIN ? ['⚠️ 暴落中', `暴落モード中 ｜ 最低 ${yen(CRASH_MIN)} は維持中`] : ['❌ NG', `あと **${yen(cashMin - cash)}** 補充が必要`];
  const rule2 = !crashMode ? ['ℹ️ OFF', `通常の ${yen(NORMAL_MIN)} ルール適用中`] : crashRemain > 0 ? ['✅ 適用中', `暴落枠 残 **${yen(crashRemain)}** ｜ 追加投資可`] : ['❌ 枠なし', `暴落枠 ${yen(CRASH_MAX)} を使い切りました`];
  await interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle('📋 投資ルール確認').setColor(canInvest ? 0x4ecca3 : 0xff6b8a)
    .setDescription(`**モード:** ${crashMode ? '📉 暴落モード ON' : '📊 通常モード'}\n**現金:** ${yen(cash)}\n${cashBar}  基準: ${yen(cashMin)}`)
    .addFields(
      { name: `① 現金維持ルール　${rule1[0]}`, value: rule1[1], inline: false },
      { name: `② 暴落特別投資枠　${rule2[0]}`, value: rule2[1], inline: false },
      { name: canInvest ? '✅ 追加投資　可能' : '❌ 追加投資　不可', value: canInvest ? `最大 **${yen(maxInvest)}** まで投資できます` : surplus < 0 ? `現金が ${yen(Math.abs(surplus))} 不足` : '暴落枠を使い切っています', inline: false }
    ).setFooter({ text: '投資管理ダッシュボード' }).setTimestamp()] });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /profile コマンド（構造化方針）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleProfile(interaction) {
  const action = interaction.options.getSubcommand();

  if (action === 'show') {
    const profile = memory.getCeoProfile();
    const txt     = memory.profileToText(profile);
    const raw     = JSON.stringify(profile, null, 2);
    const content = txt
      ? `**🧬 CEOプロファイル（構造化）**\n${txt}\n\n\`\`\`json\n${raw}\n\`\`\``
      : '未設定です。`/profile set` で設定してください。';
    await interaction.reply({ content: content.slice(0, 1900), flags: 64 });
    return;
  }

  // set
  const key   = interaction.options.getString('項目');
  const value = interaction.options.getString('値');

  // 型変換
  let parsed;
  try {
    parsed = JSON.parse(value); // 数値・配列・true/false も対応
  } catch {
    parsed = value;             // 文字列はそのまま
  }

  const profile = memory.setCeoProfileField(key, parsed);
  const display = Array.isArray(parsed) ? parsed.join(', ') : String(parsed);
  await interaction.reply({
    content: `✅ **${key}** を **${display}** に設定しました\n\`/profile show\` で全設定を確認できます`,
    flags: 64,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /remember コマンド（記憶を保存）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleRemember(interaction) {
  const type    = interaction.options.getString('種類');
  const content = interaction.options.getString('内容');

  if (type === 'note') {
    memory.saveNote(content);
    await interaction.reply({ content: `📝 メモを保存しました\n> ${content}`, flags: 64 });
  } else {
    memory.savePolicy(type, content);
    await interaction.reply({ content: `🧠 方針を保存しました\n> [${type}] ${content}`, flags: 64 });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /memory コマンド（記憶を表示）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleMemory(interaction) {
  const policies  = memory.getPolicies();
  const decisions = memory.getRecentDecisions(5);
  const notes     = memory.getNotes();

  const lines = ['**🧠 AI Capital 長期記憶**\n'];

  if (policies.length > 0) {
    lines.push('**📋 CEO方針・ルール**');
    policies.forEach(p => lines.push(`\`#${p.id}\` [${p.category}] ${p.content}`));
    lines.push('');
  }

  if (decisions.length > 0) {
    lines.push('**📊 直近の投資判断**');
    decisions.forEach(d => lines.push(`\`#${d.id}\` ${d.created_at.slice(0, 10)} — ${d.summary.slice(0, 60)}…`));
    lines.push('');
  }

  if (notes.length > 0) {
    lines.push('**📝 メモ**');
    notes.forEach(n => lines.push(`\`#${n.id}\` ${n.content}`));
  }

  if (policies.length === 0 && decisions.length === 0 && notes.length === 0) {
    lines.push('記憶はまだありません。`/remember` で追加してください。');
  }

  await interaction.reply({ content: lines.join('\n').slice(0, 1900), flags: 64 });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /forget コマンド（記憶を削除）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleForget(interaction) {
  const type = interaction.options.getString('種類');
  const id   = interaction.options.getInteger('id');

  let result;
  if (type === 'policy')   result = memory.deletePolicy(id);
  if (type === 'decision') result = memory.deleteDecision(id);
  if (type === 'note')     result = memory.deleteNote(id);

  const msg = result?.changes > 0
    ? `🗑️ ${type} #${id} を削除しました`
    : `❌ ${type} #${id} が見つかりませんでした`;

  await interaction.reply({ content: msg, flags: 64 });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /halt /resume /status コマンド
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleHalt(interaction) {
  const state = systemState.halt('manual_stop', interaction.user.username);
  await interaction.reply({
    content: [
      '🛑 **緊急停止しました**',
      `\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``,
    ].join('\n'),
    flags: 64,
  });
}

async function handleResume(interaction) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('resume_confirm').setLabel('再開する').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('resume_cancel').setLabel('キャンセル').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    content: '⚠️ **自動取引を再開しますか？**\n`trading_enabled: true` になります。\n30秒以内に確認してください。',
    components: [row],
    flags: 64,
  });

  const collector = interaction.channel.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id && ['resume_confirm', 'resume_cancel'].includes(i.customId),
    time: 30_000,
    max: 1,
  });

  collector.on('collect', async btn => {
    if (btn.customId === 'resume_confirm') {
      systemState.resume(btn.user.username);
      await btn.update({ content: '✅ **自動取引を再開しました**\n`trading_enabled: true`', components: [] });
    } else {
      await btn.update({ content: '↩️ キャンセルしました。停止状態を維持します。', components: [] });
    }
  });

  collector.on('end', (_, reason) => {
    if (reason === 'time') {
      interaction.editReply({ content: '⏰ タイムアウト。停止状態を維持します。', components: [] }).catch(() => {});
    }
  });
}

async function handleStatus(interaction) {
  const state  = systemState.read();
  const halted = state.trading_enabled !== true;
  const icon   = halted ? '🛑' : '✅';
  const label  = halted ? '**停止中**' : '**稼働中**';

  const lines = [
    `${icon} システム状態: ${label}`,
    '',
    '```json',
    JSON.stringify(state, null, 2),
    '```',
  ];
  await interaction.reply({ content: lines.join('\n'), flags: 64 });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /events コマンド
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleEvents(interaction) {
  const limit  = interaction.options.getInteger('件数') ?? 10;
  const events = eventLog.read(limit);

  if (events.length === 0) {
    await interaction.reply({ content: '📭 イベント履歴はまだありません。', flags: 64 });
    return;
  }

  const ICON = { halt: '🛑', resume: '✅', audit_override: '⚠️' };
  const lines = ['**📋 システムイベント履歴**', ''];

  for (const e of events) {
    const icon = ICON[e.event] ?? '📌';
    const ts   = new Date(e.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const reason = e.reason ? ` \`${e.reason}\`` : '';
    lines.push(`${icon} \`${ts}\`  **${e.event}**${reason}  by **${e.by}**`);
  }

  await interaction.reply({ content: lines.join('\n').slice(0, 1900), flags: 64 });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /log コマンド
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleLog(interaction) {
  await interaction.deferReply({ flags: 64 }); // 本人のみ表示

  const date = interaction.options.getString('日付') || undefined;
  const idx  = interaction.options.getInteger('番号') ?? -1; // -1=最新
  const step = interaction.options.getString('ステップ') || 'summary';

  const logs = logger.readLogs(date);
  if (logs.length === 0) {
    await interaction.editReply('📭 ログがありません（指定日付: ' + (date || '今日') + '）');
    return;
  }

  const session = idx === -1 ? logs[logs.length - 1] : logs[idx];
  if (!session) {
    await interaction.editReply(`❌ 番号 ${idx} のログが存在しません（全${logs.length}件）`);
    return;
  }

  const ts = new Date(session.id).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  let content = '';

  if (step === 'summary') {
    const agentLines = Object.entries(session.steps.agents || {})
      .map(([dept, a]) => `・**${dept}** ${a.elapsedMs}ms`)
      .join('\n');

    content = [
      `**🕐 ${ts}**  合計 ${session.totalMs}ms`,
      `**📋 指示:** ${session.instruction}`,
      '',
      '**⏱ ステップ別所要時間**',
      `・データ取得: ${session.steps.dataFetch?.elapsedMs ?? '—'}ms`,
      `・タスク分解: ${session.steps.decompose?.elapsedMs ?? '—'}ms`,
      agentLines,
      `・統合: ${session.steps.synthesize?.elapsedMs ?? '—'}ms`,
      session.error ? `\n❌ **エラー:** ${session.error.message}` : '',
    ].filter(l => l !== '').join('\n');

  } else if (step === 'data') {
    content = `**📦 取得データ**\n\`\`\`\n${(session.steps.dataFetch?.context || 'なし').slice(0, 1800)}\n\`\`\``;

  } else if (step === 'decompose') {
    content = `**🔀 タスク分解結果（各部署へのブリーフィング）**\n\`\`\`\n${(session.steps.decompose?.briefing || 'なし').slice(0, 1800)}\n\`\`\``;

  } else if (['market', 'portfolio', 'risk', 'audit'].includes(step)) {
    const deptMap = {
      market:    'マーケット分析部',
      portfolio: 'ポートフォリオ管理部',
      risk:      'リスク管理部',
      audit:     '監査部',
    };
    const a = session.steps.agents?.[deptMap[step]];
    content = a
      ? `**🏢 ${step} 部の生返答** (${a.elapsedMs}ms)\n\`\`\`\n${a.response.slice(0, 1800)}\n\`\`\``
      : '❌ 該当エージェントのログが見つかりません';

  } else if (step === 'report') {
    content = `**📊 最終統合レポート**\n${(session.finalReport || 'なし').slice(0, 1900)}`;
  }

  await interaction.editReply(content || '❌ 不明なステップ');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  スラッシュコマンド登録テーブル
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SLASH_HANDLERS = {
  profile:   handleProfile,
  market:    handleMarket,
  portfolio: handlePortfolio,
  trades:    handleTrades,
  buy:       handleBuy,
  nisa:      handleNisa,
  rules:     handleRules,
  remember:  handleRemember,
  memory:    handleMemory,
  forget:    handleForget,
  log:       handleLog,
  halt:      handleHalt,
  resume:    handleResume,
  status:    handleStatus,
  events:    handleEvents,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Discord クライアント
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', () => {
  console.log(`✅ AI Capital 起動完了: ${client.user.tag}`);
  console.log(`📡 待機チャンネル: #${CEO_CHANNEL}`);
  client.user.setActivity('📊 投資を監視中', { type: 3 });
  logger.purgeOldLogs(90);
  scheduler.init(client);
});

// ── スラッシュコマンド ──

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

// ── AIマルチエージェント秘書 ──

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (message.channel.name !== CEO_CHANNEL) return;
  if (lock.isLocked()) {
    await message.reply('⚠️ 前の指示を処理中です。しばらくお待ちください。');
    return;
  }

  const instruction = message.content.trim();
  if (!instruction) return;

  lock.lock();
  const taskId = generateId();
  taskStore.create(taskId, instruction, 'discord');
  console.log(`\n[CEO] ${instruction} [${taskId}]`);
  await message.react('⏳');

  try {
    const report = await secretary.handle(instruction, taskId);
    for (const chunk of splitMessage(report)) {
      await message.channel.send(chunk);
    }
    await message.channel.send(`\`📋 ${taskId}\``);
    await message.reactions.removeAll();
    await message.react('✅');
  } catch (err) {
    console.error('[ERROR]', err);
    await message.reactions.removeAll();
    await message.reply(`❌ エラー: ${err.message}`);
  } finally {
    lock.unlock();
  }
});

client.login(DISCORD_TOKEN);
