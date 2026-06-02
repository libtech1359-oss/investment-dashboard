'use strict';

// ── fetch with timeout ─────────────────────────────────────
function fetchT(url, ms = 12000) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, {
    signal:  ctrl.signal,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  }).finally(() => clearTimeout(id));
}

// ── GAS取得 ────────────────────────────────────────────────
async function fetchGas(sheet = '') {
  const base = process.env.GAS_URL;
  if (!base) throw new Error('GAS_URL が .env に未設定です');
  const url = base + (sheet ? '?sheet=' + encodeURIComponent(sheet) : '');
  const res  = await fetchT(url, 15000);
  if (!res.ok) throw new Error(`GAS HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(`GAS: ${data.error}`);
  return data;
}

// ── Fear & Greed ───────────────────────────────────────────
async function fetchFearGreed() {
  try {
    const res  = await fetchT('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', 6000);
    if (res.ok) {
      const json = await res.json();
      return { value: Math.round(json.fear_and_greed.score), label: json.fear_and_greed.rating };
    }
  } catch (_) {}
  try {
    const res = await fetchT('https://api.alternative.me/fng/?limit=1', 6000);
    const d   = (await res.json()).data[0];
    return { value: parseInt(d.value), label: d.value_classification };
  } catch (_) {
    return { value: 50, label: 'Neutral（取得失敗）' };
  }
}

// ── フォーマットヘルパー ────────────────────────────────────
const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
const pct = n => (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';

// ── コンテキスト構築（各エージェントへ渡す実データ文字列）──
async function buildContext() {
  console.log('[data] GAS・市場データ取得中...');

  const [gasResult, marketResult, fgResult] = await Promise.allSettled([
    fetchGas(),
    fetchGas('market'),
    fetchFearGreed(),
  ]);

  const lines = [];

  // ── ポートフォリオ概要 ──
  if (gasResult.status === 'fulfilled') {
    const { funds = [], summary = {} } = gasResult.value;

    // gainPct は GAS から小数（0.248 = 24.8%）で来るため元本から直接計算
    const gainPct = summary.totalPrincipal > 0
      ? summary.gainAmount / summary.totalPrincipal * 100
      : 0;

    lines.push('【ポートフォリオ概要】');
    lines.push(`合計評価額 : ${yen(summary.totalValue     || 0)}`);
    lines.push(`合計元本   : ${yen(summary.totalPrincipal || 0)}`);
    lines.push(`含み益     : ${yen(summary.gainAmount     || 0)} (${pct(gainPct)})`);
    lines.push(`前日比     : ${yen(summary.dailyChange    || 0)}`);
    lines.push('');

    // 同名ファンドを口座をまたいで集計
    const byName = {};
    funds.forEach(f => {
      if (!byName[f.name]) byName[f.name] = { value: 0, principal: 0 };
      byName[f.name].value     += f.value     || 0;
      byName[f.name].principal += f.principal || 0;
    });

    lines.push('【保有ファンド】');
    Object.entries(byName).forEach(([name, f]) => {
      const ret = f.principal > 0 ? (f.value - f.principal) / f.principal * 100 : 0;
      lines.push(`・${name}: ${yen(f.value)} (${pct(ret)})`);
    });
  } else {
    lines.push('【ポートフォリオ】取得失敗: ' + (gasResult.reason?.message || '不明'));
  }

  lines.push('');

  // ── 市場指数（GAS marketシート）──
  if (marketResult.status === 'fulfilled' && Array.isArray(marketResult.value) && marketResult.value.length > 0) {
    lines.push('【市場指数】');
    marketResult.value.forEach(m => {
      const chgStr = (Number(m.pct) >= 0 ? '+' : '') + Number(m.pct).toFixed(2) + '%';
      lines.push(`・${m.name}: ${Number(m.price).toLocaleString()} ${chgStr}`);
    });
  } else {
    lines.push('【市場指数】未取得（GASのmarketトリガーが未実行の可能性あり）');
  }

  lines.push('');

  // ── Fear & Greed ──
  const fg = fgResult.status === 'fulfilled' ? fgResult.value : { value: 50, label: '不明' };
  lines.push(`【市場心理 Fear & Greed】${fg.value}/100 — ${fg.label}`);

  const context = lines.join('\n');
  console.log('[data] 取得完了\n' + context);
  return context;
}

module.exports = { buildContext };
