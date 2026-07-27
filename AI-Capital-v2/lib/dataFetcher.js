'use strict';

/**
 * dataFetcher.js
 * 外部APIから市場データを取得し、以下のシートへ書き込む:
 *   - market_data       : 各指数の日次データ
 *   - candidate_assets  : asset_master（enabled=TRUE）× Yahoo Finance データ
 *   - portfolio_status  : orders シートから自動計算（手動更新不要）
 *   - positions         : 約定済み(filled) orders から自動再構築
 *
 * 銘柄の追加・削除・停止は asset_master シートのみを編集すれば完結する。
 * コード修正は一切不要。
 */

const sheets              = require('./sheets');
const capitalEvents       = require('./capitalEvents');
const { autoFillPendingOrders } = require('./orderManager');
const CANDIDATE_SCORE_WEIGHTS = require('../config/candidateScoreWeights');
const TARGET_ALLOCATION       = require('../config/targetAllocation');

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function todayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function nowJSTTimestamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ');
}

// Fear & Greed スコアをフェーズ文字列に変換（market_snapshot 用）
function fgToPhase(fg) {
  const n = parseFloat(fg || 0);
  if (n <= 25) return '極度の恐怖';
  if (n <= 44) return '恐怖';
  if (n <= 55) return '中立';
  if (n <= 75) return '強欲';
  return '極度の強欲';
}

// VIX スコアをフェーズ文字列に変換（article_decisions 用）
function vixToPhase(vix) {
  const n = parseFloat(vix || 0);
  if (n < 15) return '平穏';
  if (n < 20) return '通常';
  if (n < 30) return '警戒';
  return '危機';
}

function fetchT(url, ms = 12000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, {
    signal:  ctrl.signal,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  }).finally(() => clearTimeout(tid));
}

// ── Fear & Greed（CNN 株式市場指数） ─────────────────────────
// fetchT のデフォルトヘッダーでは 418 を返すため専用ヘッダーを使う
async function fetchFearGreed() {
  const CNN_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(CNN_URL, {
      signal:  ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer':    'https://edition.cnn.com/markets/fear-and-greed',
        'Accept':     'application/json',
      },
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`CNN HTTP ${res.status}`);
    const j = await res.json();
    return Math.round(Number(j?.fear_and_greed?.score ?? 50));
  } catch (e) {
    clearTimeout(tid);
    // alternative.me は暗号通貨指数のためフォールバックとして不適切だが最終手段として保持
    console.warn(`[dataFetcher] CNN Fear & Greed 失敗（${e.message}）→ フォールバックなし`);
    return null;
  }
}

// ── Yahoo Finance スパーク（market_data 用・高速） ───────────
async function fetchYahoo(symbols) {
  const res = await fetchT(
    `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.join(',')}&range=1d&interval=1m`,
    12000
  );
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const out  = {};
  (json?.spark?.result ?? []).forEach(r => {
    const meta = r?.response?.[0]?.meta;
    if (!meta) return;
    const price = meta.regularMarketPrice ?? 0;
    const prev  = meta.previousClose ?? meta.chartPreviousClose ?? price;
    out[r.symbol] = { price, chg_pct: prev ? (price - prev) / prev * 100 : 0 };
  });
  return out;
}

// ── Yahoo Finance チャート（ATH乖離率・前日比 取得） ─────────
// proxy_symbol: Yahoo Finance ティッカー
//   成功時: { chg_pct, ath_gap_pct }（数値）を返す
//   失敗時: null を返す（呼び出し側で proxy_ok=FALSE として処理）
//   設計: proxy_symbol が異なれば必ず別APIコール → 異なる資産が同一データを共有しない
async function fetchCandidateData(proxySymbol) {
  try {
    const res = await fetchT(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(proxySymbol)}?range=1y&interval=1d`,
      12000
    );
    if (!res.ok) return null;
    const j      = await res.json();
    const result = j?.chart?.result?.[0];
    const meta   = result?.meta;
    if (!meta) return null;

    const current = meta.regularMarketPrice ?? 0;
    const high52  = meta.fiftyTwoWeekHigh ?? current;

    // previousClose が欠落する場合（指数など）は、1年チャートの最終営業日終値を使う
    // chartPreviousClose は1年前の価格なので使わない
    const closes      = result?.indicators?.quote?.[0]?.close ?? [];
    const validCloses = closes.filter(c => c != null && c > 0);
    const prev = meta.previousClose
      ?? (validCloses.length > 0 ? validCloses[validCloses.length - 1] : null)
      ?? current;

    return {
      chg_pct:     prev   > 0 ? (current - prev)   / prev   * 100 : 0,
      ath_gap_pct: high52 > 0 ? (current - high52) / high52 * 100 : 0,
    };
  } catch {
    return null;
  }
}

// ── market_data シートへ書き込み ─────────────────────────────
async function writeMarketData() {
  const date = todayJST();

  const [quotes, fear_greed] = await Promise.all([
    fetchYahoo(['^NDX', '^GSPC', '^VIX', 'SOX', 'GC=F', 'USDJPY=X']).catch(() => ({})),
    fetchFearGreed(),
  ]);

  const row = {
    date,
    fear_greed: fear_greed ?? '',
    vix:        quotes['^VIX']?.price?.toFixed(2)    ?? '',
    sp500:      quotes['^GSPC']?.chg_pct?.toFixed(2) ?? '',
    nasdaq100:  quotes['^NDX']?.chg_pct?.toFixed(2)  ?? '',
    sox:        quotes['SOX']?.chg_pct?.toFixed(2)   ?? '',
    gold:       quotes['GC=F']?.chg_pct?.toFixed(2)  ?? '',
    usdjpy:     quotes['USDJPY=X']?.price?.toFixed(2) ?? '',
  };

  await sheets.upsertRow('market_data', ['date'], row);
  console.log(`[dataFetcher] market_data: ${date} FG=${row.fear_greed} VIX=${row.vix} NASDAQ=${row.nasdaq100}%`);

  // market_snapshot: 毎日の市場状態を追跡（後からF&G推移が確認できる）
  const phase = fgToPhase(row.fear_greed);
  await sheets.upsertRow('market_snapshot', ['date'], {
    date,
    fg:     String(row.fear_greed),
    vix:    String(row.vix),
    usdjpy: String(row.usdjpy),
    phase,
  }).catch(e => console.warn(`[dataFetcher] market_snapshot 書き込み失敗（続行）: ${e.message}`));
  console.log(`[dataFetcher] market_snapshot: ${date} FG=${row.fear_greed} phase=${phase}`);

  return row;
}

// ── candidate_assets 生成（nav_prices を唯一のデータソースとして使用） ─
//
// 価格データは nav_prices シートから取得（Yahoo Finance 直接依存を廃止）。
// 各エージェントが共通の確定NAVを参照できる Single Source of Truth 設計。
//
// 出力列:
//   nav, ath_nav, ath_gap_pct, daily_change_pct, chg_5d, chg_20d, rebound_rate
//   score = 総合評価スコア（config/candidateScoreWeights.js の重みで合成）。
//     価格モメンタム（ATH乖離・前日比）とポートフォリオ構成（保有比率・目標配分乖離・
//     カテゴリー分散）を正規化して加重合成する。「下落幅が大きいほど高スコア」という
//     単一方向のロジック（旧: 逆張りスコア）は廃止し、いずれの成分も単独でスコアを
//     支配しない設計にしている。Fear & Greed / VIX は全銘柄共通の値で銘柄間の
//     相対順位を左右しないためスコアには含めない（部署の判断材料として別途提供）。
//   nav_ok: nav_pricesにデータが存在すれば TRUE
//
// 銘柄追加時: asset_master シートへ1行追加するだけで自動対応。コード修正不要。
async function writeCandidateAssets() {
  const date = todayJST();

  let masters;
  try {
    masters = await sheets.getRows('asset_master');
  } catch (err) {
    console.warn(`[dataFetcher] asset_master 読み込み失敗: ${err.message}`);
    return [];
  }

  const enabled = masters.filter(m =>
    String(m.enabled).trim().toUpperCase() === 'TRUE' && m.id && m.short_name
  );
  if (enabled.length === 0) {
    console.warn('[dataFetcher] asset_master に有効な銘柄がありません');
    return [];
  }

  // nav_prices 全履歴からメトリクスを算出
  let navMetrics = {};
  try {
    const navRows = await sheets.getRows('nav_prices');
    navMetrics = calcNavMetrics(navRows);
    console.log(`[dataFetcher] nav_prices: ${navRows.length}行 → ${Object.keys(navMetrics).length}銘柄分メトリクス算出`);
  } catch (err) {
    console.warn(`[dataFetcher] nav_prices 読み込み失敗（N/A で続行）: ${err.message}`);
  }

  // 総合評価スコアに必要なポートフォリオ構成データ（保有比率・目標配分乖離・カテゴリー分散）を取得。
  // updatePortfolioStatus() は run() 内でこの関数より先に実行されるため、当日分が既に存在する。
  let pf = null, positions = [];
  try {
    [pf, positions] = await Promise.all([
      sheets.getLatestRow('portfolio_status').catch(() => null),
      sheets.getRows('positions').catch(() => []),
    ]);
  } catch (err) {
    console.warn(`[dataFetcher] ポートフォリオ構成データ取得失敗（保有・配分成分は0で続行）: ${err.message}`);
  }

  const totalAssets   = pf ? parseFloat(pf.total_assets ?? 0) : 0;
  const investedTotal = pf ? parseFloat(pf.invested ?? 0) : 0;

  const holdingByAsset = {};   // asset_name → market_value
  const categoryTotals = {};   // category → market_value合計
  let categoryTotalSum = 0;
  for (const p of positions) {
    const mv = parseFloat(p.market_value || 0);
    holdingByAsset[p.asset_name] = (holdingByAsset[p.asset_name] || 0) + mv;
    const cat = p.category || 'fund';
    categoryTotals[cat] = (categoryTotals[cat] || 0) + mv;
    categoryTotalSum += mv;
  }

  const W = CANDIDATE_SCORE_WEIGHTS;

  const candidates = enabled.map(m => {
    const nm     = navMetrics[m.id];
    const hasNav = nm != null;

    const nav              = hasNav ? String(nm.nav)                                 : 'N/A';
    const ath_nav          = hasNav ? String(nm.ath_nav)                             : 'N/A';
    const ath_gap_pct      = hasNav ? nm.ath_gap_pct.toFixed(2)                      : 'N/A';
    const daily_change_pct = hasNav ? nm.daily_change_pct.toFixed(2)                 : 'N/A';
    const chg_5d           = hasNav && nm.chg_5d  != null ? nm.chg_5d.toFixed(2)     : 'N/A';
    const chg_20d          = hasNav && nm.chg_20d != null ? nm.chg_20d.toFixed(2)    : 'N/A';
    const rebound_rate     = hasNav ? nm.rebound_rate.toFixed(2)                     : 'N/A';

    const athN   = hasNav ? parseFloat(ath_gap_pct)      : 0;
    const dailyN = hasNav ? parseFloat(daily_change_pct) : 0;

    // 各成分を -1〜+1（保有・カテゴリー成分は -1〜0）に正規化してから重みを掛ける。
    // スケールの異なる指標（%乖離 vs 円ベースの保有比率）を対等に扱うための正規化。
    const athComponent   = clamp(-athN, -30, 30) / 30;      // ATH乖離が大きいほど+1に近づく
    const dailyComponent = clamp(-dailyN, -5, 5) / 5;       // 前日比の下落が大きいほど+1に近づく

    const heldValue        = holdingByAsset[m.short_name] || 0;
    const holdingRatioPct  = totalAssets > 0 ? (heldValue / totalAssets * 100) : 0;
    const holdingComponent = -clamp(holdingRatioPct, 0, 100) / 100; // 保有比率が高いほど減点（集中抑制）

    const currentAllocPct  = investedTotal > 0 ? (heldValue / investedTotal * 100) : 0;
    const targetAllocPct   = TARGET_ALLOCATION[m.short_name] ?? 0;
    const allocationGapPct = targetAllocPct - currentAllocPct; // 不足ならプラス、超過ならマイナス
    const allocationComponent = clamp(allocationGapPct, -50, 50) / 50;

    const categoryMv          = categoryTotals[m.category || 'fund'] || 0;
    const categoryRatioPct    = categoryTotalSum > 0 ? (categoryMv / categoryTotalSum * 100) : 0;
    const categoryComponent   = -clamp(categoryRatioPct, 0, 100) / 100; // カテゴリー内保有比率が高いほど減点（分散推奨）

    const weighted = hasNav
      ? athComponent   * W.ATH_GAP_WEIGHT
      + dailyComponent * W.DAILY_CHANGE_WEIGHT
      + holdingComponent    * W.HOLDING_RATIO_WEIGHT
      + allocationComponent * W.ALLOCATION_GAP_WEIGHT
      + categoryComponent   * W.CATEGORY_DIVERSITY_WEIGHT
      : 0;
    const score = Math.round(weighted * 100);

    return {
      date,
      asset_id:        m.id,
      asset_name:      m.short_name,
      full_name:       m.full_name ?? '',
      category:        m.category ?? 'fund',
      nav,
      ath_nav,
      ath_gap_pct,
      daily_change_pct,
      chg_5d,
      chg_20d,
      rebound_rate,
      score,
      rank:   0,
      nav_ok: hasNav ? 'TRUE' : 'FALSE',
    };
  });

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.nav_ok !== b.nav_ok) return a.nav_ok === 'TRUE' ? -1 : 1;
    return 0;
  });
  candidates.forEach((c, i) => { c.rank = i + 1; });

  for (const c of candidates) {
    await sheets.upsertRow('candidate_assets', ['date', 'asset_id'], c);
  }

  const summary = candidates.map(c => `${c.rank}.${c.asset_name}(score=${c.score})`).join(' ');
  console.log(`[dataFetcher] candidate_assets 完了（総合評価スコア順）: ${candidates.length}銘柄 [${summary}]`);
  return candidates;
}

// ── portfolio_status 変化判定（全数値が一致する場合は append をスキップ） ──
// 比較対象: total_assets / cash / pending / invested / unrealized_pl /
//           cash_ratio / source_orders / source_positions
function pfStateChanged(prev, next) {
  if (!prev) return true; // 前回レコードなし → 必ず append
  const intFields = ['total_assets', 'cash', 'pending', 'invested', 'unrealized_pl', 'source_orders', 'source_positions'];
  for (const f of intFields) {
    if (parseInt(prev[f] ?? 0) !== parseInt(next[f] ?? 0)) return true;
  }
  if (Math.abs(parseFloat(prev.cash_ratio ?? 0) - parseFloat(next.cash_ratio ?? 0)) > 0.05) return true;
  return false;
}

// ── portfolio_status / positions を orders + nav_prices から更新 ─
//
// ordersシートをステータス別に集計し portfolio_status と positions を再構築。
//   filled           → positions（保有銘柄）+ 投資済み金額
//   pending/ordered  → 注文中金額（現金を拘束）
//   cancelled/sold   → スキップ（資金返還済み扱い）
//
// 時価・損益は nav_prices から取得した最新NAV × 口数で計算する（Single Source of Truth）。
// 口数が不明な場合は cost_basis をそのまま市場価値として使う。
// 状態変化がない場合（全数値が前回と一致）は append をスキップする。
async function updatePortfolioStatus() {
  const date   = todayJST();
  const orders = await sheets.getRows('orders').catch(() => []);

  const filledMap  = {};  // asset_id → { asset_name, category, lots }
  const soldMap    = {};  // asset_id → [{ date, amount }] — 財務戦略部REDUCE/SELLによる売却（取得原価相当額）
  const pendingList = []; // [{ name, amount }] — portfolio_status.pending_json 用
  let   pendingAmt = 0;

  for (const o of orders) {
    const amt = parseInt(o.amount ?? 0, 10);
    if (isNaN(amt) || amt <= 0) continue;

    if (o.status === 'filled') {
      const key = o.asset_id || o.asset_name;
      if (!filledMap[key]) {
        filledMap[key] = {
          asset_name: o.asset_name,
          asset_id:   o.asset_id || key,
          category:   o.category || 'fund',
          lots:       [], // [{ date, amount }] — 取得時点NAVの逆引き用（複数回買付時の加重評価に必要）
        };
      }
      filledMap[key].lots.push({ date: o.date, amount: amt });
    } else if (o.status === 'sold') {
      // 財務戦略部（REDUCE/SELL）による売却注文。amountは買い注文と同じ単位（削減する取得原価相当額）。
      const key = o.asset_id || o.asset_name;
      if (!soldMap[key]) soldMap[key] = [];
      soldMap[key].push({ date: o.date, amount: amt });
    } else if (['pending', 'ordered'].includes(o.status)) {
      pendingAmt += amt;
      pendingList.push({ name: o.asset_name, amount: amt });
    }
  }

  // nav_prices から最新NAVメトリクスを取得
  let navMetrics = {};
  try {
    const navRows = await sheets.getRows('nav_prices');
    navMetrics = calcNavMetrics(navRows);
  } catch (e) {
    console.warn(`[dataFetcher] nav_prices 読み込み失敗（暫定値で続行）: ${e.message}`);
  }

  let marketValueTotal = 0;
  let unrealizedTotal  = 0;
  let realizedPlTotal  = 0; // 財務戦略部REDUCE/SELLによる実現損益累計
  const positionsList  = []; // portfolio_status.positions_json 用
  const positionsRows  = []; // positions シート（丸ごと置換）用

  for (const [key, data] of Object.entries(filledMap)) {
    const nm = navMetrics[data.asset_id] || navMetrics[data.asset_name] || null;

    // ── FIFO売却消費 ──────────────────────────────────────────
    // soldMap（財務戦略部REDUCE/SELL）にある分だけ、古いロットから順に取得原価を減らす。
    // 消費したロットは現在NAVで再評価し、原価との差分を実現損益として計上する。
    const lots = data.lots
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(l => ({ ...l })); // clone（破壊的操作のため）

    for (const sell of (soldMap[key] || [])) {
      let toRemove = sell.amount;
      while (toRemove > 0 && lots.length > 0) {
        const lot      = lots[0];
        const consumed = Math.min(lot.amount, toRemove);
        const entryNav = navAsOf(nm, lot.date);
        const proceeds = (nm && entryNav > 0) ? consumed * (nm.nav / entryNav) : consumed;
        realizedPlTotal += proceeds - consumed;
        lot.amount -= consumed;
        toRemove   -= consumed;
        if (lot.amount <= 0) lots.shift();
      }
      if (toRemove > 0) {
        console.warn(`[dataFetcher] ${data.asset_name} 売却額が保有原価を超過: 超過分¥${toRemove.toLocaleString()}を無視`);
      }
    }

    const costBasis = lots.reduce((s, l) => s + l.amount, 0);
    if (costBasis <= 0) continue; // 全売却済み → positions/positions_jsonから除外（ゴースト行防止）

    // 時価 = 残存ロットを取得時点NAV基準で現在NAVに再評価した合計。
    // 取得時点のNAVが引けない場合（データ欠損）は、そのロットのみ取得原価をそのまま使う
    // （従来の暫定動作にフォールバックするだけで、既存ロットの評価を悪化させない）。
    let market_value;
    if (nm && nm.nav > 0) {
      market_value = Math.round(lots.reduce((sum, lot) => {
        const entryNav = navAsOf(nm, lot.date);
        if (!entryNav || entryNav <= 0) return sum + lot.amount;
        return sum + lot.amount * (nm.nav / entryNav);
      }, 0));
    } else {
      market_value = costBasis;
    }
    const unrealized_pl    = market_value - costBasis;
    const current_nav      = nm ? String(nm.nav)            : 'N/A';
    const ath_nav          = nm ? String(nm.ath_nav)         : 'N/A';
    const ath_gap_pct      = nm ? nm.ath_gap_pct.toFixed(2) : 'N/A';
    const daily_change_pct = nm ? nm.daily_change_pct.toFixed(2) : 'N/A';

    marketValueTotal += market_value;
    unrealizedTotal  += unrealized_pl;

    positionsRows.push({
      asset_name:      data.asset_name,
      quantity:        String(lots.length),
      cost_basis:      String(costBasis),
      market_value:    String(market_value),
      unrealized_pl:   String(unrealized_pl),
      current_nav,
      ath_nav,
      ath_gap_pct,
      daily_change_pct,
      category:        data.category,
    });

    // portfolio_status.positions_json 用に収集（エージェント参照用 Single Source of Truth）
    positionsList.push({
      name:            data.asset_name,
      cost_basis:      costBasis,
      market_value,
      unrealized_pl,
      current_nav,
      ath_gap_pct,
      daily_change_pct,
    });
  }

  // positions シートを丸ごと再構築（全売却済み銘柄のゴースト行を残さない）
  // upsertでは行削除ができないため、clear_sheetで全行削除してから書き直す。
  // orders取得が0件の場合はfetch失敗の可能性がある（.catch(()=>[])で握り潰されるため判別不能）ため、
  // 誤って正常なpositionsシートを消さないよう再構築自体をスキップする。
  if (orders.length > 0) {
    await sheets.clearSheet('positions');
    for (const row of positionsRows) {
      await sheets.appendRow('positions', row);
    }
  } else {
    console.warn('[dataFetcher] orders取得0件のためpositionsシート再構築をスキップ（fetch失敗の可能性）');
  }

  const filledTotal   = positionsList.reduce((s, p) => s + p.cost_basis, 0); // 残存ロットの原価合計
  // invested = 約定済みポジションの現在評価額（cost_basis ベース、nav蓄積後は市場価値に移行）
  const invested      = marketValueTotal;
  const unrealizedPl  = marketValueTotal - filledTotal;   // 含み損益 = 評価額 - 取得額

  // 総元本 = capital_events の累計（asOfDate 以前のイベントのみ集計）
  // + realizedPlTotal（財務戦略部REDUCE/SELLによる実現損益。売却で戻った現金分を反映）
  const totalPrincipal = await capitalEvents.calcTotalPrincipal(date);
  const cash           = Math.max(0, totalPrincipal + realizedPlTotal - pendingAmt - filledTotal);
  const totalAssets    = cash + pendingAmt + invested;
  const cashRatio     = totalAssets > 0 ? (cash / totalAssets * 100).toFixed(1) : '100.0';

  const sourceOrders    = orders.length;
  const sourcePositions = positionsList.length;

  // 状態変化チェック — 前回レコードと全数値が一致する場合は append をスキップ
  const prevPf = await sheets.getLatestRow('portfolio_status').catch(() => null);
  const nextSnapshot = {
    total_assets:     String(totalAssets),
    cash:             String(cash),
    pending:          String(pendingAmt),
    invested:         String(invested),
    unrealized_pl:    String(unrealizedPl),
    cash_ratio:       cashRatio,
    source_orders:    String(sourceOrders),
    source_positions: String(sourcePositions),
  };

  if (!pfStateChanged(prevPf, nextSnapshot)) {
    console.log('[Portfolio Status] No changes detected. Skip append.');
    return { cash, pendingAmt, filledTotal, invested, cashRatio, positions: filledMap };
  }

  const timestamp = nowJSTTimestamp();
  await sheets.appendRow('portfolio_status', {
    timestamp,
    date,
    ...nextSnapshot,
    pending_json:   JSON.stringify(pendingList),
    positions_json: JSON.stringify(positionsList),
  });

  const posSummary = sourcePositions > 0
    ? positionsList.map(p => `${p.name}:¥${p.cost_basis.toLocaleString()}`).join(', ')
    : 'なし';

  console.log('[Portfolio Status Rebuild]');
  console.log(`  timestamp=${timestamp}`);
  console.log(`  totalPrincipal=¥${totalPrincipal.toLocaleString()}  （capital_events累計元本）`);
  if (realizedPlTotal !== 0) console.log(`  realizedPl=¥${realizedPlTotal.toLocaleString()}  （財務戦略部REDUCE/SELL実現損益累計）`);
  console.log(`  cash=¥${cash.toLocaleString()}  （自由現金 = 元本 + 実現損益 - pending - filled）`);
  console.log(`  pending=¥${pendingAmt.toLocaleString()}  （注文中・未約定）`);
  console.log(`  invested=¥${invested.toLocaleString()}  （約定済み評価額）`);
  console.log(`  unrealized_pl=¥${unrealizedPl.toLocaleString()}  （含み損益）`);
  console.log(`  total_assets=¥${totalAssets.toLocaleString()}  cash_ratio=${cashRatio}%`);
  console.log(`  source_orders=${sourceOrders}件  source_positions=${sourcePositions}件 [${posSummary}]`);

  return { cash, pendingAmt, filledTotal, invested, cashRatio, positions: filledMap };
}

// ── nav_prices 全履歴からメトリクスを算出 ─────────────────────
// 全部署が参照する唯一の公式価格データとして nav_prices を使う。
// 返値: { [asset_id]: { nav, ath_nav, ath_gap_pct, daily_change_pct,
//                       chg_5d, chg_20d, rebound_rate, asset_name, history_days } }
function calcNavMetrics(navRows) {
  const byAsset = {};
  for (const r of navRows) {
    if (!r.asset_id || !r.nav || isNaN(parseFloat(r.nav))) continue;
    if (!byAsset[r.asset_id]) byAsset[r.asset_id] = [];
    byAsset[r.asset_id].push({ date: r.date, nav: parseFloat(r.nav), asset_name: r.asset_name });
  }

  const metrics = {};
  for (const [id, hist] of Object.entries(byAsset)) {
    hist.sort((a, b) => a.date.localeCompare(b.date));
    const n       = hist.length;
    const current = hist[n - 1].nav;
    const prev    = n >= 2  ? hist[n - 2].nav  : current;
    const nav5d   = n >= 6  ? hist[n - 6].nav  : null;
    const nav20d  = n >= 21 ? hist[n - 21].nav : null;
    const ath     = Math.max(...hist.map(h => h.nav));
    const low20   = Math.min(...hist.slice(Math.max(0, n - 20)).map(h => h.nav));

    const m = {
      asset_name:       hist[n - 1].asset_name,
      nav:              current,
      ath_nav:          ath,
      ath_gap_pct:      ath > 0 ? (current - ath) / ath * 100 : 0,
      daily_change_pct: prev > 0 ? (current - prev) / prev * 100 : 0,
      chg_5d:           nav5d  != null && nav5d  > 0 ? (current - nav5d)  / nav5d  * 100 : null,
      chg_20d:          nav20d != null && nav20d > 0 ? (current - nav20d) / nav20d * 100 : null,
      rebound_rate:     low20 > 0 && low20 < current ? (current - low20) / low20 * 100 : 0,
      history_days:     n,
      history:          hist, // 日付ごとのNAV履歴（取得時点のNAV逆引き用）
    };
    metrics[id] = m;
    // orders シートは asset_id を持たず asset_name のみで記録されるため、
    // asset_name でも同じメトリクスを引けるようにエイリアスを張る。
    if (m.asset_name && !metrics[m.asset_name]) metrics[m.asset_name] = m;
  }
  return metrics;
}

// 指定日以前で直近のNAVを返す（取得日時点の基準価格を近似する）。
// 該当日以前のデータが無ければ最古のNAVにフォールバックする。
function navAsOf(nm, targetDate) {
  if (!nm || !nm.history || nm.history.length === 0) return null;
  let found = null;
  for (const h of nm.history) {
    if (h.date <= targetDate) found = h;
    else break;
  }
  return found ? found.nav : nm.history[0].nav;
}

// ── article_decisions シートへ書き込み ───────────────────────
// signalAggregator 実行直後に secretary.js から呼ぶ。
// 記事生成時の市場コンテキストをスナップショットとして保存する。
async function writeArticleDecision(date, finalDecision) {
  const [mkt, pf] = await Promise.all([
    sheets.getLatestRow('market_data').catch(() => null),
    sheets.getLatestRow('portfolio_status').catch(() => null),
  ]);

  const fg         = mkt ? String(mkt.fear_greed) : '';
  const vix        = mkt ? String(mkt.vix)        : '';
  const cashRatio  = pf  ? String(pf.cash_ratio)  : '';
  const phase      = vixToPhase(vix);

  await sheets.upsertRow('article_decisions', ['date'], {
    date,
    task_id:         date,
    final_signal:    finalDecision?.final_signal  ?? 'WAIT',
    selected_asset:  finalDecision?.target_asset  ?? '',
    selected_amount: String(finalDecision?.amount ?? 0),
    market_phase:    phase,
    fear_greed:      fg,
    vix,
    cash_ratio:      cashRatio,
  });

  console.log(`[dataFetcher] article_decisions: ${date} ${finalDecision?.final_signal} phase=${phase} FG=${fg}`);
  return { date, market_phase: phase };
}

// ── 前営業日を YYYY-MM-DD で返す（JST基準） ──────────────────
function prevBusinessDayJST() {
  // new Date を JST で扱うため toLocaleString で変換
  const jst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  jst.setDate(jst.getDate() - 1);
  while (jst.getDay() === 0 || jst.getDay() === 6) {
    jst.setDate(jst.getDate() - 1);
  }
  return jst.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// ── Yahoo Finance Japan から NAV を直接取得（ローカル実行） ────
// GASのUrlFetchAppはYahoo JPに500を返されるため、Node.jsで直接取得する。
// URL: https://finance.yahoo.co.jp/quote/{nav_code}（2026年確認済み）
async function fetchNavFromYahooLocal(navCode) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`https://finance.yahoo.co.jp/quote/${navCode}`, {
      signal:  ctrl.signal,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,en;q=0.9',
        'Accept':          'text/html',
      },
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // "changePrice" の直前 price = 基準価格（NAV）
    const m = html.match(/"price":"([\d,]+)","changePrice"/);
    if (m) {
      const v = parseInt(m[1].replace(/,/g, ''), 10);
      if (v >= 1000 && v <= 999999) return v;
    }
    throw new Error('価格パターン不一致');
  } finally {
    clearTimeout(tid);
  }
}

// ── NAV取得・nav_prices シートへ書き込み ──────────────────────
// Node.jsから直接Yahoo Finance Japan（ローカルIP）で取得 → GAS upsertRowで書き込む
async function writeNavPrices(targetDate) {
  const date = targetDate || prevBusinessDayJST();
  console.log(`[dataFetcher] NAV取得開始: ${date}`);

  const assets = await sheets.getRows('asset_master').catch(() => []);
  const targets = assets.filter(a => String(a.enabled).toUpperCase() === 'TRUE' && a.nav_code);

  const results = [];
  for (const a of targets) {
    let navCode = String(a.nav_code).trim();
    if (/^\d{1,7}$/.test(navCode)) navCode = navCode.padStart(8, '0');
    try {
      const nav = await fetchNavFromYahooLocal(navCode);
      await sheets.upsertRow('nav_prices', ['date', 'asset_id'], {
        date,
        asset_id:   a.id,
        asset_name: a.short_name,
        nav:        String(nav),
      });
      console.log(`[dataFetcher] NAV ${a.short_name}: ¥${nav.toLocaleString()}`);
      results.push({ asset_id: a.id, asset_name: a.short_name, nav });
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.warn(`[dataFetcher] NAV 取得失敗 ${a.id}: ${e.message}`);
      results.push({ asset_id: a.id, asset_name: a.short_name, nav: null, error: e.message });
    }
  }

  const ok = results.filter(r => r.nav != null).length;
  console.log(`[dataFetcher] NAV完了: ${ok}/${results.length} 取得成功 (${date})`);
  return { ok: true, date, results };
}

// ── エントリーポイント ─────────────────────────────────────────
// 実行順序（エージェント分析前に完了させること）:
//   A. portfolio_status / positions（エージェントが参照するため最優先）
//   B. market_data（外部API取得）
//   C. candidate_assets（asset_master × Yahoo Finance）
async function run() {
  // 前営業日以前の pending 注文を自動約定（filled に遷移）してから portfolio_status を再構築
  const today = todayJST();
  await autoFillPendingOrders(today).catch(err =>
    console.warn(`[dataFetcher] 自動約定スキップ: ${err.message}`)
  );

  await updatePortfolioStatus().catch(err =>
    console.warn(`[dataFetcher] portfolio_status 更新失敗（続行）: ${err.message}`)
  );

  let mkt = null;
  try {
    mkt = await writeMarketData();
  } catch (err) {
    console.warn(`[dataFetcher] market_data 更新失敗（続行）: ${err.message}`);
  }

  await writeCandidateAssets().catch(err =>
    console.warn(`[dataFetcher] candidate_assets 更新失敗（続行）: ${err.message}`)
  );

  return mkt;
}

module.exports = { run, writeMarketData, writeCandidateAssets, updatePortfolioStatus, writeNavPrices, writeArticleDecision, prevBusinessDayJST };
