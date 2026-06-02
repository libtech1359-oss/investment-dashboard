/**
 * bot.js — 投資秘書 Discord Bot + AI音声秘書
 *
 * ── スラッシュコマンド ──
 *  /market    … 市場データ（ドル円・NASDAQ・S&P500・ゴールド・BTC・Fear&Greed）
 *  /portfolio … ポートフォリオ概要（評価額・含み益・口数・基準価格）
 *  /trades    … 直近の取引履歴
 *  /buy       … 買い判断（ATH比較）
 *  /nisa      … NISA移行候補
 *  /rules     … ルール状態確認
 *
 * ── AI音声秘書 ──
 *  「ai秘書」チャンネルにテキストを送ると Ollama で返答
 *
 * 起動: node bot.js
 */

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs');

// ── Ollama
let Ollama;
let ollamaAvailable = false;

try {
  ({ Ollama } = require('ollama'));
  ollamaAvailable = true;
} catch (_) {
  console.warn('⚠️ ollama が未インストールです。AI返答機能を無効化します。');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  環境変数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const {
  DISCORD_TOKEN,
  GAS_URL,
  GUILD_ID,
  AI_CHANNEL_NAME = 'ai秘書',
  OLLAMA_MODEL    = 'gemma4:e4b',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN が .env に設定されていません');
  process.exit(1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AI秘書の状態
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const conversationHistory = [];
let isProcessing = false;
const ollama     = ollamaAvailable ? new Ollama({ host: 'http://127.0.0.1:11434' }) : null;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ユーティリティ（投資コマンド用）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function fetchT(url, ms = 9000, opts = {}) {
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GASデータ取得
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function fetchGasData() {
  if (!GAS_URL) throw new Error('GAS_URL が .env に設定されていません');
  const res = await fetchT(GAS_URL, 12000);
  if (!res.ok) throw new Error(`GAS レスポンスエラー: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`GAS エラー: ${data.error}`);
  return data;
}

async function fetchSheet(sheet) {
  if (!GAS_URL) throw new Error('GAS_URL が .env に設定されていません');
  const url = GAS_URL + (sheet ? '?sheet=' + encodeURIComponent(sheet) : '');
  const res = await fetchT(url, 12000);
  if (!res.ok) throw new Error(`GAS レスポンスエラー: HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.error) throw new Error(`GAS エラー: ${data.error}`);
  return data;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  市場データ取得
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function tryYahooHost(host, symbols) {
  const path = '/v7/finance/spark?symbols=' + symbols.join(',') + '&range=1d&interval=1m';
  const res  = await fetchT(host + path, 12000, { headers: { Referer: 'https://finance.yahoo.com/' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json    = await res.json();
  const results = json?.spark?.result;
  if (!Array.isArray(results) || results.length === 0) throw new Error('spark.result が空');
  return results
    .filter(r => r?.response?.[0]?.meta)
    .map(r => {
      const meta   = r.response[0].meta;
      const price  = meta.regularMarketPrice || 0;
      const prev   = meta.previousClose || meta.chartPreviousClose || price;
      const chg    = price - prev;
      const chgPct = prev !== 0 ? (chg / prev) * 100 : 0;
      return { symbol: r.symbol, regularMarketPrice: price, regularMarketChange: chg, regularMarketChangePercent: chgPct };
    });
}

async function fetchMarketQuotes() {
  const YF_SYMBOLS = ['^NDX', '^GSPC', 'GC=F', 'USDJPY=X', 'BTC-USD'];
  let yfData = null;
  try {
    yfData = await Promise.any([
      tryYahooHost('https://query1.finance.yahoo.com', YF_SYMBOLS),
      tryYahooHost('https://query2.finance.yahoo.com', YF_SYMBOLS),
    ]);
  } catch (e) {
    console.warn('[market] Yahoo Finance 全失敗:', e.message);
    yfData = [];
  }

  if (!yfData.find(q => q.symbol === 'USDJPY=X')) {
    try {
      const res = await fetchT('https://open.er-api.com/v6/latest/USD', 8000);
      if (res.ok) {
        const json = await res.json();
        const jpy  = json?.rates?.JPY;
        if (jpy) yfData.push({ symbol: 'USDJPY=X', regularMarketPrice: jpy, regularMarketChange: 0, regularMarketChangePercent: 0 });
      }
    } catch (_) {}
  }

  if (!yfData.find(q => q.symbol === 'BTC-USD')) {
    try {
      const res = await fetchT('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true', 8000);
      if (res.ok) {
        const json = await res.json();
        const btc  = json?.bitcoin;
        if (btc) yfData.push({ symbol: 'BTC-USD', regularMarketPrice: btc.usd, regularMarketChange: 0, regularMarketChangePercent: btc.usd_24h_change || 0 });
      }
    } catch (_) {}
  }

  if (yfData.length === 0) throw new Error('市場データを取得できませんでした');
  return yfData;
}

async function fetchFearGreed() {
  try {
    const res  = await fetchT('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', 6000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.fear_and_greed?.score) throw new Error('構造エラー');
    return { value: Math.round(json.fear_and_greed.score), label: json.fear_and_greed.rating };
  } catch (e) { console.warn('[fg] CNN 失敗:', e.message); }

  try {
    const res = await fetchT('https://api.alternative.me/fng/?limit=1', 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d   = (await res.json()).data[0];
    return { value: parseInt(d.value), label: d.value_classification + '（Crypto）' };
  } catch (e) {
    return { value: 50, label: 'Neutral（取得失敗）' };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AI秘書ロジック
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function generateAiReply(userText) {
  conversationHistory.push(`ユーザー: ${userText}`);
  if (conversationHistory.length > 20) conversationHistory.shift();

  const response = await ollama.chat({
    model:   OLLAMA_MODEL,
    think:   false,
    options: { temperature: 0.7, num_predict: 300 },
    messages: [
      { role: 'system', content: 'あなたはAI秘書です。日本語で短く自然に返答してください。' },
      { role: 'user',   content: conversationHistory.slice(-6).join('\n') },
    ],
  });

  const reply = response.message.content.trim() || '（返答がありませんでした）';
  conversationHistory.push(`AI: ${reply}`);
  return reply;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  スラッシュコマンドハンドラー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* /market */
async function handleMarket(interaction) {
  await interaction.deferReply();
  const [quotes, fg] = await Promise.all([fetchMarketQuotes(), fetchFearGreed()]);

  const META = {
    'USDJPY=X': { name: '🇺🇸 ドル円',      fmtVal: v => v.toFixed(2) + ' 円' },
    '^NDX':     { name: '📊 NASDAQ 100',   fmtVal: v => v.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) + ' pt' },
    '^GSPC':    { name: '📈 S&P 500',      fmtVal: v => v.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) + ' pt' },
    'GC=F':     { name: '🥇 ゴールド',     fmtVal: v => '$' + v.toFixed(2) + '/oz' },
    'BTC-USD':  { name: '₿ ビットコイン', fmtVal: v => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }) },
  };

  const fields = quotes
    .filter(q => META[q.symbol])
    .map(q => {
      const m   = META[q.symbol];
      const chg = q.regularMarketChange        || 0;
      const p   = q.regularMarketChangePercent || 0;
      return {
        name:   m.name,
        value:  `**${m.fmtVal(q.regularMarketPrice || 0)}**\n${dirIcon(chg)} ${(chg >= 0 ? '+' : '') + chg.toFixed(2)} (${pct(p)})`,
        inline: true,
      };
    });

  const embed = new EmbedBuilder()
    .setTitle('📊 マーケット概況')
    .setColor(0x6c8aff)
    .addFields(fields)
    .addFields({
      name:   `${fgEmoji(fg.value)} Fear & Greed Index`,
      value:  `**${fg.value}** — ${fg.label}\n\`${gauge(fg.value)}\`  0 ←恐怖　欲望→ 100`,
      inline: false,
    })
    .setFooter({ text: '投資管理ダッシュボード | Yahoo Finance' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/* /portfolio */
async function handlePortfolio(interaction) {
  await interaction.deferReply();
  const { funds, summary } = await fetchGasData();

  const byName = {};
  funds.forEach(f => {
    if (!byName[f.name]) {
      byName[f.name] = { name: f.name, value: 0, principal: 0, units: 0, nav: f.nav || 0, athPct: f.athPct || 0 };
    }
    byName[f.name].value     += f.value;
    byName[f.name].principal += f.principal;
    byName[f.name].units     += f.units || 0;
  });

  const fields = Object.values(byName).map(f => {
    const gain    = f.value - f.principal;
    const ret     = f.principal > 0 ? (gain / f.principal * 100) : 0;
    const name    = f.name.length > 20 ? f.name.slice(0, 20) + '…' : f.name;
    const navLine = f.nav > 0 ? `\n${num(Math.round(f.units))}口 @ ${yen(f.nav)}` : '';
    return {
      name:   dirIcon(gain) + ' ' + name,
      value:  `${yen(f.value)}\n${pct(ret)}${navLine}`,
      inline: true,
    };
  });

  const embed = new EmbedBuilder()
    .setTitle('💼 ポートフォリオ概要')
    .setColor(summary.gainAmount >= 0 ? 0x4ecca3 : 0xff6b8a)
    .setDescription(
      `> **合計評価額**　${yen(summary.totalValue)}\n` +
      `> **合計元本**　　${yen(summary.totalPrincipal)}\n` +
      `> **合計含み益**　${dirIcon(summary.gainAmount)} **${yen(summary.gainAmount)}**\n` +
      `> **総収益率**　　**${pct(summary.gainPct)}**\n` +
      `> **前日比**　　　${dirIcon(summary.dailyChange)} ${yen(summary.dailyChange)}`
    )
    .addFields(fields)
    .setFooter({ text: `${Object.keys(byName).length} 銘柄 | 基準日: ${summary.date || '—'}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/* /trades */
async function handleTrades(interaction) {
  await interaction.deferReply();
  const filter    = interaction.options.getString('口座') || 'all';
  const rawTrades = await fetchSheet('trades');

  if (!Array.isArray(rawTrades) || rawTrades.length === 0) {
    await interaction.editReply({ content: '❌ 取引データがありません' });
    return;
  }

  const all = rawTrades.map(r => ({
    date:    r['約定日']   ?? r.date    ?? '',
    account: r['口座']     ?? r.account ?? '',
    name:    r['銘柄']     ?? r.name    ?? '',
    type:    r['売買']     ?? r.type    ?? '',
    amount:+ (r['金額']    ?? r.amount  ?? 0),
    units: + (r['口数']    ?? r.units   ?? 0),
    memo:    r['メモ']     ?? r.memo    ?? '',
  })).sort((a, b) => new Date(b.date) - new Date(a.date));

  const filtered = all.filter(t => {
    if (filter === 'all')     return true;
    if (filter === 'tokutei') return t.account === '特定' || t.account.includes('特定');
    if (filter === 'nisa')    return t.account === '成長' || t.account === '積立' || t.account.includes('NISA');
    return true;
  });

  const buyTotal  = all.filter(t => t.type === '買').reduce((s, t) => s + t.amount, 0);
  const sellTotal = all.filter(t => t.type === '売').reduce((s, t) => s + t.amount, 0);

  const recent = filtered.slice(0, 10);
  const fields = recent.map(t => {
    const icon = t.type === '買' ? '🟢' : '🔴';
    return {
      name:   `${icon} ${t.type} | ${t.date}`,
      value:  `**${t.name}**\n${t.amount ? yen(t.amount) : '—'} ｜ ${t.units ? num(t.units) + '口' : '—'} ｜ ${t.account || '—'}`,
      inline: true,
    };
  });

  const filterLabel = filter === 'tokutei' ? '特定口座' : filter === 'nisa' ? 'NISA枠' : '全口座';
  const embed = new EmbedBuilder()
    .setTitle('📝 直近の取引履歴')
    .setColor(0x6c8aff)
    .setDescription(
      `**${filterLabel}** | 全 ${filtered.length} 件\n` +
      `> 🟢 **買合計**　${yen(buyTotal)}\n` +
      `> 🔴 **売合計**　${yen(sellTotal)}\n` +
      `> **純投資額**　${yen(buyTotal - sellTotal)}`
    )
    .addFields(fields.length > 0 ? fields : [{ name: '取引データなし', value: '該当する取引が見つかりませんでした', inline: false }])
    .setFooter({ text: `直近 ${recent.length} 件を表示 | 投資管理ダッシュボード` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/* /buy */
async function handleBuy(interaction) {
  await interaction.deferReply();
  const { funds } = await fetchGasData();

  const byName = {};
  funds.forEach(f => {
    if (!byName[f.name]) byName[f.name] = { name: f.name, value: 0, principal: 0, athPct: f.athPct };
    byName[f.name].value     += f.value;
    byName[f.name].principal += f.principal;
  });

  const fields = Object.values(byName).map(f => {
    const judge = athJudge(f.athPct);
    const gain  = f.value - f.principal;
    const ret   = f.principal > 0 ? (gain / f.principal * 100) : 0;
    const name  = f.name.length > 20 ? f.name.slice(0, 20) + '…' : f.name;
    return {
      name:   `${judge.badge} ${name}`,
      value:  `ATH比: **${f.athPct.toFixed(1)}%**　→　**${judge.label}**\n含み益率: ${pct(ret)}　評価額: ${yen(f.value)}`,
      inline: false,
    };
  });

  const embed = new EmbedBuilder()
    .setTitle('🔍 銘柄別 買い判断レポート')
    .setColor(0x6c8aff)
    .setDescription(
      '> **判断基準（ATHからの乖離率）**\n' +
      '> 🟢🟢 −30%以上 → **強い買い**\n' +
      '> 🟢 −15〜30% → **買い**\n' +
      '> 🟡 −5〜15% → **様子見**\n' +
      '> ⚪ 0〜5% → **高値圏**\n' +
      '> 🔴 0%以上 → **最高値圏（注意）**'
    )
    .addFields(fields)
    .setFooter({ text: '投資管理ダッシュボード' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/* /nisa */
async function handleNisa(interaction) {
  await interaction.deferReply();
  const frame = interaction.options.getString('枠') || 'growth';
  const { funds, nisa } = await fetchGasData();

  const limit      = frame === 'tsumitate' ? nisa.tsumiLimit  : nisa.growthLimit;
  const used       = frame === 'tsumitate' ? nisa.tsumiUsed   : nisa.growthUsed;
  const remain     = frame === 'tsumitate' ? nisa.tsumiRemain : nisa.growthRemain;
  const frameLabel = frame === 'tsumitate'
    ? `つみたて投資枠（年間 ${yen(nisa.tsumiLimit)}）`
    : `成長投資枠（年間 ${yen(nisa.growthLimit)}）`;

  const sorted = funds
    .filter(f => f.account === '特定' && f.value > f.principal)
    .map(f => ({ ...f, retRate: (f.value - f.principal) / f.principal * 100 }))
    .sort((a, b) => b.retRate - a.retRate);

  let remaining    = remain;
  const candidates = [];
  const skipped    = [];

  sorted.forEach(f => {
    if (f.value <= remaining) {
      remaining -= f.value;
      candidates.push(f);
    } else {
      skipped.push(f);
    }
  });

  const candFields = candidates.map(f => ({
    name:   `✅ ${f.name.length > 18 ? f.name.slice(0, 18) + '…' : f.name}`,
    value:  `評価額: **${yen(f.value)}**　含み益率: **+${f.retRate.toFixed(2)}%**\n含み益: ${yen(f.value - f.principal)}`,
    inline: false,
  }));

  if (skipped.length > 0) {
    candFields.push({
      name:   '⚠️ 枠オーバーのため除外',
      value:  skipped.map(f => `• ${f.name}（${yen(f.value)}）`).join('\n'),
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🎯 次年度 NISA 移行候補')
    .setColor(0x4ecca3)
    .setDescription(
      `**対象枠:** ${frameLabel}\n` +
      `**今年の利用額:** ${yen(used)}\n` +
      `**残枠:** ${yen(remain)}\n\n` +
      `> 特定口座の銘柄から **含み益率の高い順** に候補を表示しています。\n` +
      `> NISA移行で含み益分の **約20%の税金を節約** できます。`
    )
    .addFields(
      candFields.length > 0
        ? candFields
        : [{ name: '候補なし', value: '含み益のある銘柄が見つかりませんでした', inline: false }]
    )
    .setFooter({ text: '※ 実際のNISA適格性はご自身で確認ください' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/* /rules */
async function handleRules(interaction) {
  await interaction.deferReply();
  const cash      = interaction.options.getInteger('現金');
  const crashMode = interaction.options.getBoolean('暴落モード') || false;
  const crashUsed = interaction.options.getInteger('暴落枠使用済み') || 0;

  let NORMAL_CASH_MIN = 3_000_000;
  let CRASH_CASH_MIN  = 2_000_000;
  let CRASH_FUND_MAX  = 1_000_000;
  try {
    const { settings } = await fetchGasData();
    if (settings.NORMAL_CASH_MIN) NORMAL_CASH_MIN = settings.NORMAL_CASH_MIN;
    if (settings.CRASH_CASH_MIN)  CRASH_CASH_MIN  = settings.CRASH_CASH_MIN;
    if (settings.CRASH_FUND_MAX)  CRASH_FUND_MAX  = settings.CRASH_FUND_MAX;
  } catch (_) {}

  const cashMin     = crashMode ? CRASH_CASH_MIN : NORMAL_CASH_MIN;
  const surplus     = cash - cashMin;
  const crashRemain = CRASH_FUND_MAX - crashUsed;
  const canInvest   = surplus >= 0 && (!crashMode || crashRemain > 0);
  const maxInvest   = crashMode ? Math.min(surplus, crashRemain) : surplus;

  const cashLevel =
    cash >= NORMAL_CASH_MIN ? 5 :
    cash >= CRASH_CASH_MIN  ? 3 : 1;
  const cashBar = '🟩'.repeat(cashLevel) + '⬛'.repeat(5 - cashLevel);

  let rule1Status, rule1Text;
  if (cash >= NORMAL_CASH_MIN) {
    rule1Status = '✅ OK';
    rule1Text   = `現金 ${yen(cash)} ｜ 余剰 **${yen(surplus)}**`;
  } else if (crashMode && cash >= CRASH_CASH_MIN) {
    rule1Status = '⚠️ 暴落中';
    rule1Text   = `暴落モード中 ｜ 最低 ${yen(CRASH_CASH_MIN)} は維持中`;
  } else {
    rule1Status = '❌ NG';
    rule1Text   = `あと **${yen(cashMin - cash)}** 補充が必要`;
  }

  let rule2Status, rule2Text;
  if (!crashMode) {
    rule2Status = 'ℹ️ OFF';
    rule2Text   = `暴落モード OFF ｜ 通常の ${yen(NORMAL_CASH_MIN)} ルール適用中`;
  } else if (crashRemain > 0) {
    rule2Status = '✅ 適用中';
    rule2Text   = `暴落枠 残 **${yen(crashRemain)}** ｜ 最低 ${yen(CRASH_CASH_MIN)} を維持しつつ追加投資可`;
  } else {
    rule2Status = '❌ 枠なし';
    rule2Text   = `暴落枠 ${yen(CRASH_FUND_MAX)} を使い切りました`;
  }

  const embed = new EmbedBuilder()
    .setTitle('📋 投資ルール状態確認')
    .setColor(canInvest ? 0x4ecca3 : 0xff6b8a)
    .setDescription(
      `**モード:** ${crashMode ? '📉 暴落モード ON' : '📊 通常モード'}\n` +
      `**現在の現金:** ${yen(cash)}\n` +
      `${cashBar}  基準: ${yen(cashMin)}`
    )
    .addFields(
      {
        name:   `① 現金維持ルール　${rule1Status}`,
        value:  rule1Text,
        inline: false,
      },
      {
        name:   `② 暴落時特別投資枠　${rule2Status}`,
        value:  rule2Text,
        inline: false,
      },
      {
        name:   canInvest ? '✅ 追加投資　可能' : '❌ 追加投資　不可',
        value:  canInvest
          ? `最大 **${yen(maxInvest)}** まで投資できます`
          : surplus < 0
            ? `現金が ${yen(Math.abs(surplus))} 不足しています`
            : '暴落枠を使い切っています',
        inline: false,
      }
    )
    .setFooter({ text: '投資管理ダッシュボード' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Discord クライアント設定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const SLASH_HANDLERS = {
  market:    handleMarket,
  portfolio: handlePortfolio,
  trades:    handleTrades,
  buy:       handleBuy,
  nisa:      handleNisa,
  rules:     handleRules,
};

// ── 起動時 ──

client.once('clientReady', () => {
  console.log(`✅ Bot 起動完了: ${client.user.tag}`);
  client.user.setActivity('📊 投資を監視中', { type: 3 });
});

// ── スラッシュコマンド ──

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const handler = SLASH_HANDLERS[interaction.commandName];
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (err) {
    const logLine = `[${new Date().toISOString()}] [ERROR] /${interaction.commandName}: ${err.message}\n${err.stack}\n\n`;
    console.error(logLine);
    fs.appendFileSync('bot_error.log', logLine);
    const errMsg = { content: `❌ エラーが発生しました: ${err.message}`, flags: 64 };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(errMsg).catch(() => {});
    } else {
      await interaction.reply(errMsg).catch(() => {});
    }
  }
});

// テキスト返答は ai-corp/index.js が担当
// このbotはスラッシュコマンドのみ処理する

client.login(DISCORD_TOKEN);
