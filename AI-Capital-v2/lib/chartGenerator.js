'use strict';

/**
 * chartGenerator.js — v2 チャート生成（Playwright SVGレンダリング）
 *
 * ポートフォリオ円グラフ: portfolio_status の pf オブジェクトから生成
 * 元本＆含み益面グラフ:   portfolio_status 全行履歴から生成
 */

const fs   = require('fs');
const path = require('path');

const CHARTS_DIR = path.join(__dirname, '..', 'data', 'charts');

// ── カラーパレット ─────────────────────────────────────────────
const PALETTE = [
  '#4A90D9',
  '#E8A838',
  '#5CB85C',
  '#D9534F',
  '#9B59B6',
  '#1ABC9C',
  '#E67E22',
  '#2ECC71',
];
const PENDING_STRIPE = '#A8C8F0';

// ── ダークテーマ定数 ───────────────────────────────────────────
const BG_DARK       = '#1a1e35';
const GRID_COL      = '#2e3250';
const AXIS_COL      = '#404d6a';
const LABEL_COL     = '#8b92b8';
const TITLE_COL     = '#e8eaf6';
const BASE_FILL     = 'rgba(108,138,255,0.55)';
const BASE_STROKE   = '#6c8aff';
const PROFIT_FILL   = 'rgba(78,204,163,0.45)';
const PROFIT_STROKE = '#4ecca3';
const LOSS_FILL     = 'rgba(255,107,138,0.40)';
const LOSS_STROKE   = '#ff6b8a';

// ── Playwright 共通 ───────────────────────────────────────────
async function svgToPng(svg, width, height, bgColor, outPath) {
  const { chromium } = require('playwright');
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${bgColor}">${svg}</body></html>`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width, height });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    fs.mkdirSync(CHARTS_DIR, { recursive: true });
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width, height } });
  } finally {
    await browser.close();
  }
  return outPath;
}

// ════════════════════════════════════════════════════════════════
// ポートフォリオ円グラフ
// ════════════════════════════════════════════════════════════════

function buildPieChartSvg(slices, total, date) {
  const W = 600, H = 420, CX = 180, CY = 200, R = 150;

  function polarToXY(angleDeg, r = R) {
    const rad = (angleDeg - 90) * Math.PI / 180;
    return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
  }
  function describeSlice(s, e, r = R) {
    const [x1, y1] = polarToXY(s, r);
    const [x2, y2] = polarToXY(e, r);
    return `M ${CX} ${CY} L ${x1} ${y1} A ${r} ${r} 0 ${e - s > 180 ? 1 : 0} 1 ${x2} ${y2} Z`;
  }

  let deg = 0;
  const paths = [], legends = [];
  let colorIdx = 0;

  const defs = `<defs>
    <pattern id="ps" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
      <rect width="8" height="8" fill="${PENDING_STRIPE}" opacity="0.6"/>
      <line x1="0" y1="0" x2="0" y2="8" stroke="white" stroke-width="3"/>
    </pattern></defs>`;

  for (const s of slices) {
    const pct   = total > 0 ? s.amount / total : 0;
    const sweep = pct * 360;
    const end   = deg + sweep;
    const fill  = s.pending ? 'url(#ps)' : PALETTE[colorIdx % PALETTE.length];
    if (!s.pending) colorIdx++;

    if (sweep > 0) {
      if (Math.abs(sweep - 360) < 0.001) {
        paths.push(`<circle cx="${CX}" cy="${CY}" r="${R}" fill="${fill}" stroke="white" stroke-width="2"/>`);
        paths.push(`<text x="${CX}" y="${CY}" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="14" font-weight="bold" font-family="sans-serif">100.0%</text>`);
      } else {
        paths.push(`<path d="${describeSlice(deg, end)}" fill="${fill}" stroke="white" stroke-width="2"/>`);
        if (pct >= 0.05) {
          const [lx, ly] = polarToXY(deg + sweep / 2, R * 0.65);
          paths.push(`<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="12" font-weight="bold" font-family="sans-serif">${(pct * 100).toFixed(1)}%</text>`);
        }
      }
    }
    deg = end;

    const ly   = 60 + legends.length * 30;
    const lc   = s.pending ? PENDING_STRIPE : PALETTE[(colorIdx - (s.pending ? 0 : 1)) % PALETTE.length];
    const lbl  = s.label.length > 14 ? s.label.slice(0, 13) + '…' : s.label;
    legends.push(`
      <rect x="390" y="${ly - 10}" width="16" height="16" fill="${lc}" rx="3"/>
      <text x="412" y="${ly + 2}" font-size="12" font-family="sans-serif" fill="#333">${lbl}${s.pending ? ' ※' : ''}</text>
      <text x="412" y="${ly + 16}" font-size="11" font-family="sans-serif" fill="#666">¥${s.amount.toLocaleString()} (${(pct * 100).toFixed(1)}%)</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${defs}
  <rect width="${W}" height="${H}" fill="#FAFAFA" rx="12"/>
  <text x="${W / 2}" y="30" text-anchor="middle" font-size="16" font-weight="bold" font-family="sans-serif" fill="#222">AI Capital ポートフォリオ</text>
  <text x="${W / 2}" y="50" text-anchor="middle" font-size="12" font-family="sans-serif" fill="#666">${date} 時点</text>
  ${paths.join('\n  ')}
  ${legends.join('\n  ')}
  ${legends.length > 0 ? `<text x="390" y="${60 + legends.length * 30 + 20}" font-size="10" font-family="sans-serif" fill="#999">※ 注文中（未約定）</text>` : ''}
  <text x="${CX}" y="${H - 20}" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#999">合計 ¥${total.toLocaleString()}</text>
</svg>`;
}

/**
 * ポートフォリオ円グラフ PNG を生成する
 * @param {object} pf   portfolio_status の最新行
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<string|null>} PNG パス
 */
async function generatePortfolioChart(pf, date) {
  try {
    const cash     = parseInt(pf.cash ?? 0);
    const total    = parseInt(pf.total_assets ?? 0) || cash;
    const pending  = JSON.parse(pf.pending_json  || '[]');
    const positions = JSON.parse(pf.positions_json || '[]');

    const slices = [];
    slices.push({ label: '現金', amount: cash, pending: false });
    for (const p of positions) {
      slices.push({ label: p.name, amount: parseInt(p.market_value || p.cost_basis || 0), pending: false });
    }
    for (const o of pending) {
      slices.push({ label: o.name, amount: parseInt(o.amount || 0), pending: true });
    }

    const svg     = buildPieChartSvg(slices, total, date);
    const outPath = path.join(CHARTS_DIR, `${date}_portfolio.png`);
    await svgToPng(svg, 600, 420, '#FAFAFA', outPath);
    return outPath;
  } catch (err) {
    console.error(`[chartGenerator] 円グラフ生成失敗: ${err.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// 元本＆含み益 積み上げ面グラフ
// ════════════════════════════════════════════════════════════════

function smoothPath(pts) {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
  const t = 0.3;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) * t / 3;
    const cp1y = p1[1] + (p2[1] - p0[1]) * t / 3;
    const cp2x = p2[0] - (p3[0] - p1[0]) * t / 3;
    const cp2y = p2[1] - (p3[1] - p1[1]) * t / 3;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

function buildHistoryChartSvg(history) {
  const W = 760, H = 320, ML = 80, MR = 24, MT = 48, MB = 36;
  const CW = W - ML - MR, CH = H - MT - MB;
  const yBot = MT + CH;

  const noDataSvg = (msg) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${BG_DARK}" rx="12"/>
  <text x="${W / 2}" y="${H / 2 - 10}" text-anchor="middle" fill="${LABEL_COL}" font-size="13" font-family="sans-serif">投資元本 ＆ 含み益の推移</text>
  <text x="${W / 2}" y="${H / 2 + 14}" text-anchor="middle" fill="${LABEL_COL}" font-size="12" font-family="sans-serif">${msg}</text>
</svg>`;

  if (!history || history.length === 0) return noDataSvg('データ蓄積中…');

  const pts = history.map(r => ({
    date:  r.date,
    base:  Math.max(0, parseInt(r.invested || 0) - parseInt(r.unrealized_pl || 0)),
    value: parseInt(r.invested || 0),
  }));

  if (pts.every(p => p.base === 0 && p.value === 0)) {
    return noDataSvg('現金待機中（投資前）');
  }

  const n   = pts.length;
  const dp  = n === 1 ? [{ ...pts[0] }, { ...pts[0] }] : pts;
  const dn  = dp.length;
  const allVals = dp.flatMap(p => [p.base, p.value]);
  const rawMax  = Math.max(...allVals) * 1.06 || 1_000_000;
  const niceStep = (() => {
    const rough = rawMax / 5;
    const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= rough) return m * mag;
    return mag * 10;
  })();
  const yMax = Math.ceil(rawMax / niceStep) * niceStep;

  const xOf = i => ML + i / (dn - 1) * CW;
  const yOf = v => MT + CH - (v / yMax * CH);

  const grid = [], yLbls = [];
  for (let i = 0; i <= 5; i++) {
    const v = yMax * i / 5;
    const y = yOf(v);
    grid.push(`<line x1="${ML}" y1="${y.toFixed(1)}" x2="${W - MR}" y2="${y.toFixed(1)}" stroke="${GRID_COL}" stroke-width="1"/>`);
    yLbls.push(`<text x="${ML - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="${LABEL_COL}" font-size="10" font-family="sans-serif">${(v / 10000).toFixed(0)}万</text>`);
  }

  const step  = Math.max(1, Math.ceil(dn / 9));
  const xLbls = dp
    .filter((_, i) => (n === 1 ? i === 0 : i % step === 0 || i === dn - 1))
    .map((p, _, arr) => {
      const idx = dp.indexOf(p);
      return `<text x="${xOf(idx).toFixed(1)}" y="${yBot + 20}" text-anchor="middle" fill="${LABEL_COL}" font-size="9" font-family="sans-serif">${p.date.slice(5).replace('-', '/')}</text>`;
    });

  const baseXY  = dp.map((p, i) => [+xOf(i).toFixed(1), +yOf(p.base).toFixed(1)]);
  const valueXY = dp.map((p, i) => [+xOf(i).toFixed(1), +yOf(p.value).toFixed(1)]);
  const hasLoss = pts.some(p => p.value < p.base - 500);
  const gainFill   = hasLoss ? LOSS_FILL   : PROFIT_FILL;
  const gainStroke = hasLoss ? LOSS_STROKE : PROFIT_STROKE;
  const gainLabel  = hasLoss ? '含み損'    : '含み益';

  const baseLine  = smoothPath(baseXY);
  const baseArea  = `${baseLine} L ${xOf(dn - 1).toFixed(1)},${yBot} L ${ML},${yBot} Z`;
  const valueLine = smoothPath(valueXY);
  const baseRevL  = [...baseXY].reverse().map(([x, y]) => `L ${x} ${y}`).join(' ');
  const gainArea  = `${valueLine} ${baseRevL} Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="font-family:sans-serif">
  <defs><clipPath id="cc"><rect x="${ML}" y="${MT}" width="${CW}" height="${CH}"/></clipPath></defs>
  <rect width="${W}" height="${H}" fill="${BG_DARK}" rx="12"/>
  <text x="${W / 2}" y="24" text-anchor="middle" fill="${TITLE_COL}" font-size="13" font-weight="bold">投資元本 ＆ 含み益の推移</text>
  ${grid.join('\n  ')}
  ${yLbls.join('\n  ')}
  <path d="${baseArea}" fill="${BASE_FILL}" clip-path="url(#cc)"/>
  <path d="${baseLine}" fill="none" stroke="${BASE_STROKE}" stroke-width="1.5" clip-path="url(#cc)"/>
  <path d="${gainArea}" fill="${gainFill}" clip-path="url(#cc)"/>
  <path d="${valueLine}" fill="none" stroke="${gainStroke}" stroke-width="1.5" clip-path="url(#cc)"/>
  ${xLbls.join('\n  ')}
  <line x1="${ML}" y1="${MT}" x2="${ML}" y2="${yBot}" stroke="${AXIS_COL}" stroke-width="1"/>
  <line x1="${ML}" y1="${yBot}" x2="${W - MR}" y2="${yBot}" stroke="${AXIS_COL}" stroke-width="1"/>
  <rect x="${ML}" y="34" width="12" height="10" fill="${BASE_FILL}" stroke="${BASE_STROKE}" stroke-width="1" rx="2"/>
  <text x="${ML + 16}" y="43" fill="${TITLE_COL}" font-size="10">元本</text>
  <rect x="${ML + 58}" y="34" width="12" height="10" fill="${gainFill}" stroke="${gainStroke}" stroke-width="1" rx="2"/>
  <text x="${ML + 74}" y="43" fill="${TITLE_COL}" font-size="10">${gainLabel}</text>
</svg>`;
}

/**
 * 積み上げ面グラフ PNG を生成する
 * @param {Array} pfHistory  portfolio_status の全行（日付昇順）
 * @param {string} date      YYYY-MM-DD
 * @returns {Promise<string|null>} PNG パス
 */
async function generateFundHistoryChart(pfHistory, date) {
  try {
    const history = (pfHistory || [])
      .filter(r => parseInt(r.invested || 0) > 0 || parseInt(r.unrealized_pl || 0) !== 0)
      .map(r => ({
        date:  (r.timestamp || r.date || '').slice(0, 10),
        invested:      parseInt(r.invested || 0),
        unrealized_pl: parseInt(r.unrealized_pl || 0),
      }))
      .filter(r => r.date);

    const svg     = buildHistoryChartSvg(history.length > 0 ? history : null);
    const outPath = path.join(CHARTS_DIR, `${date}_history.png`);
    await svgToPng(svg, 760, 320, BG_DARK, outPath);
    return outPath;
  } catch (err) {
    console.error(`[chartGenerator] 面グラフ生成失敗: ${err.message}`);
    return null;
  }
}

module.exports = { generatePortfolioChart, generateFundHistoryChart };
