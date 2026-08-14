// ══════════════════════════════════════════════════════════
//  定数
// ══════════════════════════════════════════════════════════
// 日次投資トラッカー_再構築版（xlsx→Googleスプレッドシート変換版）用の
// DailyNAV自動取得スクリプト。D:\AI\gas-daily-nav\DailyNAV_fetcher.gs の
// fetchDailyNAV系ロジックのみを移植（ダッシュボードAPI・市場データ取得は対象外）。

const SPREADSHEET_ID = '1Bu9YCk3-2P5rajk6lcBPSG7x2xRlcMzyTPE53EJXtZQ';
const SHEET_NAME     = 'DailyNAV（日次価格）';

const FUND_CODES = {
  'オルカン':   '0331418A',
  'S&P500':    '03311187',
  'FANG+':     '04311181',
  'NASDAQ100': '29313233',
  '半導体':    '04312257',
  'ゴールド':  '8931A236',
  'Zテック20': '0431124C',
  '国内株式':  '03311182',
  '宇宙株':    '03311185',
};

const FUND_NAMES = Object.keys(FUND_CODES);

// toushin-lib.fwg.ne.jp（投資信託協会）用ISINコード。Yahoo/Morningstarが失敗した際の第3フォールバック。
const FUND_ISIN = {
  'オルカン':   'JP90C000H1T1',
  'S&P500':    'JP90C000GKC6',
  'FANG+':     'JP90C000FZD4',
  'NASDAQ100': 'JP90C000PDY6',
  '半導体':    'JP90C000S1V4',
  'ゴールド':  'JP90C000PLM4',
  'Zテック20': 'JP90C000RE97',
  '国内株式':  'JP90C000FXV1',
  '宇宙株':    'JP90C000GR20',
};

// AI Capital v2 の GAS Web App（nav_prices 参照元）
const GAS_V2_URL = 'https://script.google.com/macros/s/AKfycbwULriAMqbjcjq6zsMC4kA9_cmJURVyxUz3mh65nebEUS33KvELQjkerSAFQC0yL9w6hg/exec';

// v2 nav_prices の asset_name → DailyNAV列名（名称が異なる銘柄のみ）
const V2_NAME_MAP = {
  'SOX':     '半導体',
  '日経平均': '国内株式',
  '宇宙開発': '宇宙株',
};

// ══════════════════════════════════════════════════════════
//  DailyNAV 自動取得（トリガー実行）
// ══════════════════════════════════════════════════════════

// ── NAV取得 Provider 1: Yahoo Finance Japan（現行）────────────────────
function fetchNavYahoo(fundCode) {
  const url = 'https://finance.yahoo.co.jp/funds/detail/' + fundCode;
  const res  = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (res.getResponseCode() !== 200) throw new Error('Yahoo JP HTTP ' + res.getResponseCode());

  const html = res.getContentText('UTF-8');
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
  if (m) {
    try {
      const nav = findNavInJson(JSON.parse(m[1]), 0);
      if (nav > 0) return nav;
    } catch (_) {}
  }

  const patterns = [
    /"nav"\s*:\s*(\d{4,6})/,
    /"basePrice"\s*:\s*(\d{4,6})/,
    /基準価格[^\d]*(\d{1,3}(?:,\d{3})+|\d{4,6})/,
  ];
  for (const pat of patterns) {
    const hit = html.match(pat);
    if (hit) return parseInt(hit[1].replace(/,/g, ''));
  }
  throw new Error('Yahoo JP: 価格が見つかりません（コード: ' + fundCode + '）');
}

// ── NAV取得 Provider 2: Morningstar Japan（独立プロバイダ）────────────
function fetchNavMorningstar(fundCode) {
  // Morningstar Japan は投信コードをそのまま id パラメータに使える
  const url = 'https://www.morningstar.co.jp/fund/sr_body.php?id=' + fundCode;
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (res.getResponseCode() !== 200) throw new Error('Morningstar HTTP ' + res.getResponseCode());
  const html = res.getContentText('UTF-8');

  const patterns = [
    /基準価額[^<]*<[^>]+>([0-9,]+)/,
    /class="[^"]*nav[^"]*"[^>]*>([0-9,]+)/i,
    /(\d{4,6})円/,
  ];
  for (const pat of patterns) {
    const hit = html.match(pat);
    if (hit) {
      const v = parseInt(hit[1].replace(/,/g, ''));
      if (v >= 1000 && v <= 999999) return v;
    }
  }
  throw new Error('Morningstar: 価格が見つかりません（コード: ' + fundCode + '）');
}

// ── NAV取得 Provider 3: 投資信託協会 toushin-lib（ISINコード方式）──────
function fetchNavToushinLib(isin) {
  const url = 'https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000?isinCd=' + isin;
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (res.getResponseCode() !== 200) throw new Error('toushin-lib HTTP ' + res.getResponseCode());
  const html = res.getContentText('UTF-8');
  const m = html.match(/h3 font-weight-bold">\s*([\d,]+)\s*</);
  if (m) {
    const v = parseInt(m[1].replace(/,/g, ''));
    if (v >= 1000 && v <= 999999) return v;
  }
  throw new Error('toushin-lib: 価格が見つかりません（ISIN: ' + isin + '）');
}

// ── NAV取得メイン（3段フォールバック）────────────────────────────────
// fundName: FUND_CODES/FUND_ISIN のキー（例: 'オルカン'）
function fetchNav(fundName) {
  const fundCode = FUND_CODES[fundName];
  const isin     = FUND_ISIN[fundName];

  // Provider 1: Yahoo Finance Japan
  try {
    return fetchNavYahoo(fundCode);
  } catch (e) {
    Logger.log('NAV Yahoo失敗 [' + fundName + ']: ' + e.message);
  }
  // Provider 2: Morningstar Japan
  try {
    const nav = fetchNavMorningstar(fundCode);
    Logger.log('NAV Morningstar使用 [' + fundName + ']: ' + nav);
    return nav;
  } catch (e) {
    Logger.log('NAV Morningstar失敗 [' + fundName + ']: ' + e.message);
  }
  // Provider 3: 投資信託協会 toushin-lib（ISINコード）
  try {
    const nav = fetchNavToushinLib(isin);
    Logger.log('NAV toushin-lib使用 [' + fundName + ']: ' + nav);
    return nav;
  } catch (e) {
    Logger.log('NAV toushin-lib失敗 [' + fundName + ']: ' + e.message);
  }
  throw new Error('全NAVプロバイダ失敗（' + fundName + ' / コード: ' + fundCode + '）');
}

function findNavInJson(obj, depth) {
  if (depth > 12 || obj === null || typeof obj !== 'object') return 0;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = findNavInJson(obj[i], depth + 1);
      if (v > 0) return v;
    }
    return 0;
  }
  for (const key in obj) {
    if ((key === 'nav' || key === 'basePrice') &&
        typeof obj[key] === 'number' &&
        obj[key] >= 1000 && obj[key] <= 999999) {
      return obj[key];
    }
    const v = findNavInJson(obj[key], depth + 1);
    if (v > 0) return v;
  }
  return 0;
}

// v2 nav_prices から対象日の行を取得
function fetchNavPricesFromV2(dateStr) {
  const url = GAS_V2_URL + '?sheet=nav_prices&date=' + encodeURIComponent(dateStr);
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('v2 nav_prices HTTP ' + res.getResponseCode());
  const rows = JSON.parse(res.getContentText());
  if (!Array.isArray(rows)) throw new Error('v2 nav_prices: 不正なレスポンス');
  return rows;
}

// v2の prevBusinessDayJST() と同一ロジック（土日のみスキップ、祝日は考慮しない）。
// v2側のnav_pricesは常にこの計算式で日付ラベルを付けているため、日付キーを一致させるには
// 「暦日-1」ではなく必ずこの「直前の営業日（v2基準）」を使うこと。
function prevBusinessDayV2Aligned(fromDate) {
  const d = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

function fetchDailyNAV() {
  const today     = new Date();
  const target    = prevBusinessDayV2Aligned(today); // v2のnav_prices日付ラベルと一致させる
  const targetStr = Utilities.formatDate(target, 'Asia/Tokyo', 'yyyy/MM/dd');
  const targetIso = Utilities.formatDate(target, 'Asia/Tokyo', 'yyyy-MM-dd');
  // target は prevBusinessDayV2Aligned() で既に土日を除いた平日として確定済み。
  // 実際の祝日（市場休場）は下のnav_prices 0件チェックで自然にスキップされるため、
  // 祝日カレンダーによる追加判定は行わない。

  let rows;
  try {
    rows = fetchNavPricesFromV2(targetIso);
  } catch (e) {
    Logger.log('nav_prices取得失敗: ' + e.message);
    return;
  }

  const navMap = {};
  rows.forEach(r => {
    const mapped = V2_NAME_MAP[r.asset_name] || r.asset_name;
    if (FUND_NAMES.indexOf(mapped) !== -1 && r.nav) {
      navMap[mapped] = Number(r.nav);
    }
  });

  if (Object.keys(navMap).length === 0) {
    Logger.log(targetIso + ' のnav_pricesデータが0件。直接取得にフォールバックします');
  }

  // v2のnav_pricesに存在しない銘柄（例: 宇宙株はv2のasset_masterに未登録）や、
  // v2側が完全に0件だった日（例: PC再起動でv2のNAV取得ジョブが未実行だった日）は
  // 前日値がそのままコピーされてしまうため、v1の直接取得にフォールバックする
  FUND_NAMES.forEach(name => {
    if (navMap[name] !== undefined) return;
    try {
      navMap[name] = fetchNav(name);
      Logger.log(name + ': v2にデータなし→直接取得で補完 ¥' + navMap[name]);
    } catch (e) {
      Logger.log(name + ': v2にデータなし、直接取得も失敗（前日値を維持）: ' + e.message);
    }
  });

  const ss       = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet    = ss.getSheetByName(SHEET_NAME);
  const headers  = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const lastRow  = sheet.getLastRow();
  const allDates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

  for (let i = 0; i < allDates.length; i++) {
    const cell = allDates[i][0];
    if (cell && Utilities.formatDate(new Date(cell), 'Asia/Tokyo', 'yyyy/MM/dd') === targetStr) {
      Logger.log(targetStr + ' は既に記録済みのためスキップ');
      return;
    }
  }

  const newRowNum = lastRow + 1;
  // 列2以降だけ数式をコピー（列1=日付の書式継承を防ぐ）
  sheet.getRange(lastRow, 2, 1, headers.length - 1).copyTo(
    sheet.getRange(newRowNum, 2, 1, headers.length - 1),
    SpreadsheetApp.CopyPasteType.PASTE_FORMULA,
    false
  );

  // 時刻なしのDateオブジェクトで日付を明示的にセット
  const dateOnly = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  sheet.getRange(newRowNum, 1).setValue(dateOnly);
  sheet.getRange(newRowNum, 1).setNumberFormat('yyyy/mm/dd');

  for (const name in navMap) {
    const col = headers.indexOf(name);
    if (col !== -1) sheet.getRange(newRowNum, col + 1).setValue(navMap[name]);
  }
  SpreadsheetApp.flush();
  Logger.log('✅ ' + targetStr + ' 書き込み完了（v2 nav_prices由来）→ ' + JSON.stringify(navMap));
}

function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'fetchDailyNAV')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // v2側のnav_prices書き込み（毎日11:30 JST）・v2市場会議パイプライン（12:00開始）より後、
  // かつ元のgas-daily-navの実行（13:00）とも重ならないよう13:10に設定。
  ScriptApp.newTrigger('fetchDailyNAV')
    .timeBased().everyDays(1).atHour(13).nearMinute(10).inTimezone('Asia/Tokyo').create();

  Logger.log('✅ トリガー設定完了（毎日 13:10 JST、v2 nav_prices書き込み・市場会議パイプライン完了後）');
}

function testFetch() {
  const name = 'オルカン';
  Logger.log('テスト取得: ' + name + '（' + FUND_CODES[name] + '）');
  try {
    const nav = fetchNav(name);
    Logger.log('✅ 取得成功: ¥' + nav);
  } catch (e) {
    Logger.log('❌ 取得失敗: ' + e.message);
  }
}
