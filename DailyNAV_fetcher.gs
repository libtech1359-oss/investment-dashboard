// ══════════════════════════════════════════════════════════
//  定数
// ══════════════════════════════════════════════════════════

const SPREADSHEET_ID = '1g-XbbaMy1zGdAwPuFxhMQo6eZYj9Y0Owfxd5mDvYM4Y';
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

// ══════════════════════════════════════════════════════════
//  ダッシュボード API
// ══════════════════════════════════════════════════════════

function doGet(e) {
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = e && e.parameter && e.parameter.sheet;

    if (sheet === 'trades')   return json(getTrades(ss));
    if (sheet === 'prices')   return json(getPrices(ss));
    if (sheet === 'daily')    return json(getDailyPnL(ss));
    if (sheet === 'monthly')  return json(getMonthly(ss));
    if (sheet === 'history')  return json(getHistory(ss));
    if (sheet === 'market')   return json(getMarketData(ss));

    const settings = getSettings(ss);
    return json({
      funds:    getFundData(ss),
      settings: settings,
      summary:  getSummary(ss),
      nisa:     getNisaUsage(ss, settings),
    });

  } catch (err) {
    return json({ error: err.message });
  }
}

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getDailyPnL(ss) {
  const navSheet  = ss.getSheetByName(SHEET_NAME);
  const allData   = navSheet.getDataRange().getValues();
  const headers   = allData[0];
  const changeCol = headers.indexOf('収支前日比');
  if (changeCol === -1) return [];

  return allData.slice(1)
    .filter(r => r[0] && r[changeCol] !== '' && r[changeCol] !== 0)
    .map(r => ({
      date:        Utilities.formatDate(new Date(r[0]), 'Asia/Tokyo', 'yyyy-MM-dd'),
      dailyChange: Number(r[changeCol]) || 0,
    }));
}

function getHistory(ss) {
  const navSheet = ss.getSheetByName(SHEET_NAME);
  const allData  = navSheet.getDataRange().getValues();
  const headers  = allData[0];
  const valCol   = headers.indexOf('評価額合計（自動）');
  const prinCol  = headers.indexOf('合計元本（買-売の純額）');
  if (valCol === -1 || prinCol === -1) return [];

  return allData.slice(1)
    .filter(r => r[0] && (Number(r[prinCol]) > 0 || Number(r[valCol]) > 0))
    .map(r => ({
      date:      Utilities.formatDate(new Date(r[0]), 'Asia/Tokyo', 'yyyy-MM-dd'),
      principal: Number(r[prinCol]) || 0,
      value:     Number(r[valCol])  || 0,
    }));
}

function getMonthly(ss) {
  // 月別投資額（Transactionsの買い合計）
  const txAll     = ss.getSheetByName('Transactions（売買記録）').getDataRange().getValues();
  const txHeaders = txAll[0];
  const dateCol   = txHeaders.indexOf('日付');
  const typeCol   = txHeaders.indexOf('種別');
  const amtCol    = txHeaders.indexOf('金額');

  const monthlyInvest = {};
  txAll.slice(1).forEach(row => {
    if (!row[dateCol] || String(row[typeCol]).trim() !== '買') return;
    const month = Utilities.formatDate(new Date(row[dateCol]), 'Asia/Tokyo', 'yyyy-MM');
    monthlyInvest[month] = (monthlyInvest[month] || 0) + (Number(row[amtCol]) || 0);
  });

  // 月別損益（収支前日比の月次合計）
  const navSheet   = ss.getSheetByName(SHEET_NAME);
  const navData    = navSheet.getDataRange().getValues();
  const navHeaders = navData[0];
  const changeCol  = navHeaders.indexOf('収支前日比');

  const monthlyProfit = {};
  if (changeCol !== -1) {
    navData.slice(1).forEach(row => {
      if (!row[0] || !row[changeCol]) return;
      const month = Utilities.formatDate(new Date(row[0]), 'Asia/Tokyo', 'yyyy-MM');
      monthlyProfit[month] = (monthlyProfit[month] || 0) + (Number(row[changeCol]) || 0);
    });
  }

  const allMonths = [...new Set([...Object.keys(monthlyInvest), ...Object.keys(monthlyProfit)])].sort();
  return allMonths.map(month => ({
    month,
    invest: Math.round(monthlyInvest[month] || 0),
    profit: Math.round(monthlyProfit[month] || 0),
  }));
}

function getPrices(ss) {
  const navSheet = ss.getSheetByName(SHEET_NAME);
  const allData  = navSheet.getDataRange().getValues();
  const headers  = allData[0];
  const out      = [];

  allData.slice(1).forEach(row => {
    const d = row[0];
    if (!d) return;
    const date = Utilities.formatDate(new Date(d), 'Asia/Tokyo', 'yyyy-MM-dd');
    FUND_NAMES.forEach(name => {
      const col   = headers.indexOf(name);
      const price = col !== -1 ? Number(row[col]) : 0;
      if (price > 0) out.push({ date, name, price });
    });
  });

  return out;
}

function getTrades(ss) {
  const txAll    = ss.getSheetByName('Transactions（売買記録）').getDataRange().getValues();
  const headers  = txAll[0];
  const dateCol  = headers.indexOf('日付');
  const frameCol = headers.indexOf('枠区分');
  const nameCol  = headers.indexOf('銘柄');
  const typeCol  = headers.indexOf('種別');
  const amtCol   = headers.indexOf('金額');
  const unitsCol = headers.indexOf('口数');

  return txAll.slice(1)
    .filter(row => row[dateCol])
    .map(row => ({
      date:    Utilities.formatDate(new Date(row[dateCol]), 'Asia/Tokyo', 'yyyy-MM-dd'),
      account: String(row[frameCol] || '').trim(),
      name:    String(row[nameCol]  || '').trim(),
      type:    String(row[typeCol]  || '').trim(),
      amount:  Number(row[amtCol])  || 0,
      units:   Number(row[unitsCol])|| 0,
    }));
}

function getSettings(ss) {
  const rows = ss.getSheetByName('Settings（定数）').getDataRange().getValues();
  const out  = {};
  rows.slice(1).forEach(row => {
    if (row[0]) out[String(row[0])] = Number(row[1]);
  });
  return out;
}

function getFundData(ss) {
  const navSheet   = ss.getSheetByName(SHEET_NAME);
  const navAll     = navSheet.getDataRange().getValues();
  const navHeaders = navAll[0];
  const navRows    = navAll.slice(1).filter(r => r[0] && Number(r[1]) > 0);

  const fundColMap = {};
  FUND_NAMES.forEach(name => {
    const idx = navHeaders.indexOf(name);
    if (idx !== -1) fundColMap[name] = idx;
  });

  const lastRow = navRows[navRows.length - 1];
  const navInfo = {};
  FUND_NAMES.forEach(name => {
    const col = fundColMap[name];
    if (col === undefined) return;
    const currentNav = Number(lastRow[col]) || 0;
    const allNavs    = navRows.map(r => Number(r[col])).filter(v => v > 0);
    const athNav     = allNavs.length > 0 ? Math.max(...allNavs) : 0;
    const athPct     = athNav > 0 ? ((currentNav - athNav) / athNav) * 100 : 0;
    navInfo[name]    = { nav: currentNav, athNav, athPct };
  });

  const txAll     = ss.getSheetByName('Transactions（売買記録）').getDataRange().getValues();
  const txHeaders = txAll[0];
  const frameCol  = txHeaders.indexOf('枠区分');
  const nameCol   = txHeaders.indexOf('銘柄');
  const typeCol   = txHeaders.indexOf('種別');
  const amtCol    = txHeaders.indexOf('金額');
  const unitsCol  = txHeaders.indexOf('口数');

  const holdings = {};
  txAll.slice(1).forEach(row => {
    const fund   = String(row[nameCol]  || '').trim();
    const frame  = String(row[frameCol] || '').trim();
    const type   = String(row[typeCol]  || '').trim();
    const amount = Number(row[amtCol])  || 0;
    const units  = Number(row[unitsCol])|| 0;
    if (!fund || !frame || !type) return;

    const key = `${fund}__${frame}`;
    if (!holdings[key]) holdings[key] = { name: fund, account: frame, units: 0, principal: 0 };
    if (type === '買') {
      holdings[key].units     += units;
      holdings[key].principal += amount;
    } else if (type === '売') {
      holdings[key].units     -= units;
      holdings[key].principal -= amount;
    }
  });

  return Object.values(holdings)
    .filter(h => h.units > 0.001)
    .map(h => {
      const ni    = navInfo[h.name] || { nav: 0, athNav: 0, athPct: 0 };
      const value = h.units * ni.nav / 10000;
      return {
        name:      h.name,
        account:   h.account,
        value:     Math.round(value),
        principal: Math.round(h.principal),
        units:     Math.round(h.units * 1000) / 1000,
        nav:       ni.nav,
        athPct:    Math.round(ni.athPct * 100) / 100,
      };
    });
}

function getSummary(ss) {
  const navSheet = ss.getSheetByName(SHEET_NAME);
  const allData  = navSheet.getDataRange().getValues();
  const headers  = allData[0];
  const rows     = allData.slice(1).filter(r => r[0] && Number(r[1]) > 0);
  const last     = rows[rows.length - 1];
  const col      = name => headers.indexOf(name);
  return {
    date:           Utilities.formatDate(new Date(last[0]), 'Asia/Tokyo', 'yyyy-MM-dd'),
    totalPrincipal: Number(last[col('合計元本（買-売の純額）')]) || 0,
    totalValue:     Number(last[col('評価額合計（自動）')])      || 0,
    gainAmount:     Number(last[col('含み益額')])                || 0,
    gainPct:        Number(last[col('含み益率(%)')])             || 0,
    dailyChange:    Number(last[col('収支前日比')])              || 0,
  };
}

function getNisaUsage(ss, settings) {
  const txAll    = ss.getSheetByName('Transactions（売買記録）').getDataRange().getValues();
  const headers  = txAll[0];
  const dateCol  = headers.indexOf('日付');
  const frameCol = headers.indexOf('枠区分');
  const typeCol  = headers.indexOf('種別');
  const amtCol   = headers.indexOf('金額');

  const year = new Date().getFullYear();
  let growthUsed = 0, tsumiUsed = 0;

  txAll.slice(1).forEach(row => {
    const d = row[dateCol];
    if (!d) return;
    const rowYear = (d instanceof Date ? d : new Date(d)).getFullYear();
    if (rowYear !== year) return;
    if (String(row[typeCol]).trim() !== '買') return;
    const amt   = Number(row[amtCol]) || 0;
    const frame = String(row[frameCol]).trim();
    if (frame === '成長' || frame === '成長枠') growthUsed += amt;
    if (frame === '積立' || frame === '積立枠') tsumiUsed  += amt;
  });

  const growthLimit = settings.NISA_GROWTH_MAX || 2400000;
  const tsumiLimit  = settings.NISA_TSUMI_MAX  || 1200000;
  return {
    year,
    growthUsed,
    growthLimit,
    growthRemain: growthLimit - growthUsed,
    tsumiUsed,
    tsumiLimit,
    tsumiRemain:  tsumiLimit - tsumiUsed,
  };
}

// ══════════════════════════════════════════════════════════
//  DailyNAV 自動取得（トリガー実行）
// ══════════════════════════════════════════════════════════

function isBusinessDay(date) {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  try {
    const cal = CalendarApp.getCalendarById('ja.japanese#holiday@group.v.calendar.google.com');
    const d0  = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
    const d1  = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);
    return cal.getEvents(d0, d1).length === 0;
  } catch (e) {
    Logger.log('祝日カレンダー取得失敗（営業日として続行）: ' + e.message);
    return true;
  }
}

function fetchNav(fundCode) {
  const url = 'https://finance.yahoo.co.jp/funds/detail/' + fundCode;
  const res  = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());

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
  throw new Error('価格が見つかりません（コード: ' + fundCode + '）');
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

function fetchDailyNAV() {
  const today    = new Date();
  const todayStr = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy/MM/dd');

  if (!isBusinessDay(today)) {
    Logger.log(todayStr + ' は非営業日のためスキップ');
    return;
  }

  const navMap = {};
  for (const name in FUND_CODES) {
    try {
      navMap[name] = fetchNav(FUND_CODES[name]);
      Logger.log(name + ': ¥' + navMap[name]);
      Utilities.sleep(500);
    } catch (e) {
      Logger.log('ERROR ' + name + ': ' + e.message);
    }
  }

  if (Object.keys(navMap).length === 0) {
    Logger.log('取得できたデータが0件のため中断');
    return;
  }

  const ss       = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet    = ss.getSheetByName(SHEET_NAME);
  const headers  = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const lastRow  = sheet.getLastRow();
  const allDates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

  for (let i = 0; i < allDates.length; i++) {
    const cell = allDates[i][0];
    if (cell && Utilities.formatDate(new Date(cell), 'Asia/Tokyo', 'yyyy/MM/dd') === todayStr) {
      Logger.log(todayStr + ' は既に記録済みのためスキップ');
      return;
    }
  }

  const newRowNum = lastRow + 1;
  sheet.getRange(lastRow, 1, 1, headers.length).copyTo(
    sheet.getRange(newRowNum, 1, 1, headers.length),
    SpreadsheetApp.CopyPasteType.PASTE_FORMULA,
    false
  );

  sheet.getRange(newRowNum, 1).setValue(todayStr);
  sheet.getRange(newRowNum, 1).setNumberFormat('yyyy/MM/dd');

  for (const name in navMap) {
    const col = headers.indexOf(name);
    if (col !== -1) sheet.getRange(newRowNum, col + 1).setValue(navMap[name]);
  }
  SpreadsheetApp.flush();
  Logger.log('✅ ' + todayStr + ' 書き込み完了 → ' + JSON.stringify(navMap));
}

function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'fetchDailyNAV')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // 毎日 23:45 JST（基準価格は23時頃に更新されるため）
  ScriptApp.newTrigger('fetchDailyNAV')
    .timeBased().everyDays(1).atHour(23).nearMinute(45).inTimezone('Asia/Tokyo').create();

  Logger.log('✅ トリガー設定完了（毎日 23:45 JST）');
}

function testFetch() {
  const name = 'オルカン';
  const code = FUND_CODES[name];
  Logger.log('テスト取得: ' + name + '（' + code + '）');
  try {
    const nav = fetchNav(code);
    Logger.log('✅ 取得成功: ¥' + nav);
  } catch (e) {
    Logger.log('❌ 取得失敗: ' + e.message);
  }
}

// ══════════════════════════════════════════════════════════
//  世界市場データ取得（10分トリガー）
// ══════════════════════════════════════════════════════════

const MARKET_SYMBOLS = {
  '^N225':    { name: '日経平均',    ico: '🇯🇵', cat: 'stocks' },
  '^IXIC':    { name: 'NASDAQ',      ico: '💻',  cat: 'stocks' },
  '^GSPC':    { name: 'S&P500',      ico: '📈',  cat: 'stocks' },
  '^SOX':     { name: 'SOX 半導体',  ico: '💾',  cat: 'stocks' },
  '^VIX':     { name: 'VIX 恐怖指数',ico: '😨',  cat: 'stocks' },
  'USDJPY=X': { name: 'ドル円',      ico: '💱',  cat: 'forex'  },
  'GC=F':     { name: 'ゴールド',    ico: '🥇',  cat: 'forex'  },
};

function fetchAndSaveMarketData() {
  const symbols = Object.keys(MARKET_SYMBOLS);
  const url = 'https://query1.finance.yahoo.com/v7/finance/spark?symbols='
    + symbols.map(encodeURIComponent).join(',') + '&range=2d&interval=1d';

  try {
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());

    const json    = JSON.parse(res.getContentText());
    const results = json.spark && json.spark.result ? json.spark.result : [];

    const rows = [['symbol','name','ico','cat','price','prev','chg','pct','currency','updated']];
    results.forEach(function(r) {
      const meta = r.response && r.response[0] && r.response[0].meta;
      if (!meta) return;
      const info  = MARKET_SYMBOLS[r.symbol];
      if (!info)  return;
      const price = meta.regularMarketPrice;
      const prev  = meta.previousClose || meta.chartPreviousClose || price;
      const chg   = price - prev;
      const pct   = prev ? (chg / prev * 100) : 0;
      rows.push([
        r.symbol,
        info.name,
        info.ico,
        info.cat,
        Math.round(price * 100) / 100,
        Math.round(prev  * 100) / 100,
        Math.round(chg   * 100) / 100,
        Math.round(pct   * 100) / 100,
        meta.currency || '',
        Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'),
      ]);
    });

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let mSheet = ss.getSheetByName('market');
    if (!mSheet) mSheet = ss.insertSheet('market');
    mSheet.clearContents();
    mSheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);

    Logger.log('✅ Market: ' + (rows.length - 1) + '件 @ '
      + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm'));
  } catch (e) {
    Logger.log('❌ Market error: ' + e.message);
  }
}

function getMarketData(ss) {
  const mSheet = ss.getSheetByName('market');
  if (!mSheet || mSheet.getLastRow() < 2) return [];
  const data    = mSheet.getDataRange().getValues();
  const headers = data[0];
  return data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function setupMarketTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'fetchAndSaveMarketData'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('fetchAndSaveMarketData')
    .timeBased().everyMinutes(10).create();
  Logger.log('✅ Market trigger: 10分ごと設定完了');
}
