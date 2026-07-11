/**
 * AI Capital v2 — GAS Web API
 * スプレッドシートの Apps Script エディタに貼り付けてウェブアプリとしてデプロイする。
 *
 * デプロイ設定:
 *   実行ユーザー: 自分
 *   アクセスできるユーザー: 全員（匿名を含む）
 *
 * POST アクション一覧:
 *   upsert         : キー一致行を更新、なければ追加（通常の書き込み）
 *   append         : 末尾に追記
 *   replace_sheet  : シートを全行置換（candidate_assets 等の再生成に使用）
 *   setup_sheets   : 全シートを作成・ヘッダーを初期化（初回セットアップ）
 *   setup_asset_master : asset_master に標準9銘柄を投入（空の場合のみ）
 */

var SS = SpreadsheetApp.getActiveSpreadsheet();

// ── シート定義（setup_sheets アクションで使用） ──────────────
var SHEET_DEFS = [
  {
    name: 'market_data',
    headers: ['date', 'fear_greed', 'vix', 'sp500', 'nasdaq100', 'sox', 'gold', 'usdjpy'],
    color: '#E8F5E9',
  },
  {
    name: 'asset_master',
    headers: ['id', 'short_name', 'full_name', 'proxy_symbol', 'category', 'enabled', 'nav_code'],
    color: '#E8EAF6',
  },
  {
    name: 'nav_prices',
    headers: ['date', 'asset_id', 'asset_name', 'nav'],
    color: '#F1F8E9',
  },
  {
    name: 'candidate_assets',
    headers: ['date', 'asset_id', 'asset_name', 'full_name', 'category',
              'nav', 'ath_nav', 'ath_gap_pct', 'daily_change_pct',
              'chg_5d', 'chg_20d', 'rebound_rate',
              'score', 'rank', 'nav_ok'],
    color: '#E3F2FD',
  },
  {
    name: 'portfolio_status',
    headers: ['timestamp', 'date', 'total_assets', 'cash', 'invested', 'pending',
              'unrealized_pl', 'cash_ratio', 'source_orders', 'source_positions',
              'pending_json', 'positions_json'],
    color: '#FFF9C4',
  },
  {
    name: 'orders',
    headers: ['order_id', 'date', 'asset_name', 'amount', 'status'],
    color: '#FCE4EC',
  },
  {
    name: 'positions',
    headers: ['asset_name', 'quantity', 'cost_basis', 'market_value', 'unrealized_pl',
              'current_nav', 'ath_nav', 'ath_gap_pct', 'daily_change_pct', 'category'],
    color: '#F3E5F5',
  },
  {
    name: 'agent_votes',
    headers: ['date', 'department', 'signal', 'confidence', 'comment',
              'recommendation_asset', 'recommendation_amount'],
    color: '#E0F7FA',
  },
  {
    name: 'final_decisions',
    headers: ['date', 'final_signal', 'target_asset', 'amount', 'reason'],
    color: '#FFF3E0',
  },
  {
    name: 'department_recommendations',
    headers: ['date', 'department', 'asset_id', 'asset_name', 'action',
              'recommended_amount', 'confidence', 'reason'],
    color: '#FCE8B2',
  },
  {
    name: 'agent_recommendations',
    headers: ['date', 'task_id', 'agent_name', 'department', 'recommendation_type',
              'asset_id', 'asset_name', 'amount', 'confidence', 'reason_summary'],
    color: '#E8F5E9',
  },
  {
    name: 'article_decisions',
    headers: ['date', 'task_id', 'final_signal', 'selected_asset', 'selected_amount',
              'market_phase', 'fear_greed', 'vix', 'cash_ratio'],
    color: '#E3F2FD',
  },
  {
    name: 'market_snapshot',
    headers: ['date', 'fg', 'vix', 'usdjpy', 'phase'],
    color: '#F3E5F5',
  },
  {
    name: 'weekly_articles',
    headers: ['week_id', 'start_date', 'end_date', 'status', 'generated_at', 'published_at'],
    color: '#E8EAF6',
  },
  {
    name: 'monthly_articles',
    headers: ['month_id', 'start_date', 'end_date', 'status', 'generated_at', 'published_at', 'schema_version'],
    color: '#FCE4EC',
  },
  {
    name: 'quarterly_articles',
    headers: ['quarter_id', 'start_date', 'end_date', 'status', 'generated_at', 'published_at'],
    color: '#E0F2F1',
  },
  {
    name: 'archives',
    headers: ['article_id', 'article_type', 'report_period', 'date', 'title',
              'signal', 'target_asset', 'amount', 'note_url', 'status',
              'system_version', 'pipeline_status', 'created_at'],
    color: '#FFF8E1',
  },
  {
    name: 'capital_events',
    headers: ['event_id', 'event_type', 'period', 'amount', 'running_total', 'description', 'created_at'],
    color: '#E8F5E9',
  },
  {
    name: 'development_logs',
    headers: ['log_id', 'date', 'phase', 'title', 'summary', 'changes', 'status', 'system_version', 'created_at'],
    color: '#EDE7F6',
  },
  {
    name: 'quality_status',
    headers: ['date', 'article_id', 'validator', 'portfolio', 'orders', 'final_decision',
              'capital_events', 'charts', 'layout', 'overall', 'manual_fix', 'consecutive_pass', 'note'],
    color: '#E8F5E9',
  },
];

// 標準8銘柄（id | short_name | full_name | proxy_symbol | category | enabled | nav_code）
var ASSET_MASTER_SEED = [
  ['allcountry', 'オルカン',   'eMAXIS Slim 全世界株式（オール・カントリー）',         'ACWI',    'core',    'TRUE', '0331418A'],
  ['sp500',      'S&P500',    'eMAXIS Slim 米国株式（S&P500）',                    '^GSPC',   'core',    'TRUE', '03311187'],
  ['nasdaq100',  'NASDAQ100', 'ニッセイNASDAQ100インデックスファンド',                 '^NDX',    'core',    'TRUE', '29313233'],
  ['nikkei225',  '日経平均',   'eMAXIS Slim 国内株式（日経平均）',                    '^N225',   'core',    'TRUE', '03311182'],
  ['fang',       'FANG+',    'iFreeNEXT FANG+インデックス',                        '^NYFANG', 'growth',  'TRUE', '04311181'],
  ['sox',        'SOX',      'iFreeNEXT 全世界半導体株インデックス',                 '^SOX',    'growth',  'TRUE', '04312257'],
  ['ztech20',    'Zテック20',  'iFreePlus 世界トレンド・テクノロジー株（Zテック20）',   '',        'theme',   'TRUE', '0431124C'],
  ['gold',       'ゴールド',   'SBI・iシェアーズ・ゴールドファンド',                   'GC=F',   'defense', 'TRUE', '8931A236'],
];

// ── GET ─────────────────────────────────────────────────────
function doGet(e) {
  try {
    var sheet  = e.parameter.sheet;
    var action = e.parameter.action || 'all';
    var date   = e.parameter.date   || null;

    if (!sheet) return json({ error: 'sheet parameter required' });

    var tab = SS.getSheetByName(sheet);
    if (!tab) return json({ error: 'sheet not found: ' + sheet });

    var rows = getRows(tab);

    if (action === 'latest') {
      var sorted = rows.filter(function(r) { return r.date || r.timestamp; })
        .sort(function(a, b) {
          var ta = a.timestamp || '';
          var tb = b.timestamp || '';
          if (ta && tb) return tb.localeCompare(ta);
          if (ta) return -1;
          if (tb) return 1;
          return (b.date || '').localeCompare(a.date || '');
        });
      return json(sorted[0] || null);
    }

    if (date) {
      return json(rows.filter(function(r) { return r.date === date; }));
    }

    return json(rows);
  } catch (err) {
    return json({ error: err.message });
  }
}

// ── POST ────────────────────────────────────────────────────
function doPost(e) {
  try {
    var body   = JSON.parse(e.postData.contents);
    var action = body.action || 'upsert';

    // ── 特殊セットアップアクション ──────────────────────────
    if (action === 'setup_sheets')       return actionSetupSheets();
    if (action === 'setup_asset_master') return actionSetupAssetMaster(body.force || false);
    if (action === 'delete_date')        return actionDeleteDate(body.sheet, body.date);
    if (action === 'fetch_nav')          return actionFetchNav(body.date);
    if (action === 'debug_url')          return actionDebugUrl(body.url);
    if (action === 'cleanup_portfolio')  return actionCleanupPortfolio(body.dry_run || false);
    if (action === 'clear_sheet')        return actionClearSheet(body.sheet);
    if (action === 'create_slides')      return actionCreateSlides();

    // ── 通常のデータ書き込みアクション ──────────────────────
    var sheet = body.sheet;
    var data  = body.data;
    var keys  = body.keys || ['date'];

    if (!sheet || !data) return json({ error: 'sheet and data required' });

    var tab = SS.getSheetByName(sheet);
    if (!tab) return json({ error: 'sheet not found: ' + sheet });

    if (action === 'append') {
      appendRow(tab, data);
      return json({ ok: true, action: 'appended' });
    }

    if (action === 'replace_sheet') {
      replaceSheet(tab, data, keys);
      return json({ ok: true, action: 'replaced' });
    }

    // デフォルト: upsert
    var result = upsertRow(tab, data, keys);
    return json({ ok: true, action: result });

  } catch (err) {
    return json({ error: err.message });
  }
}

// ── セットアップ: 全シートを作成・欠損列を追加（データ保持） ──
function actionSetupSheets() {
  var results = [];

  for (var i = 0; i < SHEET_DEFS.length; i++) {
    var def   = SHEET_DEFS[i];
    var sheet = SS.getSheetByName(def.name);
    var status, added = [];

    if (!sheet) {
      // 新規作成
      sheet  = SS.insertSheet(def.name);
      sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
      status = 'created';
    } else {
      // 既存シート: 欠損列のみ末尾に追加（データ保持）
      var lastCol  = sheet.getLastColumn();
      var existing = lastCol > 0
        ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
        : [];
      def.headers.forEach(function(h) {
        if (existing.indexOf(h) < 0) {
          var newCol = sheet.getLastColumn() + 1;
          sheet.getRange(1, newCol).setValue(h);
          var headerCell = sheet.getRange(1, newCol);
          headerCell.setBackground(def.color);
          headerCell.setFontWeight('bold');
          headerCell.setFontSize(11);
          added.push(h);
        }
      });
      status = added.length > 0 ? 'patched' : 'exists';
    }

    // nav_code 列は文字列型に強制
    if (def.name === 'asset_master') {
      var navIdx = def.headers.indexOf('nav_code');
      if (navIdx >= 0) {
        sheet.getRange(2, navIdx + 1, 1000, 1).setNumberFormat('@');
      }
    }
    // portfolio_status の timestamp 列を文字列型に強制（Sheetsが日付変換しないよう）
    if (def.name === 'portfolio_status') {
      var tsIdx = def.headers.indexOf('timestamp');
      if (tsIdx >= 0) {
        sheet.getRange(2, tsIdx + 1, 1000, 1).setNumberFormat('@');
      }
    }

    var existingCols = sheet.getLastColumn();
    var headerRange  = sheet.getRange(1, 1, 1, existingCols);
    headerRange.setBackground(def.color);
    headerRange.setFontWeight('bold');
    headerRange.setFontSize(11);

    sheet.setFrozenRows(1);

    results.push({ sheet: def.name, status: status, added: added });
  }

  // デフォルトシートを削除（空の場合のみ）
  var defaultSheet = SS.getSheetByName('シート1') || SS.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() === 0) {
    SS.deleteSheet(defaultSheet);
    results.push({ sheet: 'Sheet1/シート1', status: 'deleted' });
  }

  return json({ ok: true, setup_sheets: results });
}

// ── セットアップ: asset_master に標準9銘柄を投入 ─────────────
// force=true: 既存データを全消去して再投入
// force=false（デフォルト）: 既にデータがある場合はスキップ
function actionSetupAssetMaster(force) {
  var sheet = SS.getSheetByName('asset_master');
  if (!sheet) {
    return json({ error: 'asset_master シートが存在しません。先に setup_sheets を実行してください。' });
  }

  var existingRows = sheet.getLastRow() - 1; // ヘッダー行を除く

  if (existingRows > 0 && !force) {
    return json({
      ok: true,
      skipped: true,
      reason: 'asset_master に既存データ ' + existingRows + ' 行があります。force=true で上書きできます。',
      count: existingRows,
    });
  }

  if (force && existingRows > 0) {
    // ヘッダー行以外を削除
    sheet.deleteRows(2, existingRows);
  }

  // 標準9銘柄を投入
  for (var i = 0; i < ASSET_MASTER_SEED.length; i++) {
    sheet.appendRow(ASSET_MASTER_SEED[i]);
  }

  return json({
    ok: true,
    inserted: ASSET_MASTER_SEED.length,
    assets: ASSET_MASTER_SEED.map(function(r) {
      return { id: r[0], short_name: r[1], proxy_symbol: r[3], category: r[4] };
    }),
  });
}

// ── 日付指定で行を一括削除 ─────────────────────────────────────
function actionDeleteDate(sheetName, date) {
  if (!sheetName || !date) return json({ error: 'sheet and date required' });
  var tab = SS.getSheetByName(sheetName);
  if (!tab) return json({ error: 'sheet not found: ' + sheetName });

  var values  = tab.getDataRange().getValues();
  if (values.length < 2) return json({ ok: true, deleted: 0 });

  var headers = values[0];
  var dateIdx = headers.indexOf('date');
  if (dateIdx < 0) return json({ error: 'date column not found' });

  // 後ろから削除（行番号がズレないよう逆順）
  var deleted = 0;
  for (var i = values.length - 1; i >= 1; i--) {
    if (formatCell(values[i][dateIdx]) === String(date)) {
      tab.deleteRow(i + 1);
      deleted++;
    }
  }
  return json({ ok: true, deleted: deleted });
}

// ── シート全行クリア（ヘッダー保持）─────────────────────────────
// 初期化用。ヘッダー行は残し、データ行をすべて削除する。
function actionClearSheet(sheetName) {
  if (!sheetName) return json({ error: 'sheet required' });
  var tab = SS.getSheetByName(sheetName);
  if (!tab) return json({ ok: true, status: 'not_found', rows_deleted: 0 });

  var lastRow = tab.getLastRow();
  if (lastRow <= 1) return json({ ok: true, status: 'already_empty', rows_deleted: 0 });

  tab.deleteRows(2, lastRow - 1);
  return json({ ok: true, status: 'cleared', rows_deleted: lastRow - 1 });
}

// ── portfolio_status クリーンアップ ─────────────────────────────
// 最新 timestamp の1行のみ残し、古い行をすべて削除する。
// dry_run=true の場合は削除せず現状レポートのみ返す。
function actionCleanupPortfolio(dry_run) {
  var tab = SS.getSheetByName('portfolio_status');
  if (!tab) return json({ error: 'portfolio_status not found' });

  var rows = getRows(tab);
  if (rows.length === 0) return json({ ok: true, deleted: 0, kept: null, rows_before: 0 });

  // timestamp 降順 → date 降順 でソートし最新行を特定
  rows.sort(function(a, b) {
    var ta = a.timestamp || '';
    var tb = b.timestamp || '';
    if (ta && tb) return tb.localeCompare(ta);
    if (ta) return -1;
    if (tb) return 1;
    return (b.date || '').localeCompare(a.date || '');
  });

  var keepRow = rows[0];

  var before = {
    total_rows: rows.length,
    latest:     { timestamp: keepRow.timestamp || '', date: keepRow.date,
                  cash: keepRow.cash, invested: keepRow.invested, cash_ratio: keepRow.cash_ratio },
    all_rows:   rows.map(function(r) {
      return { ts: r.timestamp || '(none)', date: r.date, cash: r.cash, invested: r.invested };
    }),
  };

  if (dry_run) {
    return json({ ok: true, dry_run: true, would_delete: rows.length - 1, before: before });
  }

  // 後ろから削除（行番号ズレ防止）
  var values  = tab.getDataRange().getValues();
  var headers = values[0];
  var tsIdx   = headers.indexOf('timestamp');
  var dateIdx = headers.indexOf('date');

  var keepTs   = keepRow.timestamp || '';
  var keepDate = keepRow.date || '';
  var deleted  = 0;

  // Legacy mode (no timestamp): count matching keepDate rows for bottom-up traversal.
  // Going bottom→top, the LAST match encountered = FIRST row in sheet = rows[0] = keepRow.
  var matchingCounter = 0;
  if (!keepTs) {
    for (var j = 1; j < values.length; j++) {
      if (dateIdx >= 0 && formatCell(values[j][dateIdx]) === keepDate) matchingCounter++;
    }
  }

  for (var i = values.length - 1; i >= 1; i--) {
    var rowTs   = tsIdx   >= 0 ? formatCell(values[i][tsIdx])   : '';
    var rowDate = dateIdx >= 0 ? formatCell(values[i][dateIdx]) : '';

    var shouldDelete;
    if (keepTs) {
      shouldDelete = (rowTs !== keepTs);
    } else {
      if (rowDate === keepDate) {
        matchingCounter--;
        shouldDelete = (matchingCounter > 0);
      } else {
        shouldDelete = true;
      }
    }

    if (shouldDelete) {
      tab.deleteRow(i + 1);
      deleted++;
    }
  }

  return json({ ok: true, deleted: deleted, kept: keepRow, before: before });
}

// ── ヘルパー ─────────────────────────────────────────────────

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function formatCell(val) {
  if (val instanceof Date) {
    var y = val.getFullYear();
    var m = String(val.getMonth() + 1).padStart(2, '0');
    var d = String(val.getDate()).padStart(2, '0');
    var H = String(val.getHours()).padStart(2, '0');
    var M = String(val.getMinutes()).padStart(2, '0');
    var S = String(val.getSeconds()).padStart(2, '0');
    var base = y + '-' + m + '-' + d;
    // 時刻が 00:00:00 以外 = datetime として返す
    if (H !== '00' || M !== '00' || S !== '00') return base + ' ' + H + ':' + M + ':' + S;
    return base;
  }
  return val !== undefined && val !== null ? String(val) : '';
}

function getRows(tab) {
  var values = tab.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  return values.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = formatCell(row[i]); });
    return obj;
  });
}

function getHeaders(tab) {
  var row = tab.getRange(1, 1, 1, tab.getLastColumn()).getValues()[0];
  return row.filter(function(h) { return h !== ''; });
}

function appendRow(tab, data) {
  var headers = getHeaders(tab);
  var row     = headers.map(function(h) { return data[h] !== undefined ? data[h] : ''; });
  tab.appendRow(row);
}

function upsertRow(tab, data, keys) {
  var values  = tab.getDataRange().getValues();
  if (values.length < 1) { appendRow(tab, data); return 'appended'; }

  var headers = values[0];
  var keyIdxs = keys.map(function(k) { return headers.indexOf(k); });

  var targetRow = -1;
  for (var i = 1; i < values.length; i++) {
    var match = keyIdxs.every(function(ki) {
      // formatCell でDate→YYYY-MM-DD変換してから比較（Dateオブジェクトのまま比較すると常に不一致になる）
      return ki >= 0 && formatCell(values[i][ki]) === String(data[headers[ki]] !== undefined ? data[headers[ki]] : '');
    });
    if (match) { targetRow = i + 1; break; }
  }

  var newRow = headers.map(function(h) { return data[h] !== undefined ? data[h] : ''; });

  if (targetRow > 0) {
    tab.getRange(targetRow, 1, 1, newRow.length).setValues([newRow]);
    return 'updated';
  } else {
    tab.appendRow(newRow);
    return 'appended';
  }
}

function replaceSheet(tab, data, keys) {
  // data は配列を想定（複数行）。単一オブジェクトは配列に変換。
  var rows = Array.isArray(data) ? data : [data];
  rows.forEach(function(row) { upsertRow(tab, row, keys); });
}

// ── NAV取得アクション ─────────────────────────────────────────
// POST { action: 'fetch_nav', date: 'YYYY-MM-DD' }
// asset_master の nav_code を読み取り Yahoo Finance Japan → Morningstar の順で取得
// nav_prices シートに upsert（date + asset_id をキー）
function actionFetchNav(targetDate) {
  if (!targetDate) return json({ error: 'date required' });

  var assetTab = SS.getSheetByName('asset_master');
  var navTab   = SS.getSheetByName('nav_prices');
  if (!assetTab) return json({ error: 'asset_master not found' });
  if (!navTab)   return json({ error: 'nav_prices not found. run setup_sheets first.' });

  var assets  = getRows(assetTab);
  var results = [];

  for (var i = 0; i < assets.length; i++) {
    var a = assets[i];
    if (String(a.enabled).toUpperCase() !== 'TRUE') continue;
    if (!a.nav_code) {
      results.push({ asset_id: a.id, skipped: true, reason: 'no nav_code' });
      continue;
    }
    try {
      // Sheetsが先頭ゼロを消す場合があるため8桁にパディング
      var navCode = String(a.nav_code).trim();
      if (/^\d{1,7}$/.test(navCode)) navCode = navCode.padStart(8, '0');
      var nav = fetchNav(navCode);
      upsertRow(navTab, {
        date:       targetDate,
        asset_id:   a.id,
        asset_name: a.short_name,
        nav:        String(nav),
      }, ['date', 'asset_id']);
      results.push({ asset_id: a.id, asset_name: a.short_name, nav: nav });
      Logger.log(a.short_name + ': ¥' + nav);
      Utilities.sleep(600);
    } catch (e) {
      Logger.log('NAV ERROR ' + a.id + ': ' + e.message);
      results.push({ asset_id: a.id, asset_name: a.short_name, nav: null, error: e.message });
    }
  }

  var ok = results.filter(function(r) { return r.nav != null; }).length;
  return json({ ok: true, date: targetDate, fetched: ok, total: results.length, results: results });
}

// エディタから直接実行して UrlFetchApp の認可を取得するためのテスト関数
function testFetchAuthorize() {
  var tests = [
    { url: 'https://kabutan.jp/fund/?code=0331418A', enc: 'UTF-8' },
    { url: 'https://fund-no-umi.com/funds/0331418A', enc: 'UTF-8' },
    { url: 'https://www.rakuten-sec.co.jp/web/fund/detail/?ID=JP90C000CTG0', enc: 'UTF-8' },
    { url: 'https://ifinance.smbc.co.jp/ifin/fund/detail/0331418A', enc: 'UTF-8' },
    { url: 'https://www.fund-explorer.net/fund/0331418A', enc: 'UTF-8' },
  ];
  var opts = {
    muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'ja,en;q=0.9' },
  };
  for (var i = 0; i < tests.length; i++) {
    try {
      var res  = UrlFetchApp.fetch(tests[i].url, opts);
      var code = res.getResponseCode();
      var body = res.getContentText(tests[i].enc);
      var re   = /([0-9,]{4,7})円/g;
      var nums = [], m;
      while ((m = re.exec(body)) !== null) nums.push(m[1]);
      var hasPriceKwd = body.indexOf('基準価') >= 0;
      Logger.log(code + ' hasPriceKwd=' + hasPriceKwd + ' nums=' + nums.join(',') + ' | ' + tests[i].url.slice(8, 50));
    } catch(e) {
      Logger.log('ERR | ' + tests[i].url.slice(8, 50) + ' | ' + e.message.slice(0, 60));
    }
  }
}

// ── URL診断（デバッグ用） ─────────────────────────────────────
function actionDebugUrl(url) {
  if (!url) return json({ error: 'url required' });
  try {
    var res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true,
                                       headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    var code = res.getResponseCode();
    var body = res.getContentText('UTF-8').slice(0, 600);
    var nums = [];
    var re   = /([0-9,]{4,7})円/g;
    var m;
    while ((m = re.exec(body)) !== null) nums.push(m[1]);
    return json({ ok: true, status: code, nums: nums, snippet: body.slice(0, 400) });
  } catch (err) {
    return json({ ok: false, error: err.message });
  }
}

// ── Yahoo Finance Japan スクレイピング ────────────────────────
// URL: https://finance.yahoo.co.jp/quote/{fundCode}（2026年確認済み）
function fetchNavYahoo(fundCode) {
  var url = 'https://finance.yahoo.co.jp/quote/' + fundCode;
  var res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (res.getResponseCode() !== 200) throw new Error('Yahoo JP HTTP ' + res.getResponseCode());

  var html = res.getContentText('UTF-8');

  // __NEXT_DATA__ がある場合はJSONから取得（将来の対応）
  var m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
  if (m) {
    try {
      var nav = findNavInJson(JSON.parse(m[1]), 0);
      if (nav > 0) return nav;
    } catch (_) {}
  }

  // 価格パターン（基準価額の円表示を優先）
  var patterns = [
    /([0-9,]{4,7})円/,                           // 汎用: "2,838円" など
    /"nav"\s*:\s*(\d{4,6})/,
    /"basePrice"\s*:\s*(\d{4,6})/,
    /基準価額[^0-9]*([0-9,]+)/,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var hit = html.match(patterns[i]);
    if (hit) {
      var v = parseInt(hit[1].replace(/,/g, ''));
      if (v >= 1000 && v <= 999999) return v;
    }
  }
  throw new Error('Yahoo JP: 価格なし（' + fundCode + '）');
}

// ── Morningstar Japan フォールバック ──────────────────────────
function fetchNavMorningstar(fundCode) {
  var url = 'https://www.morningstar.co.jp/fund/sr_body.php?id=' + fundCode;
  var res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (res.getResponseCode() !== 200) throw new Error('Morningstar HTTP ' + res.getResponseCode());
  var html = res.getContentText('UTF-8');
  var patterns = [
    /基準価額[^<]*<[^>]+>([0-9,]+)/,
    /class="[^"]*nav[^"]*"[^>]*>([0-9,]+)/i,
    /(\d{4,6})円/,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var hit = html.match(patterns[i]);
    if (hit) {
      var v = parseInt(hit[1].replace(/,/g, ''));
      if (v >= 1000 && v <= 999999) return v;
    }
  }
  throw new Error('Morningstar: 価格なし（' + fundCode + '）');
}

// ── 2段フォールバックでNAV取得 ────────────────────────────────
function fetchNav(fundCode) {
  try { return fetchNavYahoo(fundCode); } catch (e) {
    Logger.log('Yahoo失敗 [' + fundCode + ']: ' + e.message);
  }
  try {
    var nav = fetchNavMorningstar(fundCode);
    Logger.log('Morningstar使用 [' + fundCode + ']: ' + nav);
    return nav;
  } catch (e) {
    Logger.log('Morningstar失敗 [' + fundCode + ']: ' + e.message);
  }
  throw new Error('全プロバイダ失敗（' + fundCode + '）');
}

// ── __NEXT_DATA__ JSON から nav/basePrice を再帰探索 ─────────
function findNavInJson(obj, depth) {
  if (depth > 12 || obj === null || typeof obj !== 'object') return 0;
  if (Array.isArray(obj)) {
    for (var i = 0; i < obj.length; i++) {
      var v = findNavInJson(obj[i], depth + 1);
      if (v > 0) return v;
    }
    return 0;
  }
  for (var key in obj) {
    if ((key === 'nav' || key === 'basePrice') &&
        typeof obj[key] === 'number' &&
        obj[key] >= 1000 && obj[key] <= 999999) {
      return obj[key];
    }
    var vv = findNavInJson(obj[key], depth + 1);
    if (vv > 0) return vv;
  }
  return 0;
}

// ── スライド生成 ──────────────────────────────────────────────
function actionCreateSlides() {
  var url = createV2Presentation();
  return json({ ok: true, url: url });
}
