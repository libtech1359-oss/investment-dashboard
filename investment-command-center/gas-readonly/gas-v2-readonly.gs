/**
 * AI Capital v2 — Investment Command Center 読み取り専用API
 *
 * 位置づけ:
 *   - AI-Capital-v2 本体（gas-v2.gs / Node.jsエージェント / scheduler等）とは
 *     完全に独立した「別のApps Scriptプロジェクト」としてデプロイする。
 *   - 参照する Google スプレッドシートは AI Capital v2 と同一（読み取りのみ）。
 *   - このファイルには doPost を実装しない。
 *   - setValue / appendRow / deleteRow / clear など、シートを変更しうる
 *     関数は一切呼び出さない（コード上に存在しない）。
 *   - クライアントから任意のシート名を受け取らない。type は固定ホワイトリスト。
 *
 * 認証:
 *   - スクリプトプロパティ "API_KEY" と、クエリパラメータ ?key= が一致しない
 *     限りすべて unauthorized を返す。
 *   - API_KEY 未設定時は「安全側」として常に拒否する（デプロイ直後の無防備な
 *     公開状態を避けるため）。
 *
 * キャッシュ:
 *   - CacheService（スクリプトキャッシュ）で type + パラメータ単位に5分間
 *     キャッシュする。AI Capital v2 本体（secretary.js等）が同じスプレッド
 *     シートを読みに行くGASクォータを圧迫しないための保護。
 *
 * エラー方針:
 *   - 例外の詳細（シート名・スタックトレース等の内部構造）はクライアントに
 *     返さない。常に "internal error" 等の一般的な文言のみを返し、
 *     詳細は Apps Script の実行ログにのみ記録する。
 */

'use strict';

// ── 設定 ──────────────────────────────────────────────────────
// AI Capital v2 が使用しているスプレッドシートと同一ID（読み取り専用で開く）。
// AI-Capital-v2/_setup_gas.js に記載の値と同一。
var SPREADSHEET_ID = '1NEv0c9wPSJbHnlJFRHD0Su-gGPnZYNxQWRBpXWF1rOA';

var CACHE_TTL_SECONDS      = 300; // 5分（GASクォータ保護優先）
var DEFAULT_ORDERS_LIMIT   = 20;
var MAX_ORDERS_LIMIT       = 100;
var DEFAULT_HISTORY_DAYS   = 90;
var MAX_HISTORY_DAYS       = 365;

// type ホワイトリスト（この配列に無い type は一律 invalid type）
var ALLOWED_TYPES = [
  'dashboard', 'market', 'portfolio', 'positions',
  'votes', 'decision', 'candidates', 'orders', 'capital', 'history',
];

// history の series ホワイトリスト（クライアントからシート名は受け取らない）
var HISTORY_SERIES = ['portfolio', 'market_snapshot'];

var ss = null; // 実行中のみキャッシュするSpreadsheetオブジェクト（グローバル変数の使い回し）

// ════════════════════════════════════════════════════════════════
// エントリーポイント（GETのみ。doPostは実装しない）
// ════════════════════════════════════════════════════════════════
function doGet(e) {
  var params = (e && e.parameter) || {};

  if (!isAuthorized_(params.key)) {
    return jsonOutput_({ ok: false, error: 'unauthorized' });
  }

  var type = params.type;
  if (!type || ALLOWED_TYPES.indexOf(type) === -1) {
    return jsonOutput_({ ok: false, error: 'invalid type', allowed: ALLOWED_TYPES });
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = buildCacheKey_(type, params);

  try {
    var cached = cache.get(cacheKey);
    if (cached) {
      return jsonOutput_(JSON.parse(cached));
    }
  } catch (ignoreCacheReadErr) {
    // キャッシュ読み取り失敗は致命的ではないため無視して通常経路へ
  }

  try {
    var result = buildResponse_(type, params);
    try {
      cache.put(cacheKey, JSON.stringify(result), CACHE_TTL_SECONDS);
    } catch (ignoreCacheWriteErr) {
      // キャッシュ書き込み失敗（サイズ超過等）も致命的ではないため無視
    }
    return jsonOutput_(result);
  } catch (err) {
    // 内部構造（シート名・例外スタック等）を一切含めない
    return jsonOutput_({ ok: false, type: type, error: 'internal error' });
  }
}

// ════════════════════════════════════════════════════════════════
// 認証
// ════════════════════════════════════════════════════════════════
function isAuthorized_(key) {
  var expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!expected) return false; // 未設定時は常に拒否（安全側デフォルト）
  return !!key && key === expected;
}

// ════════════════════════════════════════════════════════════════
// キャッシュキー生成
// type ごとに実際に出力へ影響するパラメータのみをキーに含める。
// 無関係なパラメータを付与してもキャッシュを回避できないようにするため。
//   dashboard / market / portfolio / positions / capital → type のみ
//   votes / decision / candidates                        → type + date
//   orders                                                → type + limit
//   history                                                → type + series + days
// ════════════════════════════════════════════════════════════════
function buildCacheKey_(type, params) {
  var relevant = { type: type };

  if (type === 'votes' || type === 'decision' || type === 'candidates') {
    relevant.date = params.date || '';
  } else if (type === 'orders') {
    relevant.limit = params.limit || '';
  } else if (type === 'history') {
    relevant.series = params.series || '';
    relevant.days = params.days || '';
  }
  // dashboard / market / portfolio / positions / capital: type 以外は追加しない

  return 'v1:' + JSON.stringify(relevant);
}

// ════════════════════════════════════════════════════════════════
// ルーティング（type → ビルダー関数。シート名はここでは一切扱わない）
// ════════════════════════════════════════════════════════════════
function buildResponse_(type, params) {
  var generatedAt = new Date().toISOString();

  switch (type) {
    case 'dashboard':  return { ok: true, type: type, generated_at: generatedAt, data: buildDashboardData_() };
    case 'market':     return { ok: true, type: type, generated_at: generatedAt, data: buildMarketData_() };
    case 'portfolio':  return { ok: true, type: type, generated_at: generatedAt, data: buildPortfolioData_() };
    case 'positions':  return { ok: true, type: type, generated_at: generatedAt, data: buildPositionsData_() };
    case 'votes':      return { ok: true, type: type, generated_at: generatedAt, data: buildVotesData_(params.date) };
    case 'decision':   return { ok: true, type: type, generated_at: generatedAt, data: buildDecisionData_(params.date) };
    case 'candidates': return { ok: true, type: type, generated_at: generatedAt, data: buildCandidatesData_(params.date) };
    case 'orders':     return { ok: true, type: type, generated_at: generatedAt, data: buildOrdersData_(params.limit) };
    case 'capital':    return { ok: true, type: type, generated_at: generatedAt, data: buildCapitalData_() };
    case 'history':    return buildHistoryResponse_(generatedAt, params.series, params.days);
    default:           return { ok: false, type: type, error: 'invalid type', allowed: ALLOWED_TYPES };
  }
}

// ════════════════════════════════════════════════════════════════
// スプレッドシート読み取り（このファイル内で完結。書き込み関数は一切無い）
// ════════════════════════════════════════════════════════════════
function getSpreadsheet_() {
  if (!ss) ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss;
}

// 指定シートの全行をオブジェクト配列で返す（読み取り専用）。
// シート名は各ビルダー関数内でハードコードされた固定値のみを渡す想定
// （クライアント入力から直接渡すことはしない）。
function readSheetRows_(sheetName) {
  var sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var values  = sheet.getDataRange().getValues();
  var headers = values[0];
  var rows    = [];

  for (var i = 1; i < values.length; i++) {
    var raw = values[i];
    if (raw.every(function (c) { return c === '' || c === null; })) continue; // 空行スキップ

    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var header = String(headers[c] || '').trim();
      if (!header) continue;
      obj[header] = normalizeCell_(raw[c]);
    }
    rows.push(obj);
  }
  return rows;
}

// セル値の正規化:
//  - Date型（Sheetsが日付らしき文字列を自動でDate化するケースへの対策）
//    → 時刻要素が全て0なら 'yyyy-MM-dd'、そうでなければ 'yyyy-MM-dd HH:mm:ss'
//  - Boolean型（"TRUE"/"FALSE" 文字列がチェックボックス型セルとして
//    自動認識されるケースへの対策）→ 'true' / 'false' の文字列に統一
//  - それ以外は String() で文字列化（数値セルも文字列として扱い、
//    利用側の数値変換ヘルパーで統一的にパースする）
function normalizeCell_(value) {
  if (value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    var hasTime = value.getHours() !== 0 || value.getMinutes() !== 0 || value.getSeconds() !== 0;
    return Utilities.formatDate(value, 'Asia/Tokyo', hasTime ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
  }
  if (typeof value === 'boolean') return String(value);
  return String(value);
}

// ════════════════════════════════════════════════════════════════
// 値変換ヘルパー
// ════════════════════════════════════════════════════════════════
function toNum_(v) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  if (s === '' || s.toUpperCase() === 'N/A') return null;
  var n = Number(s);
  return isNaN(n) ? null : n;
}

function toBool_(v) {
  return String(v).trim().toUpperCase() === 'TRUE';
}

function toStrOrNull_(v) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  return s === '' ? null : s;
}

// 'date' または 'timestamp' を持つ行の中から最新1件を返す
// （gas-v2.gs の doGet action=latest と同等のロジックをこのファイル内で
//  独立して再実装したもの。gas-v2.gs のコードは一切参照・呼び出ししない）
function pickLatestRow_(rows) {
  var withKey = rows.filter(function (r) { return r.date || r.timestamp; });
  if (withKey.length === 0) return null;
  withKey.sort(function (a, b) {
    var ta = a.timestamp || '';
    var tb = b.timestamp || '';
    if (ta && tb) return tb.localeCompare(ta);
    if (ta) return -1;
    if (tb) return 1;
    return (b.date || '').localeCompare(a.date || '');
  });
  return withKey[0];
}

function maxDate_(rows) {
  var dates = rows.map(function (r) { return r.date; }).filter(Boolean);
  if (dates.length === 0) return null;
  return dates.reduce(function (a, b) { return b > a ? b : a; });
}

// ════════════════════════════════════════════════════════════════
// type=market — market_data
// ════════════════════════════════════════════════════════════════
function buildMarketData_() {
  var rows = readSheetRows_('market_data');
  var latest = pickLatestRow_(rows);
  if (!latest) return null;
  return {
    date:       latest.date || null,
    fear_greed: toNum_(latest.fear_greed),
    vix:        toNum_(latest.vix),
    sp500:      toNum_(latest.sp500),
    nasdaq100:  toNum_(latest.nasdaq100),
    sox:        toNum_(latest.sox),
    gold:       toNum_(latest.gold),
    usdjpy:     toNum_(latest.usdjpy),
  };
}

// ════════════════════════════════════════════════════════════════
// type=portfolio — portfolio_status（positions_json/pending_jsonを展開）
// ════════════════════════════════════════════════════════════════
function buildPortfolioData_() {
  var rows = readSheetRows_('portfolio_status');
  var latest = pickLatestRow_(rows);
  if (!latest) return null;

  return {
    date:              latest.date || null,
    timestamp:         latest.timestamp || null,
    total_assets:      toNum_(latest.total_assets),
    cash:              toNum_(latest.cash),
    invested:          toNum_(latest.invested),
    pending:           toNum_(latest.pending),
    unrealized_pl:     toNum_(latest.unrealized_pl),
    cash_ratio:        toNum_(latest.cash_ratio),
    source_orders:     toNum_(latest.source_orders),
    source_positions:  toNum_(latest.source_positions),
    positions:         parsePositionsJson_(latest.positions_json),
    pending_orders:    parsePendingJson_(latest.pending_json),
  };
}

function parsePositionsJson_(jsonStr) {
  var arr = safeParseArray_(jsonStr);
  return arr.map(function (p) {
    return {
      name:             toStrOrNull_(p.name),
      cost_basis:       toNum_(p.cost_basis),
      market_value:     toNum_(p.market_value),
      unrealized_pl:    toNum_(p.unrealized_pl),
      current_nav:      toNum_(p.current_nav),
      ath_gap_pct:      toNum_(p.ath_gap_pct),
      daily_change_pct: toNum_(p.daily_change_pct),
    };
  });
}

function parsePendingJson_(jsonStr) {
  var arr = safeParseArray_(jsonStr);
  return arr.map(function (p) {
    return { name: toStrOrNull_(p.name), amount: toNum_(p.amount) };
  });
}

function safeParseArray_(jsonStr) {
  if (!jsonStr) return [];
  try {
    var parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return []; // 破損データでもAPI全体を落とさない
  }
}

// ════════════════════════════════════════════════════════════════
// type=positions — positions（常に「現在時点」のフルスナップショット）
// ════════════════════════════════════════════════════════════════
function buildPositionsData_() {
  var rows = readSheetRows_('positions');
  return rows.map(function (r) {
    return {
      asset_name:       toStrOrNull_(r.asset_name),
      quantity:         toNum_(r.quantity),
      cost_basis:       toNum_(r.cost_basis),
      market_value:     toNum_(r.market_value),
      unrealized_pl:    toNum_(r.unrealized_pl),
      current_nav:      toNum_(r.current_nav),
      ath_nav:          toNum_(r.ath_nav),
      ath_gap_pct:      toNum_(r.ath_gap_pct),
      daily_change_pct: toNum_(r.daily_change_pct),
      category:         toStrOrNull_(r.category),
    };
  });
}

// ════════════════════════════════════════════════════════════════
// type=votes — agent_votes（date指定 or 最新日でフィルタ）
// ════════════════════════════════════════════════════════════════
function buildVotesData_(dateParam) {
  var rows = readSheetRows_('agent_votes');
  var targetDate = dateParam || maxDate_(rows);
  if (!targetDate) return { date: null, votes: [] };

  var votes = rows
    .filter(function (r) { return r.date === targetDate; })
    .map(function (r) {
      return {
        department:            toStrOrNull_(r.department),
        signal:                toStrOrNull_(r.signal),
        confidence:            toNum_(r.confidence),
        comment:               toStrOrNull_(r.comment),
        recommendation_asset:  toStrOrNull_(r.recommendation_asset),
        recommendation_amount: toNum_(r.recommendation_amount),
      };
    });

  return { date: targetDate, votes: votes };
}

// ════════════════════════════════════════════════════════════════
// type=decision — final_decisions（date指定 or 最新）
// ════════════════════════════════════════════════════════════════
function buildDecisionData_(dateParam) {
  var rows = readSheetRows_('final_decisions');
  var row = dateParam
    ? rows.filter(function (r) { return r.date === dateParam; })[0]
    : pickLatestRow_(rows);
  if (!row) return null;

  return {
    date:         row.date || null,
    final_signal: toStrOrNull_(row.final_signal),
    target_asset: toStrOrNull_(row.target_asset),
    amount:       toNum_(row.amount),
    reason:       toStrOrNull_(row.reason),
  };
}

// ════════════════════════════════════════════════════════════════
// type=candidates — candidate_assets（date指定 or 最新日でフィルタ、rank昇順）
// 実データにのみ存在する legacy 列（proxy_ok 等）は明示的なフィールド
// 選択により自動的に無視される。
// ════════════════════════════════════════════════════════════════
function buildCandidatesData_(dateParam) {
  var rows = readSheetRows_('candidate_assets');
  var targetDate = dateParam || maxDate_(rows);
  if (!targetDate) return { date: null, candidates: [] };

  var candidates = rows
    .filter(function (r) { return r.date === targetDate; })
    .map(function (r) {
      return {
        asset_id:         toStrOrNull_(r.asset_id),
        asset_name:       toStrOrNull_(r.asset_name),
        full_name:        toStrOrNull_(r.full_name),
        category:         toStrOrNull_(r.category),
        nav:              toNum_(r.nav),
        ath_nav:          toNum_(r.ath_nav),
        ath_gap_pct:      toNum_(r.ath_gap_pct),
        daily_change_pct: toNum_(r.daily_change_pct),
        chg_5d:           toNum_(r.chg_5d),
        chg_20d:          toNum_(r.chg_20d),
        rebound_rate:     toNum_(r.rebound_rate),
        score:            toNum_(r.score),
        rank:             toNum_(r.rank),
        nav_ok:           toBool_(r.nav_ok),
      };
    })
    .sort(function (a, b) {
      var ra = a.rank === null ? Infinity : a.rank;
      var rb = b.rank === null ? Infinity : b.rank;
      return ra - rb;
    });

  return { date: targetDate, candidates: candidates };
}

// ════════════════════════════════════════════════════════════════
// type=orders — orders（date降順、limit件、上限あり）
// ════════════════════════════════════════════════════════════════
function buildOrdersData_(limitParam) {
  var limit = parseInt(limitParam, 10);
  if (isNaN(limit) || limit <= 0) limit = DEFAULT_ORDERS_LIMIT;
  limit = Math.min(limit, MAX_ORDERS_LIMIT);

  var rows = readSheetRows_('orders');
  var sorted = rows.slice().sort(function (a, b) {
    return (b.date || '').localeCompare(a.date || '');
  });

  return sorted.slice(0, limit).map(function (r) {
    return {
      order_id:   toStrOrNull_(r.order_id),
      date:       r.date || null,
      asset_name: toStrOrNull_(r.asset_name),
      amount:     toNum_(r.amount),
      status:     toStrOrNull_(r.status),
    };
  });
}

// ════════════════════════════════════════════════════════════════
// type=capital — capital_events（created_at昇順、累計元本を付与）
// ════════════════════════════════════════════════════════════════
function buildCapitalData_() {
  var rows = readSheetRows_('capital_events');
  var sorted = rows.slice().sort(function (a, b) {
    return (a.created_at || '').localeCompare(b.created_at || '');
  });

  var events = sorted.map(function (r) {
    return {
      event_type:    toStrOrNull_(r.event_type),
      period:        toStrOrNull_(r.period),
      amount:        toNum_(r.amount),
      running_total: toNum_(r.running_total),
      description:   toStrOrNull_(r.description),
      created_at:    r.created_at || null,
    };
  });

  var last = events.length > 0 ? events[events.length - 1] : null;
  return {
    total_principal: last ? last.running_total : 0,
    events: events,
  };
}

// ════════════════════════════════════════════════════════════════
// type=history — series=portfolio | market_snapshot（日付重複排除・日数上限）
// ════════════════════════════════════════════════════════════════
function buildHistoryResponse_(generatedAt, seriesParam, daysParam) {
  if (!seriesParam || HISTORY_SERIES.indexOf(seriesParam) === -1) {
    return { ok: false, type: 'history', error: 'invalid series', allowed: HISTORY_SERIES };
  }

  var days = parseInt(daysParam, 10);
  if (isNaN(days) || days <= 0) days = DEFAULT_HISTORY_DAYS;
  days = Math.min(days, MAX_HISTORY_DAYS);

  var points = seriesParam === 'portfolio'
    ? buildPortfolioHistoryPoints_()
    : buildMarketSnapshotHistoryPoints_();

  var sliced = points.slice(Math.max(0, points.length - days));

  return {
    ok: true, type: 'history', generated_at: generatedAt,
    data: { series: seriesParam, days: sliced.length, points: sliced },
  };
}

// 同一日に複数行ある場合は最後の行（シート上で後に出現する＝最新状態）を採用
function dedupeByDateKeepLast_(rows) {
  var byDate = {};
  var order = [];
  rows.forEach(function (r) {
    if (!r.date) return;
    if (!(r.date in byDate)) order.push(r.date);
    byDate[r.date] = r; // 後勝ち
  });
  order.sort(); // 日付昇順
  return order.map(function (d) { return byDate[d]; });
}

function buildPortfolioHistoryPoints_() {
  var rows = dedupeByDateKeepLast_(readSheetRows_('portfolio_status'));
  return rows.map(function (r) {
    return {
      date:         r.date,
      total_assets: toNum_(r.total_assets),
      cash_ratio:   toNum_(r.cash_ratio),
    };
  });
}

function buildMarketSnapshotHistoryPoints_() {
  var rows = dedupeByDateKeepLast_(readSheetRows_('market_snapshot'));
  return rows.map(function (r) {
    return {
      date:       r.date,
      fear_greed: toNum_(r.fg),
      vix:        toNum_(r.vix),
      usdjpy:     toNum_(r.usdjpy),
      phase:      toStrOrNull_(r.phase),
    };
  });
}

// ════════════════════════════════════════════════════════════════
// type=dashboard — 上記を1回のリクエストにまとめた合成ビュー
// （GAS実行回数を抑えるための推奨デフォルトエンドポイント）
// ════════════════════════════════════════════════════════════════
function buildDashboardData_() {
  return {
    market:     buildMarketData_(),
    portfolio:  buildPortfolioData_(),
    positions:  buildPositionsData_(),
    decision:   buildDecisionData_(null),
    votes:      buildVotesData_(null).votes,
    candidates: buildCandidatesData_(null).candidates,
  };
}

// ════════════════════════════════════════════════════════════════
// レスポンス出力
// ════════════════════════════════════════════════════════════════
function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
