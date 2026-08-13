'use strict';

/* ===== AI Capital Investment Command Center — app.js =====
 * 個人専用・非公開ページ。ReadOnly GAS API（gas-readonly）から
 * type=dashboard を中心に取得し、画面へ描画するだけ。
 * 書き込み・発注・シート更新は一切行わない。
 */

const CFG = window.APP_CONFIG || {};

const DEPT_ORDER = ['マーケット分析部', 'ポートフォリオ管理部', 'リスク管理部', '審査部'];
const DEPT_PERSON = {
  'マーケット分析部':     '神谷シン',
  'リスク管理部':         '黒崎ミサキ',
  'ポートフォリオ管理部': '橘アオイ',
  '審査部':               '鬼塚ガイ',
};

const DEPT_ROLE = {
  'マーケット分析部':     '市場機会の発見担当（銘柄選定・エントリータイミング）',
  'ポートフォリオ管理部': '資産配分・提案額算出担当（銘柄選定は行わない）',
  'リスク管理部':         '提案へのリスク可視化担当（集中投資率・現金比率・分散度）',
  '審査部':               '他部署の議論審査 + 独立した投票・推奨',
};

const SIGNAL_CLASS = {
  BUY: 'sig-BUY', ACCUMULATE: 'sig-ACCUMULATE', WAIT: 'sig-WAIT',
  DEFEND: 'sig-DEFEND', SELL: 'sig-SELL',
};

let historyChart = null;
let historyLoaded = false;

/* ---- HISTORY mode state ---- */
let currentMode = 'today';
let histDate = null;                 // 'yyyy-MM-dd'
const historyCache = {};             // date -> { votes, decision, candidates }
let histRequestSeq = 0;
let ordersFullPromise = null;        // type=orders は date非対応のため一度だけ取得しクライアント側でfilter

/* ---- formatters ---- */
function yenMan(n) {
  if (n === null || n === undefined) return '--';
  return '¥' + Math.round(n / 10000).toLocaleString('ja-JP') + '万';
}
function yenFull(n) {
  if (n === null || n === undefined) return '--';
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}
function pctStr(n, digits) {
  if (n === null || n === undefined) return '--';
  const v = Number(n);
  return (v > 0 ? '+' : '') + v.toFixed(digits == null ? 1 : digits) + '%';
}
function numStr(n, digits) {
  if (n === null || n === undefined) return '--';
  return Number(n).toFixed(digits == null ? 2 : digits);
}
function fgZoneLabel(fg) {
  if (fg === null || fg === undefined) return '-';
  if (fg <= 25) return 'EXTREME FEAR';
  if (fg <= 44) return 'FEAR';
  if (fg <= 55) return 'NEUTRAL';
  if (fg <= 75) return 'GREED';
  return 'EXTREME GREED';
}
function fgColor(fg) {
  if (fg === null || fg === undefined) return 'var(--gray)';
  if (fg <= 25) return 'var(--red)';
  if (fg <= 44) return 'var(--amber)';
  if (fg <= 55) return 'var(--gray)';
  if (fg <= 75) return 'var(--green)';
  return 'var(--green)';
}

/* ---- API ---- */
async function callApi(params) {
  if (!CFG.GAS_URL || !CFG.API_KEY) {
    throw new Error('config.js が未設定です（GAS_URL / API_KEY）');
  }
  const url = new URL(CFG.GAS_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('key', CFG.API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'API error');
  return json.data;
}

/* ---- status indicator ---- */
function setStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  dot.className = 'status-dot' + (state ? ' ' + state : '');
  label.textContent = text;
}

function showError(msg) {
  const terminal = document.getElementById('terminal');
  let banner = document.getElementById('error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'error-banner';
    banner.className = 'error-banner';
    const header = terminal.querySelector('.header-section');
    header.insertAdjacentElement('afterend', wrapBanner(banner));
  }
  banner.textContent = '⚠ ' + msg;
}
function wrapBanner(banner) {
  const wrap = document.createElement('div');
  wrap.className = 'section';
  wrap.style.paddingTop = '0';
  wrap.style.borderTop = 'none';
  wrap.appendChild(banner);
  return wrap;
}
function clearError() {
  const wrap = document.getElementById('error-banner');
  if (wrap && wrap.parentElement) wrap.parentElement.remove();
}

/* ---- render: market / fear&greed ---- */
function renderMarket(market) {
  const fg = market ? market.fear_greed : null;
  document.getElementById('fg-value').textContent = fg === null || fg === undefined ? '--' : fg;
  document.getElementById('fg-zone').textContent = fgZoneLabel(fg);
  const fill = document.getElementById('fg-bar-fill');
  fill.style.width = (fg === null || fg === undefined ? 0 : fg) + '%';
  fill.style.background = fgColor(fg);

  const rows = {
    vix:       market ? market.vix : null,
    sp500:     market ? market.sp500 : null,
    nasdaq100: market ? market.nasdaq100 : null,
    sox:       market ? market.sox : null,
    usdjpy:    market ? market.usdjpy : null,
  };

  setMktCell('mkt-vix', rows.vix, false);
  setMktCell('mkt-sp500', rows.sp500, true);
  setMktCell('mkt-nasdaq100', rows.nasdaq100, true);
  setMktCell('mkt-sox', rows.sox, true);
  setMktCell('mkt-usdjpy', rows.usdjpy, false);
}
function setMktCell(id, value, isPct) {
  const el = document.getElementById(id);
  if (value === null || value === undefined) { el.textContent = '--'; el.className = ''; return; }
  el.textContent = isPct ? pctStr(value, 2) : numStr(value, 2);
  el.className = isPct ? (value > 0 ? 'up' : value < 0 ? 'down' : '') : '';
}

/* ---- render: portfolio ---- */
function renderPortfolio(pf) {
  document.getElementById('pf-total').textContent    = pf ? yenMan(pf.total_assets) : '--';
  document.getElementById('pf-cash').textContent      = pf ? yenMan(pf.cash) : '--';
  document.getElementById('pf-invested').textContent  = pf ? yenMan(pf.invested) : '--';
  const plEl = document.getElementById('pf-pl');
  plEl.textContent = pf ? yenMan(pf.unrealized_pl) : '--';
  plEl.className = 'pf-value' + (pf && pf.unrealized_pl > 0 ? ' pos' : pf && pf.unrealized_pl < 0 ? ' neg' : '');
}

/* ---- render: final decision ---- */
function renderDecisionInto(ids, decision, emptyText) {
  const dot = document.getElementById(ids.dot);
  const label = document.getElementById(ids.label);
  const sub = document.getElementById(ids.sub);

  if (!decision) {
    dot.style.color = 'var(--gray)';
    label.textContent = '--';
    label.className = 'decision-label';
    sub.textContent = emptyText;
    return;
  }
  const cls = SIGNAL_CLASS[decision.final_signal] || '';
  dot.style.color = '';
  dot.className = 'decision-dot ' + cls;
  label.textContent = decision.final_signal || '--';
  label.className = 'decision-label ' + cls;

  const parts = [];
  if (decision.target_asset) {
    parts.push(decision.target_asset + (decision.amount ? ' ' + yenFull(decision.amount) : ''));
  }
  if (decision.reason) parts.push(decision.reason);
  sub.textContent = parts.join(' — ') || '-';
}
function renderDecision(decision) {
  renderDecisionInto(
    { dot: 'decision-dot', label: 'decision-label', sub: 'decision-sub' },
    decision, '本日のデータはまだありません'
  );
}
function renderHistDecision(decision) {
  renderDecisionInto(
    { dot: 'hist-decision-dot', label: 'hist-decision-label', sub: 'hist-decision-sub' },
    decision, '該当日のデータはありません'
  );
}

/* ---- render: department meeting (TODAY / HISTORY 共通) ---- */
function renderDeptGrid(gridId, votes) {
  const grid = document.getElementById(gridId);
  grid.innerHTML = '';
  const byDept = {};
  (votes || []).forEach(v => { byDept[v.department] = v; });

  DEPT_ORDER.forEach(dept => {
    const v = byDept[dept];
    const person = DEPT_PERSON[dept] || dept;
    const cls = v ? (SIGNAL_CLASS[v.signal] || '') : '';

    const cell = document.createElement('div');
    cell.className = 'dept-cell';
    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    cell.innerHTML =
      '<div class="dept-dot ' + cls + '"></div>' +
      '<div class="dept-name">' + escapeHtml(person) + '</div>' +
      '<div class="dept-pct">' + (v ? (v.confidence ?? '--') + '%' : '--') + '</div>';
    cell.addEventListener('click', () => openDeptModal(dept, v));
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDeptModal(dept, v); }
    });
    grid.appendChild(cell);
  });
}
function renderVotes(votes) {
  renderDeptGrid('dept-grid', votes);
}

/* ---- department detail modal ---- */
function openDeptModal(dept, vote) {
  const person = DEPT_PERSON[dept] || dept;
  document.getElementById('modal-dept-name').textContent = person + '（' + dept + '）';
  document.getElementById('modal-dept-role').textContent = DEPT_ROLE[dept] || '';

  const cls = vote ? (SIGNAL_CLASS[vote.signal] || '') : '';
  const dot = document.getElementById('modal-signal-dot');
  dot.style.color = '';
  dot.className = 'decision-dot ' + cls;
  const label = document.getElementById('modal-signal-label');
  label.textContent = vote ? (vote.signal || '--') : '未投票';
  label.className = 'decision-label ' + cls;

  document.getElementById('modal-confidence').textContent =
    vote && vote.confidence !== null && vote.confidence !== undefined ? 'confidence ' + vote.confidence + '%' : '';

  document.getElementById('modal-comment').textContent =
    vote && vote.comment ? vote.comment : '(コメントなし)';

  const extra = document.getElementById('modal-extra');
  if (vote && (vote.recommendation_asset || vote.recommendation_amount !== null)) {
    extra.innerHTML =
      '<div class="modal-extra-row"><span>推奨銘柄</span><span>' + escapeHtml(vote.recommendation_asset || '--') + '</span></div>' +
      '<div class="modal-extra-row"><span>推奨金額</span><span>' + (vote.recommendation_amount !== null && vote.recommendation_amount !== undefined ? yenFull(vote.recommendation_amount) : '--') + '</span></div>';
  } else {
    extra.innerHTML = '';
  }

  document.getElementById('dept-modal-overlay').removeAttribute('hidden');
}
function closeDeptModal() {
  document.getElementById('dept-modal-overlay').setAttribute('hidden', '');
}

/* ---- render: holdings ---- */
function renderHoldings(positions) {
  const rowsEl = document.getElementById('holdings-rows');
  if (!positions || positions.length === 0) {
    rowsEl.innerHTML = '<div class="dim-row">保有銘柄なし</div>';
    return;
  }
  rowsEl.innerHTML = positions.map(p => {
    const athCls = p.ath_gap_pct > 0 ? 'up' : p.ath_gap_pct < 0 ? 'down' : '';
    const dailyCls = p.daily_change_pct > 0 ? 'up' : p.daily_change_pct < 0 ? 'down' : '';
    return '<div class="holdings-row">' +
      '<span>' + escapeHtml(p.asset_name || '-') + '</span>' +
      '<span>' + numStr(p.current_nav, 0) + '</span>' +
      '<span class="' + athCls + '">' + pctStr(p.ath_gap_pct, 1) + '</span>' +
      '<span class="' + dailyCls + '">' + pctStr(p.daily_change_pct, 1) + '</span>' +
      '</div>';
  }).join('');
}

/* ---- render: candidates (TODAY / HISTORY 共通) ---- */
function renderCandidatesInto(elId, candidates) {
  const el = document.getElementById(elId);
  if (!candidates || candidates.length === 0) {
    el.innerHTML = '<div class="dim-row">候補データなし</div>';
    return;
  }
  el.innerHTML = candidates.slice(0, 5).map(c =>
    '<div class="candidate-row">' +
      '<span class="candidate-rank">#' + c.rank + '</span>' +
      '<span class="candidate-name">' + escapeHtml(c.asset_name || '-') + '</span>' +
      '<span class="candidate-score">Score ' + (c.score ?? '--') + '</span>' +
    '</div>'
  ).join('');
}
function renderCandidates(candidates) { renderCandidatesInto('candidates-list', candidates); }
function renderHistCandidates(candidates) { renderCandidatesInto('hist-candidates-list', candidates); }

/* ---- render: orders (TODAY on-demand / HISTORY 共通) ---- */
function renderOrdersInto(elId, orders) {
  const el = document.getElementById(elId);
  if (!orders || orders.length === 0) {
    el.innerHTML = '<div class="dim-row">注文履歴なし</div>';
    return;
  }
  el.innerHTML = orders.map(o =>
    '<div class="order-row">' +
      '<span>' + escapeHtml(o.date || '') + ' ' + escapeHtml(o.asset_name || '') + '</span>' +
      '<span>' + yenFull(o.amount) + ' <span class="order-status">[' + escapeHtml(o.status || '') + ']</span></span>' +
    '</div>'
  ).join('');
}
function renderOrders(orders) { renderOrdersInto('orders-list', orders); }

/* ---- render: history chart (on-demand) ---- */
function renderHistoryChart(points) {
  const canvas = document.getElementById('history-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const labels = (points || []).map(p => p.date);
  const data = (points || []).map(p => p.total_assets);

  if (historyChart) historyChart.destroy();
  historyChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Total Assets',
        data,
        borderColor: '#3ddc84',
        backgroundColor: 'rgba(61,220,132,0.12)',
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: 0.15,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#6b8a76', maxTicksLimit: 6, font: { size: 9 } }, grid: { color: '#1a2620' } },
        y: { ticks: { color: '#6b8a76', font: { size: 9 } }, grid: { color: '#1a2620' } },
      },
    },
  });
}

/* ---- util ---- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---- main dashboard fetch ---- */
async function loadDashboard() {
  setStatus('busy', 'LOADING');
  document.getElementById('refresh-btn').disabled = true;
  try {
    const data = await callApi({ type: 'dashboard' });
    clearError();
    renderMarket(data.market);
    renderPortfolio(data.portfolio);
    renderDecision(data.decision);
    renderVotes(data.votes);
    renderHoldings(data.positions);
    renderCandidates(data.candidates);

    document.getElementById('last-updated').textContent =
      new Date().toLocaleTimeString('ja-JP', { hour12: false });
    setStatus('ok', 'ONLINE');
  } catch (err) {
    setStatus('error', 'OFFLINE');
    showError(err.message);
  } finally {
    document.getElementById('refresh-btn').disabled = false;
  }
}

/* ---- on-demand: orders + history ---- */
async function loadMoreSection() {
  if (historyLoaded) return;
  historyLoaded = true;
  try {
    const [orders, history] = await Promise.all([
      callApi({ type: 'orders', limit: 10 }),
      callApi({ type: 'history', series: 'portfolio', days: 90 }),
    ]);
    renderOrders(orders);
    renderHistoryChart(history.points);
  } catch (err) {
    document.getElementById('orders-list').innerHTML =
      '<div class="dim-row">取得失敗: ' + escapeHtml(err.message) + '</div>';
    historyLoaded = false;
  }
}

/* ---- HISTORY mode: date helpers ---- */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function todayYMD() {
  // API側（gas-readonly）はAsia/Tokyoで日付を正規化しているため、こちらも合わせる
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return map.year + '-' + map.month + '-' + map.day;
}
function addDaysYMD(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
}

function updateHistNavButtons() {
  const isToday = histDate >= todayYMD();
  document.getElementById('hist-next').disabled = isToday;
  document.getElementById('hist-today-btn').disabled = isToday;
}

function initHistoryDate() {
  histDate = todayYMD();
  const input = document.getElementById('hist-date-input');
  input.value = histDate;
  input.max = todayYMD();
  updateHistNavButtons();
}

function changeHistDate(newDate) {
  histDate = newDate;
  document.getElementById('hist-date-input').value = histDate;
  updateHistNavButtons();
  loadHistoryForDate(histDate);
}

/* ---- HISTORY mode: data fetch (votes / decision / candidates は date単位でキャッシュ) ---- */
async function loadHistoryForDate(date) {
  const loadingEl = document.getElementById('hist-loading');
  const errorEl = document.getElementById('hist-error');
  errorEl.hidden = true;
  errorEl.textContent = '';

  if (historyCache[date]) {
    renderHistoryData(historyCache[date]);
  } else {
    const seq = ++histRequestSeq;
    loadingEl.hidden = false;
    try {
      const [votesRes, decision, candidatesRes] = await Promise.all([
        callApi({ type: 'votes', date }),
        callApi({ type: 'decision', date }),
        callApi({ type: 'candidates', date }),
      ]);
      if (seq !== histRequestSeq) return; // 途中で別の日付に切り替わった場合は破棄
      const bundle = { votes: votesRes.votes, decision, candidates: candidatesRes.candidates };
      historyCache[date] = bundle;
      renderHistoryData(bundle);
    } catch (err) {
      if (seq !== histRequestSeq) return;
      errorEl.hidden = false;
      errorEl.textContent = '⚠ ' + err.message;
      renderHistoryData({ votes: [], decision: null, candidates: [] });
    } finally {
      if (seq === histRequestSeq) loadingEl.hidden = true;
    }
  }

  loadHistoryOrders(date);
}

function renderHistoryData(bundle) {
  renderDeptGrid('hist-dept-grid', bundle.votes);
  renderHistDecision(bundle.decision);
  renderHistCandidates(bundle.candidates);
}

// type=orders は date パラメータ非対応（既存API仕様どおり）。
// 全件を一度だけ取得し、クライアント側で選択日にfilterする。
async function loadHistoryOrders(date) {
  const el = document.getElementById('hist-orders-list');
  try {
    if (!ordersFullPromise) {
      ordersFullPromise = callApi({ type: 'orders', limit: 100 });
    }
    const all = await ordersFullPromise;
    const filtered = all.filter(o => o.date === date);
    renderOrdersInto('hist-orders-list', filtered);
  } catch (err) {
    ordersFullPromise = null;
    el.innerHTML = '<div class="dim-row">取得失敗: ' + escapeHtml(err.message) + '</div>';
  }
}

/* ---- HISTORY mode: view switching ---- */
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.view-today').forEach(el => { el.hidden = mode !== 'today'; });
  document.querySelectorAll('.view-history').forEach(el => { el.hidden = mode !== 'history'; });
  document.getElementById('tab-today').classList.toggle('active', mode === 'today');
  document.getElementById('tab-history').classList.toggle('active', mode === 'history');

  if (mode === 'history') {
    if (!histDate) initHistoryDate();
    loadHistoryForDate(histDate);
  }
}

/* ---- events ---- */
document.getElementById('refresh-btn').addEventListener('click', loadDashboard);

document.getElementById('more-toggle').addEventListener('click', () => {
  const section = document.getElementById('more-section');
  const icon = document.getElementById('more-toggle-icon');
  const hidden = section.hasAttribute('hidden');
  if (hidden) {
    section.removeAttribute('hidden');
    icon.innerHTML = '&#9650;';
    loadMoreSection();
  } else {
    section.setAttribute('hidden', '');
    icon.innerHTML = '&#9660;';
  }
});

document.getElementById('tab-today').addEventListener('click', () => setMode('today'));
document.getElementById('tab-history').addEventListener('click', () => setMode('history'));

document.getElementById('hist-prev').addEventListener('click', () => changeHistDate(addDaysYMD(histDate, -1)));
document.getElementById('hist-next').addEventListener('click', () => changeHistDate(addDaysYMD(histDate, 1)));
document.getElementById('hist-today-btn').addEventListener('click', () => changeHistDate(todayYMD()));
document.getElementById('hist-date-input').addEventListener('change', (e) => {
  let v = e.target.value;
  if (!v) return;
  if (v > todayYMD()) v = todayYMD();
  changeHistDate(v);
});

document.getElementById('modal-close-btn').addEventListener('click', closeDeptModal);
document.getElementById('dept-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'dept-modal-overlay') closeDeptModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDeptModal();
});

/* ---- init ---- */
loadDashboard();
setInterval(loadDashboard, 5 * 60 * 1000); // サーバー側キャッシュTTL(5分)に合わせた自動更新
