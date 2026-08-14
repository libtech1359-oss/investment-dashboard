// ══════════════════════════════════════════════════════════
//  次年度NISA投資戦略判定システム
//  対象スプレッドシート: 日次投資トラッカー_再構築版
// ══════════════════════════════════════════════════════════
// Phase1: データ基盤整備（資金ルール設定シートの新設）
//
// 防衛資金・暴落時特別枠のルールをシート化する。
// 「現在の暴落が“○○ショック級”に該当するか」はAIが自動判定・断定しない。
// SHOCK_MODE_ACTIVE はユーザーが手動でTRUE/FALSEを切り替える運用とし、
// 判定エンジン（Phase4）はこのフラグの値をそのまま参照するのみに留める。

const CASH_RULES_SHEET_NAME = '資金ルール';

function setupCashRulesSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CASH_RULES_SHEET_NAME);
  if (sheet) {
    throw new Error('「' + CASH_RULES_SHEET_NAME + '」シートは既に存在します。誤って再実行していないか確認してください。');
  }
  sheet = ss.insertSheet(CASH_RULES_SHEET_NAME);

  const rows = [
    ['キー', '値', '説明'],
    ['DEFENSE_FUND_MIN', 2000000, '生活防衛資金。通常時はこの金額を下回るまで投資に回さない'],
    ['SHOCK_SPECIAL_RESERVE', 500000, '「○○ショック級」暴落時のみ解放できる特別買い増し枠'],
    ['SHOCK_MODE_ACTIVE', false, '現在が「○○ショック級」に該当するとユーザーが判断したか（手動フラグ。AIは自動判定しない）'],
    ['SHOCK_MODE_NOTE', '', 'ショックの名称・判断根拠の自由記述欄（例: 2026年◯月 ◯◯ショック）'],
  ];

  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(3, 420);

  // SHOCK_MODE_ACTIVE をチェックボックスにする（B4セル）
  const checkboxRule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange(4, 2).setDataValidation(checkboxRule);

  SpreadsheetApp.flush();
  Logger.log('✅ 「' + CASH_RULES_SHEET_NAME + '」シートを作成しました');
}

// 資金ルールを読み取るヘルパー（Phase4判定エンジンから利用予定）
function getCashRules() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CASH_RULES_SHEET_NAME);
  if (!sheet) throw new Error('「' + CASH_RULES_SHEET_NAME + '」シートが見つかりません。先に setupCashRulesSheet() を実行してください。');

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const rules = {};
  data.forEach(([key, value]) => { rules[key] = value; });

  // Phase4A追加: CURRENT_CASH（現在の現金残高・手動入力）。
  // 未追加のスプレッドシート（addCurrentCashFieldToCashRules()未実行）でも
  // rules.CURRENT_CASH は単に undefined になるだけで、他の既存フィールドの
  // 読み取りには一切影響しない（後方互換性を維持）。
  const rawCurrentCash = rules.CURRENT_CASH;
  let currentCash;
  if (rawCurrentCash === undefined || rawCurrentCash === null || rawCurrentCash === '') {
    currentCash = null; // 未入力（安全側: NisaStrategyEngine()側でinvestableCash=0扱いにする）
  } else {
    const n = Number(rawCurrentCash);
    currentCash = isNaN(n) ? NaN : n; // 不正値もそのまま返し、呼び出し側で安全側判定させる
  }

  return {
    defenseFundMin: Number(rules.DEFENSE_FUND_MIN),
    shockSpecialReserve: Number(rules.SHOCK_SPECIAL_RESERVE),
    shockModeActive: Boolean(rules.SHOCK_MODE_ACTIVE),
    shockModeNote: String(rules.SHOCK_MODE_NOTE || ''),
    // 実際に投資に回してよい現金の上限計算に使う「保護すべき最低現金」
    // 通常時: defenseFundMin全額を保護
    // ショックモード時: defenseFundMinのうちshockSpecialReserve分だけ解放可能
    protectedCashMin: rules.SHOCK_MODE_ACTIVE
      ? Number(rules.DEFENSE_FUND_MIN) - Number(rules.SHOCK_SPECIAL_RESERVE)
      : Number(rules.DEFENSE_FUND_MIN),
    currentCash: currentCash,
  };
}

// Phase4A: 「資金ルール」シートにCURRENT_CASH（現在の現金残高・手動入力欄）を追加する。
// 既存の4項目（DEFENSE_FUND_MIN等）は変更しない。1回だけ実行するマイグレーション関数。
function addCurrentCashFieldToCashRules() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CASH_RULES_SHEET_NAME);
  if (!sheet) throw new Error('「' + CASH_RULES_SHEET_NAME + '」シートが見つかりません。先に setupCashRulesSheet() を実行してください。');

  const existingKeys = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().map(r => r[0]);
  if (existingKeys.indexOf('CURRENT_CASH') !== -1) {
    throw new Error('CURRENT_CASHは既に追加済みです。誤って再実行していないか確認してください。');
  }

  const newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, 3).setValues([[
    'CURRENT_CASH', '',
    '現在の現金残高（手動入力・都度更新）。未入力・不正値の場合はNisaStrategyEngine()が安全側に倒し新規投資判断を保留する',
  ]]);
  SpreadsheetApp.flush();
  Logger.log('✅ CURRENT_CASHフィールドを「資金ルール」シートB' + newRow + 'セルに追加しました。現在の現金残高を手入力してください。');
}

function testGetCashRules() {
  const rules = getCashRules();
  Logger.log(JSON.stringify(rules, null, 2));
}

// ══════════════════════════════════════════════════════════
// Phase2: 実資産用「目標ポートフォリオ」設計・設定
// ══════════════════════════════════════════════════════════
// 2026-08-14 承認済み仕様に基づく実装。
//
// category は投資管理ダッシュボードの getFundData() が返す fund.name と
// 1:1で一致させている（この9カテゴリは現状すべて単一銘柄のため category==銘柄名）。
// Phase4でcurrentAllocationとjoinする際は fund.name と category を突き合わせる。
//
// FANG+・NASDAQ100・半導体・Zテック20は構成銘柄（NVIDIA/Apple/Alphabet/Microsoft/
// Amazon/Meta/Broadcom等）が重複しており、商品単位では分散して見えても実質的な
// 大型グロース/テクノロジー集中が存在しうる。ただし全構成銘柄・比率の正確なデータが
// ないため look-through 計算はここでは行わない（noteに記録し、Phase4以降の拡張項目とする）。

const TARGET_ALLOCATION_SHEET_NAME = '目標配分';

function setupTargetAllocationSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(TARGET_ALLOCATION_SHEET_NAME);
  if (sheet) {
    throw new Error('「' + TARGET_ALLOCATION_SHEET_NAME + '」シートは既に存在します。誤って再実行していないか確認してください。');
  }
  sheet = ss.insertSheet(TARGET_ALLOCATION_SHEET_NAME);

  const overlapNote = '構成銘柄がFANG+/NASDAQ100/半導体/Zテック20間で重複（NVIDIA/Apple/Alphabet/Microsoft/Amazon/Meta/Broadcom等）。商品単位では分散だが実質的な大型グロース集中の可能性あり。look-through未計算・Phase4以降の拡張項目。';
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  const rows = [
    ['category', 'target_weight', 'enabled', 'note', 'updated_at'],
    ['オルカン',     28, true, '全世界株式',                                                            today],
    ['S&P500',      26, true, '米国株式',                                                              today],
    ['FANG+',       17, true, '米国大型グロース。' + overlapNote,                                       today],
    ['NASDAQ100',    8, true, 'NASDAQ。' + overlapNote,                                                today],
    ['半導体',        8, true, overlapNote,                                                             today],
    ['ゴールド',      7, true, 'ceo_profileのhedge_gold_pct目標値(7%)に合わせて設定',                     today],
    ['Zテック20',     4, true, '独立ライン管理（FANG+等への統合は見送り）。' + overlapNote,                today],
    ['国内株式',      1, true, '日本株',                                                                today],
    ['宇宙株',        1, true, 'その他（宇宙テーマ）',                                                    today],
  ];

  sheet.getRange(1, 1, rows.length, 5).setValues(rows);
  sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  sheet.setColumnWidth(1, 110);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(3, 70);
  sheet.setColumnWidth(4, 500);
  sheet.setColumnWidth(5, 100);

  // enabled列（C2:C10）をチェックボックスにする
  const checkboxRule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange(2, 3, rows.length - 1, 1).setDataValidation(checkboxRule);

  SpreadsheetApp.flush();
  Logger.log('✅ 「' + TARGET_ALLOCATION_SHEET_NAME + '」シートを作成しました（' + (rows.length - 1) + 'カテゴリ登録）');
}

// 目標配分を読み取るヘルパー（Phase4判定エンジンから利用予定）
// enabled=falseの行も含めて全件返す。有効行だけ使うかどうかは呼び出し側の判断に委ねる。
function getTargetAllocation() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(TARGET_ALLOCATION_SHEET_NAME);
  if (!sheet) throw new Error('「' + TARGET_ALLOCATION_SHEET_NAME + '」シートが見つかりません。先に setupTargetAllocationSheet() を実行してください。');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();

  return data
    .filter(row => row[0])
    .map(([category, targetWeight, enabled, note, updatedAt]) => ({
      category: String(category).trim(),
      targetWeight: Number(targetWeight),
      enabled: Boolean(enabled),
      note: String(note || ''),
      updatedAt: updatedAt ? Utilities.formatDate(new Date(updatedAt), 'Asia/Tokyo', 'yyyy-MM-dd') : '',
    }));
}

// 目標配分のバリデーション。
// - enabledな行のtarget_weight合計が100かどうか（浮動小数の誤差は0.01まで許容）
// - target_weightが0未満の行がないか
// - カテゴリ名の重複がないか
// - disabledな行を含めた場合の合計（enabled=falseの項目を含めると異常な合計にならないか）も別途報告する
function validateTargetAllocation() {
  const rows = getTargetAllocation();
  const errors = [];
  const warnings = [];

  rows.forEach(r => {
    if (r.targetWeight < 0) errors.push('target_weightが0未満: ' + r.category + ' (' + r.targetWeight + ')');
  });

  const categoryCount = {};
  rows.forEach(r => { categoryCount[r.category] = (categoryCount[r.category] || 0) + 1; });
  Object.keys(categoryCount).forEach(cat => {
    if (categoryCount[cat] > 1) errors.push('カテゴリ名が重複: ' + cat + ' (' + categoryCount[cat] + '件)');
  });

  const enabledRows  = rows.filter(r => r.enabled);
  const disabledRows = rows.filter(r => !r.enabled);
  const totalEnabled = enabledRows.reduce((sum, r) => sum + r.targetWeight, 0);
  const totalAll      = rows.reduce((sum, r) => sum + r.targetWeight, 0);

  if (Math.abs(totalEnabled - 100) > 0.01) {
    errors.push('enabled=trueの行のtarget_weight合計が100%ではありません: ' + totalEnabled + '%');
  }
  if (disabledRows.length > 0) {
    warnings.push('enabled=falseの行が' + disabledRows.length + '件あります（' + disabledRows.map(r => r.category).join(', ') + '）。全行合計は' + totalAll + '%、有効行のみの合計は' + totalEnabled + '%です。');
  }

  return {
    valid: errors.length === 0,
    totalEnabled: totalEnabled,
    totalAll: totalAll,
    rowCount: rows.length,
    enabledCount: enabledRows.length,
    disabledCount: disabledRows.length,
    errors: errors,
    warnings: warnings,
  };
}

function testGetTargetAllocation() {
  const rows = getTargetAllocation();
  Logger.log('■ getTargetAllocation() 結果:');
  Logger.log(JSON.stringify(rows, null, 2));

  const validation = validateTargetAllocation();
  Logger.log('■ validateTargetAllocation() 結果:');
  Logger.log(JSON.stringify(validation, null, 2));
}

// ══════════════════════════════════════════════════════════
// Phase3: 市場環境スコアリング共通化
// ══════════════════════════════════════════════════════════
// 2026-08-14 調査に基づく実装。
//
// 既存ロジック調査で判明した事実（詳細はPhase3完了報告を参照）:
// - ai-corp/lib/data.js の calcMarketScore()/getMarketRegime() が唯一の
//   「複合0-100スコア」実装。NASDAQ40+SOX25+VIX20+F&G15、閾値80/60/40/20。
//   このスコアリング方式・フェーズ名(EUPHORIA/BULL/NEUTRAL/FEAR/PANIC)を
//   「既存仕様」としてそのまま採用する（S&P500/USD/JPYの重みは既存に定義が
//   ないため複合スコアには含めず、indicatorsに参考情報として含めるに留める）。
// - AI-Capital-v2/lib/dataFetcher.js の fgToPhase()/vixToPhase() は複合スコアでは
//   なく個別指標→フェーズ文字列の変換のみ。同ファイルの市場データ取得
//   （^NDX/^GSPC/^VIX/SOX/GC=F/USDJPY=X、CNN Fear&Greed）は投資管理ダッシュボード
//   とは独立した別実装で、値も別スプレッドシート(market_data等)に保存される。
// - AI-Capital-v2/lib/signalAggregator.js の「HARD RULE」はシステム異常・データ
//   取得失敗・重大リスクイベント（VIX/NASDAQ急落）を検知して安全側WAITにする
//   ゲートで、0-100の複合市場スコアとは別の仕組み（本Phase3では扱わない）。
// - 上記いずれもAI Capital本番コードは今回変更していない（調査のみ）。
//
// データソース:
// - NASDAQ(^IXIC)/SOX/VIX/S&P500/USD-JPYは投資管理ダッシュボードの
//   `market`シート（Yahoo Finance Spark v7/Chart v8、10分ごと自動更新）を
//   ?sheet=market の読み取り専用GETで取得。書き込みは一切行わない。
//   ※ダッシュボード側のNASDAQは^IXIC（Composite）であり、AI-Capital-v2が使う
//   ^NDX（NASDAQ100）とは別指数（強く相関するが同一ではない）。
// - Fear&GreedはCNNの公開JSONを直接取得（ai-corp/AI-Capital-v2と同一エンドポイント・
//   同一ヘッダーの3つ目の独立実装。将来的な共通化候補として報告するに留め、
//   今回は独立実装のまま）。

const DASHBOARD_API_URL = 'https://script.google.com/macros/s/AKfycbx3nyrGGz0x58AG-c6Rw9sAS7PKcXXtj3ncZg5N2nxyzEsD4c7k8_Ih1KBNUbgIJkZnFQ/exec';

// 投資管理ダッシュボードの market シートを読み取り専用GETで取得（書き込みなし）
function fetchMarketIndicatorsFromDashboard() {
  try {
    const res = UrlFetchApp.fetch(DASHBOARD_API_URL + '?sheet=market', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    const rows = JSON.parse(res.getContentText());
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('空配列');
    return rows;
  } catch (e) {
    Logger.log('市場データ取得失敗（投資管理ダッシュボード market）: ' + e.message);
    return null;
  }
}

// CNN Fear & Greed Index を直接取得（ai-corp/lib/data.jsのfetchFearGreed()と同一エンドポイント・同一ヘッダー）
function fetchFearGreedIndex() {
  try {
    const res = UrlFetchApp.fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      muteHttpExceptions: true,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://edition.cnn.com/markets/fear-and-greed',
        'Origin':          'https://edition.cnn.com',
      },
    });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    const json = JSON.parse(res.getContentText());
    const fg = json && json.fear_and_greed;
    if (!fg || fg.score == null) throw new Error('scoreが見つかりません');
    return Math.round(Number(fg.score));
  } catch (e) {
    Logger.log('Fear&Greed取得失敗: ' + e.message);
    return null;
  }
}

// 指標名から市場データ行を検索するヘルパー
function findMarketRow_(marketRows, keyword) {
  if (!marketRows) return null;
  return marketRows.find(r => String(r.name || '').includes(keyword)) || null;
}

// 異常値チェック。範囲外なら null を返す（黙って補正せず、呼び出し側でmissing扱いにする）
function sanitizePct_(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return null;
  if (Math.abs(pct) > 25) return null; // 主要指数の単日±25%超は異常値とみなす
  return Number(pct);
}
function sanitizeVix_(vix) {
  if (vix === null || vix === undefined || isNaN(vix)) return null;
  if (vix <= 0 || vix > 150) return null; // VIXの現実的な範囲外
  return Number(vix);
}
function sanitizeFg_(fg) {
  if (fg === null || fg === undefined || isNaN(fg)) return null;
  if (fg < 0 || fg > 100) return null; // Fear&Greedは0-100の指標
  return Number(fg);
}

// 既存 ai-corp/lib/data.js の calcMarketScore() と同一のスコアリング方式（NASDAQ40+SOX25+VIX20+F&G15）。
// データなし（null）の指標は「中立」扱いの固定値を使う（既存ロジックと同じ挙動）。
function computeMarketScoreCore_(nasdaqPct, soxPct, vixVal, fgValue) {
  let nasdaq = 20; // データなし=中立
  if (nasdaqPct !== null) {
    if      (nasdaqPct >= 2)  nasdaq = 40;
    else if (nasdaqPct >= 0)  nasdaq = 30;
    else if (nasdaqPct >= -2) nasdaq = 18;
    else if (nasdaqPct >= -5) nasdaq = 8;
    else                       nasdaq = 0;
  }

  let sox = 12; // データなし=中立
  if (soxPct !== null) {
    if      (soxPct >= 1)  sox = 25;
    else if (soxPct >= 0)  sox = 18;
    else if (soxPct >= -3) sox = 10;
    else if (soxPct >= -7) sox = 4;
    else                    sox = 0;
  }

  let vix = 10; // データなし=中立
  if (vixVal !== null) {
    if      (vixVal < 15) vix = 20;
    else if (vixVal < 20) vix = 14;
    else if (vixVal < 30) vix = 7;
    else if (vixVal < 40) vix = 2;
    else                   vix = 0;
  }

  let fg = 7; // データなし=中立
  if (fgValue !== null) {
    if      (fgValue >= 76) fg = 10; // Extreme Greed: 過熱警戒
    else if (fgValue >= 56) fg = 14; // Greed
    else if (fgValue >= 45) fg = 8;  // Neutral
    else if (fgValue >= 25) fg = 3;  // Fear
    else                     fg = 1; // Extreme Fear
  }

  return { total: nasdaq + sox + vix + fg, components: { nasdaq, sox, vix, fg } };
}

// 既存 ai-corp/lib/data.js の getMarketRegime() と同一の閾値・フェーズ名
function getMarketPhase(score) {
  if (score === null) return null;
  if (score >= 80) return 'EUPHORIA';
  if (score >= 60) return 'BULL';
  if (score >= 40) return 'NEUTRAL';
  if (score >= 20) return 'FEAR';
  return 'PANIC';
}

// Market Score算出（メイン関数）。
// testOverrides を渡すとfetchをスキップしてテスト用の値を注入できる
// （{ marketRows: [...]|null, fgValue: number|null }）。省略時は実データを取得する。
function calcMarketScore(testOverrides) {
  const opts = testOverrides || {};
  const calculatedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  const warnings = [];
  const missingIndicators = [];
  const indicators = [];

  const marketRows = Object.prototype.hasOwnProperty.call(opts, 'marketRows')
    ? opts.marketRows
    : fetchMarketIndicatorsFromDashboard();
  if (!marketRows) warnings.push('投資管理ダッシュボードの市場データを取得できませんでした');

  const rawFg = Object.prototype.hasOwnProperty.call(opts, 'fgValue')
    ? opts.fgValue
    : fetchFearGreedIndex();
  if (rawFg === null) warnings.push('Fear&Greed Indexを取得できませんでした');

  // ── コア4指標（複合スコアに使用） ──
  const nasdaqRow = findMarketRow_(marketRows, 'NASDAQ');
  let nasdaqPct = nasdaqRow ? sanitizePct_(Number(nasdaqRow.pct)) : null;
  if (nasdaqRow && nasdaqPct === null) warnings.push('NASDAQ pctが異常値のため除外: ' + nasdaqRow.pct);
  if (nasdaqPct === null) missingIndicators.push('NASDAQ');
  indicators.push({ name: 'NASDAQ', value: nasdaqRow ? Number(nasdaqRow.pct) : null, score: nasdaqPct !== null ? computeMarketScoreCore_(nasdaqPct, null, null, null).components.nasdaq : null, weighted: true, source: '投資管理ダッシュボード(market, Yahoo Finance ^IXIC)', timestamp: nasdaqRow ? nasdaqRow.updated : null });

  const soxRow = findMarketRow_(marketRows, 'SOX');
  let soxPct = soxRow ? sanitizePct_(Number(soxRow.pct)) : null;
  if (soxRow && soxPct === null) warnings.push('SOX pctが異常値のため除外: ' + soxRow.pct);
  if (soxPct === null) missingIndicators.push('SOX');
  indicators.push({ name: 'SOX', value: soxRow ? Number(soxRow.pct) : null, score: soxPct !== null ? computeMarketScoreCore_(null, soxPct, null, null).components.sox : null, weighted: true, source: '投資管理ダッシュボード(market, Yahoo Finance ^SOX)', timestamp: soxRow ? soxRow.updated : null });

  const vixRow = findMarketRow_(marketRows, 'VIX');
  let vixVal = vixRow ? sanitizeVix_(Number(vixRow.price)) : null;
  if (vixRow && vixVal === null) warnings.push('VIXが異常値のため除外: ' + vixRow.price);
  if (vixVal === null) missingIndicators.push('VIX');
  indicators.push({ name: 'VIX', value: vixRow ? Number(vixRow.price) : null, score: vixVal !== null ? computeMarketScoreCore_(null, null, vixVal, null).components.vix : null, weighted: true, source: '投資管理ダッシュボード(market, Yahoo Finance ^VIX)', timestamp: vixRow ? vixRow.updated : null });

  let fgValue = sanitizeFg_(rawFg);
  if (rawFg !== null && fgValue === null) warnings.push('Fear&Greedが異常値のため除外: ' + rawFg);
  if (fgValue === null) missingIndicators.push('FearGreed');
  indicators.push({ name: 'FearGreed', value: rawFg, score: fgValue !== null ? computeMarketScoreCore_(null, null, null, fgValue).components.fg : null, weighted: true, source: 'CNN Fear & Greed Index', timestamp: calculatedAt });

  // ── 参考指標（複合スコアには未算入。既存calcMarketScore()に重み定義がないため） ──
  const spxRow = findMarketRow_(marketRows, 'S&P500');
  indicators.push({ name: 'S&P500', value: spxRow ? Number(spxRow.pct) : null, score: null, weighted: false, source: '投資管理ダッシュボード(market, Yahoo Finance ^GSPC)', timestamp: spxRow ? spxRow.updated : null });
  if (!spxRow) missingIndicators.push('S&P500');

  const usdjpyRow = findMarketRow_(marketRows, 'ドル円');
  indicators.push({ name: 'USDJPY', value: usdjpyRow ? Number(usdjpyRow.price) : null, score: null, weighted: false, source: '投資管理ダッシュボード(market, Yahoo Finance USDJPY=X)', timestamp: usdjpyRow ? usdjpyRow.updated : null });
  if (!usdjpyRow) missingIndicators.push('USDJPY');

  // ── 複合スコア算出 ──
  const coreValues = [nasdaqPct, soxPct, vixVal, fgValue];
  const coreAvailableCount = coreValues.filter(v => v !== null).length;

  let marketScore = null, marketPhase = null, dataQuality;
  if (coreAvailableCount === 0) {
    dataQuality = 'UNAVAILABLE';
    warnings.push('コア4指標（NASDAQ/SOX/VIX/FearGreed）が全て取得できなかったため、Market Scoreは算出しません');
  } else {
    const core = computeMarketScoreCore_(nasdaqPct, soxPct, vixVal, fgValue);
    marketScore = core.total;
    marketPhase = getMarketPhase(marketScore);
    // コア4指標のうちweighted=trueでmissingになったものだけをDEGRADED判定に使う
    const coreMissing = missingIndicators.filter(n => ['NASDAQ', 'SOX', 'VIX', 'FearGreed'].includes(n));
    dataQuality = coreMissing.length === 0 ? 'OK' : 'DEGRADED';
  }

  return { marketScore, marketPhase, indicators, dataQuality, missingIndicators, warnings, calculatedAt };
}

// ── テスト関数群 ──

// ①正常系: 実データで取得〜Market Score〜Market Phaseまで通しで確認
function testCalcMarketScore_Normal() {
  const result = calcMarketScore();
  Logger.log('■ ①正常系（実データ）:');
  Logger.log(JSON.stringify(result, null, 2));
}

// ②一部欠損: SOXだけ市場データから欠落した状態を注入 → DEGRADED・missingIndicatorsにSOXが入るか確認
function testCalcMarketScore_PartialMissing() {
  const realRows = fetchMarketIndicatorsFromDashboard() || [];
  const rowsWithoutSox = realRows.filter(r => !String(r.name || '').includes('SOX'));
  const result = calcMarketScore({ marketRows: rowsWithoutSox, fgValue: 55 });
  Logger.log('■ ②一部欠損（SOX欠落を注入）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: dataQuality=' + result.dataQuality + ' (期待値: DEGRADED), missingIndicators=' + JSON.stringify(result.missingIndicators) + ' (SOXを含むはず), marketScore=' + result.marketScore + ' (nullでないはず)');
}

// ③全体的なデータ取得失敗: marketRows・fgValueともnullを注入 → marketScore=null・UNAVAILABLEを確認
function testCalcMarketScore_TotalFailure() {
  const result = calcMarketScore({ marketRows: null, fgValue: null });
  Logger.log('■ ③全体的なデータ取得失敗（全指標null注入）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: marketScore=' + result.marketScore + ' (nullのはず), dataQuality=' + result.dataQuality + ' (UNAVAILABLEのはず)');
}

// ④境界値: 0/20/40/60/80/100付近のMarket Phase判定を確認
function testCalcMarketScore_BoundaryPhases() {
  [0, 19, 20, 39, 40, 59, 60, 79, 80, 100].forEach(score => {
    Logger.log('score=' + score + ' → phase=' + getMarketPhase(score));
  });
}

// ⑤異常値: VIXに明らかな異常値（9999）を注入 → 正常値として扱わず除外・missingIndicatorsに入るか確認
function testCalcMarketScore_AnomalousValue() {
  const realRows = fetchMarketIndicatorsFromDashboard() || [];
  const tamperedRows = realRows.map(r => String(r.name || '').includes('VIX') ? Object.assign({}, r, { price: 9999 }) : r);
  const result = calcMarketScore({ marketRows: tamperedRows, fgValue: 55 });
  Logger.log('■ ⑤異常値（VIX=9999を注入）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: VIX indicatorのscoreがnull、missingIndicatorsにVIXが含まれ、警告メッセージがあるはず');
}

// ══════════════════════════════════════════════════════════
// Phase4A: NISA購入優先度判定（「何を買うか」の優先順位のみ）
// ══════════════════════════════════════════════════════════
// 2026-08-14 承認済み仕様に基づく実装。
//
// 「いくら買うか」「一括/積立/ハイブリッド」はPhase4B（別Phase・未着手）。
// このPhase4Aは以下を厳守する:
// - Market Score/nisaAbsent/gap_nisaのいずれか単独では優先度を決定しない
// - gap_nisa（targetWeight - nisaWeight）はNISA内比率という別母集団との差分であり、
//   購入優先度の数値には使わない。reasonsの参考情報としてのみ出力する
// - FANG+/NASDAQ100/半導体/Zテック20の構成銘柄重複（look-through）は正確なデータが
//   ないため推測で数値化せず、targetAllocationのnoteに重複記載がある場合のみ
//   reasonsに定性的な注意書きを追加する（スコアには反映しない）
// - Market Scoreは全カテゴリに同一の値であり、そのまま優先度スコアに加算しても
//   相対順位は一切変化しない（定数を全員に足すのと同じ）ため、優先度スコアには
//   含めず、reasons末尾に「参考情報・順位に影響しない」旨を明記して付記するに留める
//
// 採用した優先度スコア（候補値、要調整）:
//   overallGapScore   = max(0, targetWeight - currentWeight)
//   nisaPresenceScore = nisaAbsent ? targetWeight * NISA_ABSENT_TARGET_WEIGHT_FACTOR : 0
//   priorityScore     = overallGapScore + nisaPresenceScore
// 「NISA未保有かどうか」のボーナスをそのカテゴリのtargetWeightに比例させているのは、
// 目標配分上の重要度が低いカテゴリ（例: 宇宙株1%）がNISA未保有というだけで
// 目標配分上重要なカテゴリ（例: FANG+17%）より上位に来てしまうのを避けるため。
// NISA_ABSENT_TARGET_WEIGHT_FACTORは0.5を候補値として設定しているが、確定仕様ではない。

const NISA_ABSENT_TARGET_WEIGHT_FACTOR = 0.5; // 候補値・要調整

// 投資管理ダッシュボードのfunds（getFundData()相当）を読み取り専用GETで取得。書き込みなし。
function fetchDashboardFunds_() {
  try {
    const res = UrlFetchApp.fetch(DASHBOARD_API_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    const json = JSON.parse(res.getContentText());
    if (!json || !Array.isArray(json.funds)) throw new Error('funds配列が不正です');
    return json.funds; // [{name, account, value, principal, units, nav, athPct}]
  } catch (e) {
    Logger.log('実資産データ取得失敗（投資管理ダッシュボード funds）: ' + e.message);
    return null;
  }
}

function pct_(value, total) {
  if (!total || total <= 0) return 0;
  return Math.round((value / total) * 10000) / 100;
}

// 実資産全体（全口座合算）のカテゴリ別現在比率。
// 投資管理ダッシュボードのsummary.totalValueは使わず、銘柄別fundデータの合算を正とする
// （Phase2で確認済みの通りsummary.totalValueは一部銘柄を含まない可能性があるため。
// ダッシュボード側の不具合修正は本Phaseの対象外）。
function getCurrentAllocation() {
  const calculatedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  const funds = fetchDashboardFunds_();
  if (!funds) {
    return { calculatedAt, totalValue: null, byCategory: [], dataQuality: 'UNAVAILABLE', warnings: ['投資管理ダッシュボードの実資産データを取得できませんでした'] };
  }

  const byCat = {};
  let totalValue = 0;
  funds.forEach(f => {
    const cat = String(f.name || '').trim();
    if (!cat) return;
    if (!byCat[cat]) byCat[cat] = { category: cat, value: 0, principal: 0 };
    byCat[cat].value     += Number(f.value)     || 0;
    byCat[cat].principal += Number(f.principal) || 0;
    totalValue += Number(f.value) || 0;
  });

  const byCategory = Object.values(byCat).map(c => {
    const gain = c.value - c.principal;
    return {
      category: c.category,
      value: c.value,
      weight: pct_(c.value, totalValue),
      principal: c.principal,
      gain: gain,
      gainPct: c.principal > 0 ? Math.round((gain / c.principal) * 10000) / 100 : 0,
    };
  });

  return { calculatedAt, totalValue, byCategory, dataQuality: 'OK', warnings: [] };
}

// NISA枠内（成長枠+積立枠、account !== '特定'）のみのカテゴリ別構成。
// targetAllocationの全カテゴリを基準に含める（NISA未保有=0円のカテゴリも明示するため）。
function getNisaAllocation() {
  const calculatedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  const funds = fetchDashboardFunds_();
  if (!funds) {
    return { calculatedAt, totalNisaValue: null, byCategory: [], dataQuality: 'UNAVAILABLE', warnings: ['投資管理ダッシュボードの実資産データを取得できませんでした'] };
  }

  const nisaFunds = funds.filter(f => String(f.account || '').trim() !== '特定');
  const byCat = {};
  let totalNisaValue = 0;
  nisaFunds.forEach(f => {
    const cat = String(f.name || '').trim();
    if (!cat) return;
    byCat[cat] = (byCat[cat] || 0) + (Number(f.value) || 0);
    totalNisaValue += Number(f.value) || 0;
  });

  let targetCategories = [];
  try { targetCategories = getTargetAllocation().map(t => t.category); } catch (e) { /* 目標配分未設定でも動作継続 */ }
  const allCategories = Array.from(new Set(targetCategories.concat(Object.keys(byCat))));

  const byCategory = allCategories.map(cat => {
    const nisaValue = byCat[cat] || 0;
    return {
      category: cat,
      nisaValue: nisaValue,
      nisaWeight: pct_(nisaValue, totalNisaValue),
      nisaAbsent: nisaValue === 0,
    };
  });

  return { calculatedAt, totalNisaValue, byCategory, dataQuality: 'OK', warnings: [] };
}

// Phase4A統合判断本体。「何を優先すべきか」の判断材料を返す（購入額・購入命令は返さない）。
// testOverrides で各入力データを差し替えられる（{ cashRules, currentAllocation, nisaAllocation,
// marketResult, targetAllocation }）。省略時は実データを取得する。
function NisaStrategyEngine(testOverrides) {
  const opts = testOverrides || {};
  const calculatedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');

  const cashRules         = opts.cashRules         || getCashRules();
  const currentAllocation = opts.currentAllocation || getCurrentAllocation();
  const nisaAllocation    = opts.nisaAllocation    || getNisaAllocation();
  const marketResult      = opts.marketResult      || calcMarketScore();
  const targetAllocation  = (opts.targetAllocation || getTargetAllocation()).filter(t => t.enabled);

  // Phase5-D: 既存の判断ロジックは変更しない。cashRules/currentAllocation/marketResultは
  // ここに至るまでに既に取得済みのため、それらの値をそのまま素通しするだけ（再計算はしない）。
  const blocked = (reason, extra) => Object.assign({
    status: 'BLOCKED',
    reason: reason,
    investableCash: 0,
    currentCash: cashRules.currentCash,
    protectedCashMin: cashRules.protectedCashMin,
    totalValue: currentAllocation.totalValue,
    marketScore: marketResult.marketScore,
    marketPhase: marketResult.marketPhase,
    marketDataQuality: marketResult.dataQuality,
    missingIndicators: marketResult.missingIndicators,
    indicators: marketResult.indicators,
    categories: [],
    dataQuality: 'UNAVAILABLE',
    warnings: [],
    calculatedAt: calculatedAt,
  }, extra || {});

  // ── HARD RULE ゲート（Market Scoreでは一切上書きできない） ──
  if (currentAllocation.dataQuality === 'UNAVAILABLE') {
    return blocked('実資産データ（投資管理ダッシュボード）が取得できないため判断を保留します', { warnings: currentAllocation.warnings });
  }
  if (nisaAllocation.dataQuality === 'UNAVAILABLE') {
    return blocked('NISA内データが取得できないため判断を保留します', { warnings: nisaAllocation.warnings });
  }

  const currentCash = cashRules.currentCash;
  if (currentCash === null || currentCash === undefined || isNaN(currentCash) || currentCash < 0) {
    return blocked('現在の現金残高（currentCash）が未設定または不正値のため、安全側に投資判断を保留します（「資金ルール」シートのCURRENT_CASHに現在の現金残高を入力してください）', { dataQuality: currentAllocation.dataQuality });
  }

  const investableCash = Math.max(0, currentCash - cashRules.protectedCashMin);
  if (investableCash <= 0) {
    return blocked('投資可能資金がありません（現金' + currentCash + '円が保護すべき最低額' + cashRules.protectedCashMin + '円以下）', { investableCash: 0, dataQuality: currentAllocation.dataQuality });
  }

  // ── ここから通常評価（HARD RULEは通過済み） ──
  const warnings = [];
  if (marketResult.dataQuality === 'UNAVAILABLE') {
    warnings.push('市場データが取得できなかったため、Market Scoreなしで優先順位を算出しています（投資可否自体はブロックしません）');
  }

  const currentByCat = {}; currentAllocation.byCategory.forEach(c => { currentByCat[c.category] = c; });
  const nisaByCat    = {}; nisaAllocation.byCategory.forEach(c => { nisaByCat[c.category] = c; });

  const categories = targetAllocation.map(t => {
    const cur  = currentByCat[t.category] || { weight: 0, value: 0 };
    const nisa = nisaByCat[t.category]    || { nisaWeight: 0, nisaValue: 0, nisaAbsent: true };

    const gapOverall = Math.round((t.targetWeight - cur.weight) * 100) / 100;
    const gapNisa     = Math.round((t.targetWeight - nisa.nisaWeight) * 100) / 100; // 参考情報のみ、スコアには使わない

    const overallGapScore   = Math.max(0, gapOverall);
    const nisaPresenceScore = nisa.nisaAbsent ? Math.round(t.targetWeight * NISA_ABSENT_TARGET_WEIGHT_FACTOR * 100) / 100 : 0;
    const priorityScore     = Math.round((overallGapScore + nisaPresenceScore) * 100) / 100;

    const reasons = [];
    if (gapOverall > 0) {
      reasons.push('実資産全体で目標比率を' + gapOverall + 'pt下回っている（現在' + cur.weight + '% / 目標' + t.targetWeight + '%）');
    } else if (gapOverall < 0) {
      reasons.push('実資産全体で目標比率を' + Math.abs(gapOverall) + 'pt上回っている（現在' + cur.weight + '% / 目標' + t.targetWeight + '%）。新規投資の優先度は下がる');
    } else {
      reasons.push('実資産全体で目標比率とほぼ一致している');
    }

    if (nisa.nisaAbsent) {
      reasons.push('NISA内では未保有（特定口座のみ）。目標比率' + t.targetWeight + '%相当が課税口座に固定されている');
    } else {
      reasons.push('NISA内で既に保有中（NISA内構成比' + nisa.nisaWeight + '%、実資産全体目標との差分（参考情報）: ' + gapNisa + 'pt）');
    }

    if (t.note && (t.note.indexOf('重複') !== -1 || t.note.indexOf('集中') !== -1)) {
      reasons.push('構成銘柄の重複による実質的な集中リスクの可能性あり（look-through未計算のため優先度スコアには反映していません。詳細は目標配分シートのnote参照）');
    }

    const catWarnings = [];
    if (!currentByCat[t.category]) catWarnings.push('現在保有なし（0円として計算）');

    return {
      category: t.category,
      currentWeight: cur.weight,
      targetWeight: t.targetWeight,
      gapOverall: gapOverall,
      nisaWeight: nisa.nisaWeight,
      gapNisa: gapNisa,
      nisaAbsent: nisa.nisaAbsent,
      priorityScore: priorityScore,
      // Phase5-D: overallGapScore/nisaPresenceScoreは元々priorityScoreの計算にのみ使う
      // ローカル変数だったが、計算式は変更せず、既に算出済みの値を返却オブジェクトに
      // 追加しただけ（判断履歴での再現性向上のため）。
      overallGapScore: overallGapScore,
      nisaPresenceScore: nisaPresenceScore,
      priorityRank: null,
      reasons: reasons,
      warnings: catWarnings,
    };
  });

  categories.sort((a, b) => b.priorityScore - a.priorityScore);
  categories.forEach((c, i) => { c.priorityRank = i + 1; });

  if (marketResult.marketScore !== null) {
    categories.forEach(c => {
      c.reasons.push('市場環境: ' + marketResult.marketPhase + '（Market Score ' + marketResult.marketScore + '点）— 全カテゴリ共通の参考情報であり、この優先順位には影響していません');
    });
  }

  return {
    status: 'OK',
    investableCash: investableCash,
    // Phase5-D: 以下4項目は既に取得済みの値をそのまま追加しただけ（再計算・新規ロジックなし）
    currentCash: cashRules.currentCash,
    protectedCashMin: cashRules.protectedCashMin,
    totalValue: currentAllocation.totalValue,
    marketScore: marketResult.marketScore,
    marketPhase: marketResult.marketPhase,
    marketDataQuality: marketResult.dataQuality,
    missingIndicators: marketResult.missingIndicators,
    indicators: marketResult.indicators,
    categories: categories,
    dataQuality: currentAllocation.dataQuality,
    warnings: warnings.concat(currentAllocation.warnings, nisaAllocation.warnings, marketResult.warnings),
    calculatedAt: calculatedAt,
  };
}

// ── テスト関数群（Phase4A） ──

// ①正常系: 実データで通しの動作確認
function testNisaStrategyEngine_Normal() {
  const result = NisaStrategyEngine();
  Logger.log('■ ①正常系（実データ）:');
  Logger.log(JSON.stringify(result, null, 2));
}

// ②現金不足: currentCashをprotectedCashMin未満に注入 → BLOCKEDを確認
function testNisaStrategyEngine_CashBelowProtected() {
  const realCashRules = getCashRules();
  const cashRules = Object.assign({}, realCashRules, { currentCash: realCashRules.protectedCashMin - 100000 });
  const result = NisaStrategyEngine({ cashRules: cashRules });
  Logger.log('■ ②現金不足（currentCash=protectedCashMin-10万円を注入）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: status=' + result.status + ' (期待値: BLOCKED)');
}

// ③currentCash未設定: nullを注入 → 安全側に倒しBLOCKEDを確認
function testNisaStrategyEngine_CurrentCashUnset() {
  const realCashRules = getCashRules();
  const cashRules = Object.assign({}, realCashRules, { currentCash: null });
  const result = NisaStrategyEngine({ cashRules: cashRules });
  Logger.log('■ ③currentCash未設定（nullを注入）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: status=' + result.status + ' (期待値: BLOCKED)');
}

// ④ダッシュボード取得失敗: currentAllocation.dataQuality=UNAVAILABLEを注入 → BLOCKEDを確認
function testNisaStrategyEngine_DashboardUnavailable() {
  const currentAllocation = { calculatedAt: '', totalValue: null, byCategory: [], dataQuality: 'UNAVAILABLE', warnings: ['test: ダッシュボード取得失敗を模擬'] };
  const result = NisaStrategyEngine({ currentAllocation: currentAllocation });
  Logger.log('■ ④ダッシュボード取得失敗（currentAllocation.dataQuality=UNAVAILABLEを注入）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: status=' + result.status + ' (期待値: BLOCKED)');
}

// ⑤NISA未保有だけでは最優先にならないことの確認:
// カテゴリX(target25%,現在10%=乖離15pt,NISA保有中) vs カテゴリY(target1%,現在0.9%=乖離0.1pt,NISA未保有)
// を比較し、乖離の大きいXが優先されることを確認する（NISA未保有Yが自動的に上位に来ないことの証明）
function testNisaStrategyEngine_NisaAbsentNotAutoTop() {
  const targetAllocation = [
    { category: 'X', targetWeight: 25, enabled: true, note: '' },
    { category: 'Y', targetWeight: 1,  enabled: true, note: '' },
  ];
  const currentAllocation = {
    calculatedAt: '', totalValue: 1000000,
    byCategory: [
      { category: 'X', value: 100000, weight: 10,  principal: 100000, gain: 0, gainPct: 0 },
      { category: 'Y', value: 9000,   weight: 0.9, principal: 9000,   gain: 0, gainPct: 0 },
    ],
    dataQuality: 'OK', warnings: [],
  };
  const nisaAllocation = {
    calculatedAt: '', totalNisaValue: 50000,
    byCategory: [
      { category: 'X', nisaValue: 50000, nisaWeight: 100, nisaAbsent: false }, // NISA内で保有中
      { category: 'Y', nisaValue: 0,     nisaWeight: 0,   nisaAbsent: true  }, // NISA未保有
    ],
    dataQuality: 'OK', warnings: [],
  };
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin + 1000000 });
  const result = NisaStrategyEngine({ targetAllocation, currentAllocation, nisaAllocation, cashRules });
  Logger.log('■ ⑤NISA未保有だけでは最優先にならないことの確認:');
  Logger.log(JSON.stringify(result.categories, null, 2));
  const xRank = result.categories.find(c => c.category === 'X').priorityRank;
  const yRank = result.categories.find(c => c.category === 'Y').priorityRank;
  Logger.log('検証: Xの乖離(15pt)がYのNISA未保有ボーナスより優先されXがrank1になるはず → X rank=' + xRank + ', Y rank=' + yRank);
}

// ⑥目標超過カテゴリの優先度が下がることの確認: gapOverall<0のカテゴリを構成
function testNisaStrategyEngine_OverweightLowerPriority() {
  const targetAllocation = [
    { category: 'Under', targetWeight: 10, enabled: true, note: '' },
    { category: 'Over',  targetWeight: 10, enabled: true, note: '' },
  ];
  const currentAllocation = {
    calculatedAt: '', totalValue: 1000000,
    byCategory: [
      { category: 'Under', value: 50000,  weight: 5,  principal: 50000,  gain: 0, gainPct: 0 }, // 目標10%に対し5%=不足
      { category: 'Over',  value: 150000, weight: 15, principal: 150000, gain: 0, gainPct: 0 }, // 目標10%に対し15%=超過
    ],
    dataQuality: 'OK', warnings: [],
  };
  const nisaAllocation = {
    calculatedAt: '', totalNisaValue: 0,
    byCategory: [
      { category: 'Under', nisaValue: 0, nisaWeight: 0, nisaAbsent: true },
      { category: 'Over',  nisaValue: 0, nisaWeight: 0, nisaAbsent: true },
    ],
    dataQuality: 'OK', warnings: [],
  };
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin + 1000000 });
  const result = NisaStrategyEngine({ targetAllocation, currentAllocation, nisaAllocation, cashRules });
  Logger.log('■ ⑥目標超過カテゴリの優先度が下がることの確認:');
  Logger.log(JSON.stringify(result.categories, null, 2));
  const underScore = result.categories.find(c => c.category === 'Under').priorityScore;
  const overScore  = result.categories.find(c => c.category === 'Over').priorityScore;
  Logger.log('検証: Under(不足)のpriorityScore=' + underScore + ' > Over(超過)のpriorityScore=' + overScore + ' のはず');
}

// ⑦確認用: 実データ（実際の9カテゴリ・実際のcurrentAllocation/nisaAllocation/marketScore）を使い、
// currentCashだけ一時的に高い値に差し替えてBLOCKEDを回避し、実際のカテゴリ別優先順位を確認する。
// 「資金ルール」シートの実際の値は書き換えない（テスト実行中のメモリ上のみの差し替え）。
function testNisaStrategyEngine_RealDataWithSufficientCash() {
  const realCashRules = getCashRules();
  const cashRules = Object.assign({}, realCashRules, { currentCash: realCashRules.protectedCashMin + 1000000 });
  const result = NisaStrategyEngine({ cashRules: cashRules });
  Logger.log('■ ⑦実データ（currentCashのみ一時的に+100万円で注入、シートは未変更）:');
  Logger.log(JSON.stringify(result, null, 2));
}

// ══════════════════════════════════════════════════════════
// Phase4B: 一括/積立/ハイブリッド判定・カテゴリ別投資額
// ══════════════════════════════════════════════════════════
// 2026-08-14 承認済み仕様に基づく実装。「いくら買うか」「一括/積立/ハイブリッド」を扱う。
// Phase4Aの既存コードは一切変更していない（NisaStrategyEngine()はそのまま利用するのみ）。
//
// 設計上の要点（承認済み仕様の反映）:
// - Market Score/Phaseはstrategy（LUMP_SUM/DCA/HYBRID）を直接決定しない。
//   strategyConfidence・strategyReasons・warningsの補助情報としてのみ使う。
// - ショックモードはNORMAL/CAUTIOUS/HOLDの3段階。status(BLOCKED)とは独立した別軸。
//   CAUTIOUS/HOLDのいずれもLUMP_SUMを禁止しない。
// - plannedContributionはCONFIRMED/UNKNOWNの2値で判定する（ZEROは将来の拡張用に型として
//   確保しているが、スプレッドシート上は「0」と「未入力」を区別できないため、現状の実装では
//   月別投資額の合計が0円ならUNKNOWN、正の値があればCONFIRMEDとして扱う。真に「入金予定ゼロ」
//   を明示する入力手段は今回未実装＝既知の制約）。
// - 【2026-08-14仕様変更】カテゴリ別neededAmountは「現在の総資産T」に対する不足額
//   （currentWeight<targetWeightの場合のみ）として計算する。currentWeight>=targetWeightの
//   カテゴリは新規投資を自動配分しない（目標達成済みカテゴリへ新規資金を回して比率を
//   維持する、という考え方は採用しない）。投資後カテゴリ比率(proposedWeight)は表示専用の
//   シミュレーションとして T+実際の配分合計 を分母に用いるが、配分額そのものの決定には使わない。
//   recommendedInvestmentAmountは「実際に配分した合計額」を指し、資金・NISA枠上の理論上限は
//   別途investmentCapacityとして分離した（「投資可能資金がある」≠「今回投資を推奨する」）。
// - NISA成長投資枠/つみたて投資枠は別々の残枠として管理し、カテゴリのNISA適格性
//   （過去のTransactions実績の有無）に応じて配分先を振り分ける。適格性未確認の
//   カテゴリには自動配分しない（「NISAで買えない」と断定はしない）。

const NISA_ANNUAL_GROWTH_LIMIT     = 2400000; // 制度上の固定値（個人設定ではない）
const NISA_ANNUAL_TSUMITATE_LIMIT  = 1200000;
const PLANNED_CONTRIBUTION_SHEET_NAME = '月別投資額';

// 「月別投資額」シートから対象年度の入金予定を取得。
// 0と空欄をスプレッドシート上で区別できないため、対象年度の合計が0円ならUNKNOWN
// （＝入金予定なしと断定しない）、正の値があればCONFIRMEDとして扱う。
function getPlannedContribution(targetYear) {
  const year = targetYear || (new Date().getFullYear() + 1);
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(PLANNED_CONTRIBUTION_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) {
      return { year: year, status: 'UNKNOWN', totalAmount: null, months: [], warnings: ['「' + PLANNED_CONTRIBUTION_SHEET_NAME + '」シートが見つからないか空です'] };
    }
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    const monthsInYear = data.filter(row => row[0] && new Date(row[0]).getFullYear() === year);
    if (monthsInYear.length === 0) {
      return { year: year, status: 'UNKNOWN', totalAmount: null, months: [], warnings: [year + '年の行が「' + PLANNED_CONTRIBUTION_SHEET_NAME + '」に見つかりません'] };
    }
    const months = monthsInYear.map(row => ({
      month: Utilities.formatDate(new Date(row[0]), 'Asia/Tokyo', 'yyyy-MM'),
      amount: Number(row[1]) || 0,
    }));
    const totalAmount = months.reduce((s, m) => s + m.amount, 0);
    const status = totalAmount > 0 ? 'CONFIRMED' : 'UNKNOWN';
    return { year: year, status: status, totalAmount: status === 'CONFIRMED' ? totalAmount : null, months: months, warnings: [] };
  } catch (e) {
    return { year: year, status: 'UNKNOWN', totalAmount: null, months: [], warnings: ['取得失敗: ' + e.message] };
  }
}

// 対象年度のNISA枠使用状況。未来の年度（まだ始まっていない）は制度上使用済み0円が自明なため
// フェッチ不要で確定できる。当年またはそれ以前は投資管理ダッシュボードの実測値が必要。
// 取得できない場合は安全側（残枠0）に倒し、残枠を過大評価しない。
function getNisaLimitUsage(targetYear) {
  const year = targetYear || (new Date().getFullYear() + 1);
  const currentCalendarYear = new Date().getFullYear();

  if (year > currentCalendarYear) {
    return {
      year: year, growthUsed: 0, tsumiUsed: 0,
      growthRemain: NISA_ANNUAL_GROWTH_LIMIT, tsumiRemain: NISA_ANNUAL_TSUMITATE_LIMIT,
      dataQuality: 'OK', warnings: [],
    };
  }

  try {
    const res = UrlFetchApp.fetch(DASHBOARD_API_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    const json = JSON.parse(res.getContentText());
    if (!json || !json.nisa || Number(json.nisa.year) !== year) throw new Error('対象年度のNISA使用実績が取得できません');
    const growthUsed = Number(json.nisa.growthUsed) || 0;
    const tsumiUsed  = Number(json.nisa.tsumiUsed)  || 0;
    return {
      year: year, growthUsed: growthUsed, tsumiUsed: tsumiUsed,
      growthRemain: Math.max(0, NISA_ANNUAL_GROWTH_LIMIT - growthUsed),
      tsumiRemain:  Math.max(0, NISA_ANNUAL_TSUMITATE_LIMIT - tsumiUsed),
      dataQuality: 'OK', warnings: [],
    };
  } catch (e) {
    return {
      year: year, growthUsed: null, tsumiUsed: null, growthRemain: 0, tsumiRemain: 0,
      dataQuality: 'UNAVAILABLE',
      warnings: ['NISA使用実績の取得に失敗したため、安全側に残枠0として扱います: ' + e.message],
    };
  }
}

// 投資管理ダッシュボードの取引履歴（trades）を読み取り専用GETで取得。書き込みなし。
function fetchDashboardTrades_() {
  try {
    const res = UrlFetchApp.fetch(DASHBOARD_API_URL + '?sheet=trades', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    const rows = JSON.parse(res.getContentText());
    if (!Array.isArray(rows)) throw new Error('trades配列が不正です');
    return rows; // [{date, account, name, type, amount, units}]
  } catch (e) {
    Logger.log('取引履歴取得失敗（投資管理ダッシュボード trades）: ' + e.message);
    return null;
  }
}

// カテゴリごとのNISA適格性を、過去の実際のTransactions実績（枠区分）から判定する。
// 実績が一度もない組み合わせは「未確認」として扱い、勝手にNISA対象と決めない。
function getCategoryNisaEligibility_() {
  const trades = fetchDashboardTrades_();
  const map = {};
  if (!trades) return { map: map, dataQuality: 'UNAVAILABLE' };
  trades.forEach(t => {
    const cat = String(t.name || '').trim();
    const acc = String(t.account || '').trim();
    if (!cat) return;
    if (!map[cat]) map[cat] = { growthEligible: false, tsumitateEligible: false };
    if (acc === '成長枠') map[cat].growthEligible = true;
    if (acc === '積立枠') map[cat].tsumitateEligible = true;
  });
  return { map: map, dataQuality: 'OK' };
}

// ショックモードのレベル判定（NORMAL/CAUTIOUS/HOLD）。HARD RULEのBLOCKEDとは独立した別軸。
// shockModeActive=falseなら常にNORMAL。trueの場合、市場データが読めない、または既にPANIC水準
// （ユーザー宣言のショック状態の上にさらに客観指標も極端）ならHOLD、それ以外はCAUTIOUS。
// ※この3段階・判定条件は既存仕様の踏襲ではなく今回新規に設計したもの。要確認。
function getShockLevel_(cashRules, marketResult) {
  if (!cashRules.shockModeActive) return 'NORMAL';
  if (marketResult.dataQuality === 'UNAVAILABLE' || marketResult.marketPhase === 'PANIC') return 'HOLD';
  return 'CAUTIOUS';
}

// Phase4B統合判断本体。「何を・いくら・どの方法で」買うかの判断材料を返す（自動発注はしない）。
// testOverrides: { engineAResult, engineAOverrides, cashRules, marketResult, targetYear,
//                  plannedContribution, nisaLimitUsage, eligibility, currentAllocation }
function NisaStrategyEngineB(testOverrides) {
  const opts = testOverrides || {};
  const calculatedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');

  const engineA = opts.engineAResult || NisaStrategyEngine(opts.engineAOverrides);
  if (engineA.status === 'BLOCKED') {
    return {
      status: 'BLOCKED', reason: engineA.reason,
      strategy: null, strategyConfidence: null, strategyReasons: [],
      targetYear: null, annualNisaLimit: NISA_ANNUAL_GROWTH_LIMIT + NISA_ANNUAL_TSUMITATE_LIMIT,
      growthLimit: NISA_ANNUAL_GROWTH_LIMIT, tsumitateLimit: NISA_ANNUAL_TSUMITATE_LIMIT,
      investableCash: 0, plannedContribution: null, recommendedInvestmentAmount: 0,
      allocationCheck: null, hybridOptions: [], categories: [],
      shockMode: null,
      cashAfterInvestment: null,
      // Phase5-D: engineA(Phase4A)は今回BLOCKED時もcurrentCash/protectedCashMin/totalValue/
      // marketDataQuality等を返すようになったため、それをそのまま素通しする（再計算なし）
      currentCash: engineA.currentCash, protectedCashMin: engineA.protectedCashMin,
      totalValue: engineA.totalValue,
      marketScore: engineA.marketScore, marketPhase: engineA.marketPhase,
      marketDataQuality: engineA.marketDataQuality, missingIndicators: engineA.missingIndicators, indicators: engineA.indicators,
      dataQuality: engineA.dataQuality, warnings: engineA.warnings, calculatedAt: calculatedAt,
    };
  }

  const cashRules    = opts.cashRules    || getCashRules();
  const marketResult = opts.marketResult || calcMarketScore();
  const targetYear   = opts.targetYear   || (new Date().getFullYear() + 1);
  const plannedContribution = opts.plannedContribution || getPlannedContribution(targetYear);
  const nisaLimitUsage      = opts.nisaLimitUsage      || getNisaLimitUsage(targetYear);
  const eligibilityResult   = opts.eligibility         || getCategoryNisaEligibility_();
  const currentAllocation   = opts.currentAllocation   || getCurrentAllocation();

  const warnings = [];
  if (eligibilityResult.dataQuality === 'UNAVAILABLE') warnings.push('取引履歴が取得できずNISA適格性を判定できないため、全カテゴリをUNCONFIRMEDとして扱います');
  warnings.push.apply(warnings, nisaLimitUsage.warnings);
  if (plannedContribution.status === 'UNKNOWN') warnings.push(targetYear + '年の入金予定が未確認のため、確信度を下げています（0円と断定はしていません）');

  // ── ショックモード（別軸） ──
  const shockLevel = getShockLevel_(cashRules, marketResult);

  // ── 投資額の確定 ──
  // investmentCapacity: 資金ルール・NISA枠から見た「理論上投資できる上限」。
  // 2026-08-14仕様変更: これは「実際に推奨する投資額」ではない。実際の推奨額
  // （recommendedInvestmentAmount）は、後述のウォーターフィル後の実配分合計(totalAllocated)。
  // 「投資可能資金がある」ことと「今回投資を推奨する」ことを区別するための変更。
  const investableCash = engineA.investableCash;
  const confirmedContribution = plannedContribution.status === 'CONFIRMED' ? plannedContribution.totalAmount : 0;
  const nisaCapacity = nisaLimitUsage.growthRemain + nisaLimitUsage.tsumiRemain;
  const investmentCapacity = Math.min(investableCash + confirmedContribution, nisaCapacity);

  // ── strategy判定（市場環境は方向を決めない） ──
  // immediateFundingRatio: 「今すぐ動かせる資金(investableCash)」がNISA実効残枠に対してどれだけ
  // あるかの比率。confirmedContribution（未来の継続入金）を混ぜたrecommendedInvestmentAmountで
  // 計算すると「余剰資金は少ないが将来入金がある」ケースが正しくDCA寄りと判定できなくなるため、
  // 意図的にinvestableCash単体を分子にしている。
  const gapMagnitude = engineA.categories.reduce((s, c) => s + Math.max(0, c.gapOverall), 0);
  const immediateFundingRatio = nisaCapacity > 0 ? investableCash / nisaCapacity : 0;
  const hasConfirmedContribution = confirmedContribution > 0;

  let strategy, strategyReasons = [];
  if (immediateFundingRatio >= 0.8 && gapMagnitude >= 1 && !hasConfirmedContribution) {
    strategy = 'LUMP_SUM';
    strategyReasons.push('今すぐ動かせる投資可能資金がNISA実効残枠の約' + Math.round(immediateFundingRatio * 100) + '%と十分にあり、ポートフォリオ不足（合計約' + gapMagnitude.toFixed(2) + 'pt)を早期に埋める余地がある（候補閾値: 資金比率80%以上・乖離合計1pt以上、要調整）');
  } else if (immediateFundingRatio < 0.3 && hasConfirmedContribution) {
    strategy = 'DCA';
    strategyReasons.push('今すぐ動かせる投資可能資金は限定的（NISA実効残枠の約' + Math.round(immediateFundingRatio * 100) + '%）だが、次年度の入金予定が確定しているため時間分散が適する（候補閾値: 資金比率30%未満、要調整）');
  } else {
    strategy = 'HYBRID';
    strategyReasons.push('投資可能資金・継続入金のいずれも部分的、または判断材料が拮抗しているため一括と積立を組み合わせる');
  }

  if (shockLevel !== 'NORMAL') {
    strategyReasons.push('ショックモード(' + shockLevel + ')中: 一括投資自体は禁止しないが、通常時より分割投資が選好されやすい局面として扱っています');
  }
  strategyReasons.push('市場環境: ' + (marketResult.marketPhase || '不明（データなし）') + '（Market Score ' + (marketResult.marketScore != null ? marketResult.marketScore : 'N/A') + '点）— strategyの決定要因にはせず、確信度の参考情報としてのみ使用しています');

  // ── confidence ──
  let downgrades = 0;
  if (plannedContribution.status === 'UNKNOWN') downgrades++;
  if (marketResult.dataQuality !== 'OK') downgrades++;
  if (shockLevel !== 'NORMAL') downgrades++;
  if (eligibilityResult.dataQuality === 'UNAVAILABLE') downgrades++;
  const strategyConfidence = downgrades === 0 ? 'HIGH' : downgrades === 1 ? 'MEDIUM' : 'LOW';

  // ── hybridOptions（根拠付きの複数候補、常に提示） ──
  const now = new Date();
  const remainingMonths = targetYear > now.getFullYear() ? 12 : Math.max(1, 12 - now.getMonth());
  const hybridOptions = [
    {
      label: 'Conservative',
      rationale: '確定している資金（投資可能資金）のみ即時投資し、未確定の将来入金は都度積立に回す最も保守的な案',
      initialLumpSum: investableCash,
      monthlyInvestment: remainingMonths > 0 ? Math.round(confirmedContribution / remainingMonths) : 0,
      months: remainingMonths,
    },
    {
      label: 'Balanced',
      rationale: '投資可能資金の半分を即時投資してタイミングリスクを一部解消しつつ、残り半分と確定入金分を時間分散する折衷案',
      initialLumpSum: Math.round(investableCash * 0.5),
      monthlyInvestment: remainingMonths > 0 ? Math.round((investableCash * 0.5 + confirmedContribution) / remainingMonths) : 0,
      months: remainingMonths,
    },
    {
      label: 'Aggressive',
      rationale: '確定している資金（投資可能資金＋確定入金予定）を全額即時投資し、NISA枠消化・期待リターンを優先する案',
      initialLumpSum: Math.min(investableCash + confirmedContribution, investmentCapacity),
      monthlyInvestment: 0,
      months: 0,
    },
  ];

  // ── カテゴリ別投資額（ウォーターフィル） ──
  // 2026-08-14仕様変更: neededAmountは「現在の総資産T」に対する不足額として計算する
  // （旧仕様の「投資後総資産(T+I)」基準ではない）。これにより、
  // 「currentWeight >= targetWeightのカテゴリはneededAmount=0」が厳密に成り立つ
  // （currentWeightもTに対する比率で計算されているため、定義が一致する）。
  // 「新規投資によって総資産が増える分、目標達成済みカテゴリの相対比率が
  // わずかに下がること」は許容し、目標達成済みカテゴリへの追加投資では補正しない
  // （2026-08-14ユーザー承認仕様）。
  const T = currentAllocation.totalValue || 0;

  const currentValueByCat = {};
  (currentAllocation.byCategory || []).forEach(c => { currentValueByCat[c.category] = c.value; });

  const sortedCategories = engineA.categories.slice().sort((a, b) => a.priorityRank - b.priorityRank);

  let cashRemaining     = investmentCapacity;
  let growthRemaining   = nisaLimitUsage.growthRemain;
  let tsumiRemaining    = nisaLimitUsage.tsumiRemain;

  const allocations = sortedCategories.map(c => {
    const V = currentValueByCat[c.category] || 0;
    const elig = eligibilityResult.map[c.category] || { growthEligible: false, tsumitateEligible: false };
    const nisaEligibility =
      elig.growthEligible && elig.tsumitateEligible ? 'CONFIRMED_BOTH' :
      elig.growthEligible ? 'CONFIRMED_GROWTH' :
      elig.tsumitateEligible ? 'CONFIRMED_TSUMITATE' : 'UNCONFIRMED';

    const catReasons  = c.reasons.slice();
    const catWarnings = c.warnings.slice();
    let recommendedAmount = 0;
    let investmentMethod  = 'NONE';

    if (nisaEligibility === 'UNCONFIRMED') {
      catReasons.push('NISA適格性が未確認のため自動配分の対象外です（「NISAで買えない」という意味ではなく、過去の購入実績で確認できていないだけです）');
    } else if (c.currentWeight >= c.targetWeight) {
      // currentWeight >= targetWeight: 目標達成済み・超過。新規投資を自動配分しない。
      catReasons.push('実資産全体で既に目標比率に達しているため、今回は新規投資の自動配分対象外です');
    } else if (T > 0) {
      const neededAmount = Math.max(0, (c.targetWeight / 100) * T - V);
      const allocatable  = Math.min(neededAmount, cashRemaining);

      let fromGrowth = elig.growthEligible ? Math.min(allocatable, growthRemaining) : 0;
      const stillNeeded = allocatable - fromGrowth;
      let fromTsumi = (stillNeeded > 0 && elig.tsumitateEligible) ? Math.min(stillNeeded, tsumiRemaining) : 0;

      recommendedAmount = fromGrowth + fromTsumi;
      growthRemaining  -= fromGrowth;
      tsumiRemaining   -= fromTsumi;
      cashRemaining    -= recommendedAmount;

      investmentMethod = fromGrowth > 0 && fromTsumi > 0 ? 'GROWTH+TSUMITATE'
        : fromGrowth > 0 ? 'GROWTH'
        : fromTsumi > 0 ? 'TSUMITATE' : 'NONE';

      if (recommendedAmount < neededAmount - 0.5) {
        catWarnings.push('NISA枠残または投資可能資金の制約により、目標比率までは届かない配分になっています');
      }
    }

    return { category: c.category, engineACategory: c, V: V, nisaEligibility: nisaEligibility, recommendedAmount: recommendedAmount, investmentMethod: investmentMethod, reasons: catReasons, warnings: catWarnings };
  });

  const totalAllocated = Math.round(allocations.reduce((s, a) => s + a.recommendedAmount, 0));

  // proposedWeight/remainingGapは「実際に配分した合計額(totalAllocated)を投資した場合」の
  // シミュレーションとして、投資後総資産 T+totalAllocated を分母に用いる（表示専用、配分判断には使わない）
  const finalTotalForDisplay = T + totalAllocated;
  const resultCategories = allocations.map(a => {
    const c = a.engineACategory;
    const proposedValue  = a.V + a.recommendedAmount;
    const proposedWeight = finalTotalForDisplay > 0 ? Math.round((proposedValue / finalTotalForDisplay) * 10000) / 100 : c.currentWeight;
    const remainingGap   = Math.round((c.targetWeight - proposedWeight) * 100) / 100;
    return {
      category: c.category,
      priorityRank: c.priorityRank,
      currentValue: a.V,
      currentWeight: c.currentWeight,
      targetWeight: c.targetWeight,
      gapOverall: c.gapOverall,
      // Phase5-D: Phase4A(engineA)が既に計算済みのgapNisa/priorityScore/overallGapScore/
      // nisaPresenceScoreを、判断履歴での再現性向上のためそのまま伝播する（再計算なし）
      gapNisa: c.gapNisa,
      priorityScore: c.priorityScore,
      overallGapScore: c.overallGapScore,
      nisaPresenceScore: c.nisaPresenceScore,
      nisaEligibility: a.nisaEligibility,
      recommendedAmount: Math.round(a.recommendedAmount),
      investmentMethod: a.investmentMethod,
      proposedWeight: proposedWeight,
      remainingGap: remainingGap,
      reasons: a.reasons,
      warnings: a.warnings,
    };
  });

  // recommendedInvestmentAmount: 「実際に推奨する投資額」＝ウォーターフィルで実際に配分した合計。
  // investmentCapacity（資金・NISA枠上の理論上限）とは異なる概念として明確に分離する
  // （2026-08-14仕様変更: 「投資可能資金がある」≠「今回投資を推奨する」）。
  const recommendedInvestmentAmount = totalAllocated;
  const unusedCapacity = Math.round(investmentCapacity - totalAllocated);
  const investmentRecommendation = totalAllocated === 0 ? 'NONE' : unusedCapacity > 0 ? 'PARTIAL' : 'FULL';

  const allocationCheck = {
    investmentCapacity: investmentCapacity,
    totalAllocated: totalAllocated,
    unusedCapacity: unusedCapacity,
    reason:
      totalAllocated === 0
        ? '現在の実資産配分は目標配分を満たしている（または全て適格性未確認の）カテゴリのみのため、新規投資の候補となるカテゴリがありません。投資可能資金' + investmentCapacity + '円は今回使われません'
        : unusedCapacity > 0
          ? '不足カテゴリを目標比率まで満たすと' + totalAllocated + '円で足り、残り' + unusedCapacity + '円は投資可能資金の範囲内で使い切っていません（目標超過を避けるための意図した挙動です）'
          : '不足カテゴリの合計needed額が投資可能資金以上のため、投資可能資金の範囲内で優先順位順に全額配分しました',
  };
  if (investmentRecommendation !== 'FULL') warnings.push(allocationCheck.reason);

  return {
    status: 'OK',
    strategy: strategy,
    strategyConfidence: strategyConfidence,
    strategyReasons: strategyReasons,

    targetYear: targetYear,
    annualNisaLimit: NISA_ANNUAL_GROWTH_LIMIT + NISA_ANNUAL_TSUMITATE_LIMIT,
    growthLimit: NISA_ANNUAL_GROWTH_LIMIT,
    tsumitateLimit: NISA_ANNUAL_TSUMITATE_LIMIT,
    nisaLimitUsage: nisaLimitUsage,

    investableCash: investableCash,
    plannedContribution: plannedContribution,
    investmentCapacity: investmentCapacity,
    recommendedInvestmentAmount: recommendedInvestmentAmount,
    investmentRecommendation: investmentRecommendation,
    allocationCheck: allocationCheck,

    hybridOptions: hybridOptions,
    categories: resultCategories,

    shockMode: { active: cashRules.shockModeActive, level: shockLevel },
    cashAfterInvestment: cashRules.currentCash - totalAllocated,
    // Phase5-D: currentCash/totalValueは既に取得済みの値をそのまま追加しただけ（再計算なし）
    currentCash: cashRules.currentCash,
    protectedCashMin: cashRules.protectedCashMin,
    totalValue: T,

    marketScore: marketResult.marketScore,
    marketPhase: marketResult.marketPhase,
    marketDataQuality: marketResult.dataQuality,
    missingIndicators: marketResult.missingIndicators,
    indicators: marketResult.indicators,

    dataQuality: engineA.dataQuality,
    warnings: warnings.concat(engineA.warnings),
    calculatedAt: calculatedAt,
  };
}

// ── テスト関数群（Phase4B）。本番のcurrentCashは一切変更しない（testOverridesで完結） ──

function baseSufficientCashOverride_() {
  const real = getCashRules();
  return Object.assign({}, real, { currentCash: real.protectedCashMin + 3000000 });
}

// CASE1: currentCash=protectedCashMin → 投資不可（Phase4AのBLOCKEDをそのまま継承）
function testEngineB_Case1_CashEqualsProtected() {
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin });
  const result = NisaStrategyEngineB({ engineAOverrides: { cashRules: cashRules } });
  Logger.log('■ CASE1（currentCash=protectedCashMin）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: status=' + result.status + ' (期待値: BLOCKED)');
}

// CASE2: 十分な余剰資金 + 市場環境良好 → 資金比率とgapで判定（strategyは市場では反転しないことも確認）
function testEngineB_Case2_SufficientCashGoodMarket() {
  const cashRules = baseSufficientCashOverride_();
  const marketResult = { marketScore: 89, marketPhase: 'EUPHORIA', indicators: [], dataQuality: 'OK', missingIndicators: [], warnings: [], calculatedAt: '' };
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'UNKNOWN', totalAmount: null, months: [], warnings: [] };
  const result = NisaStrategyEngineB({ engineAOverrides: { cashRules: cashRules, marketResult: marketResult }, cashRules: cashRules, marketResult: marketResult, plannedContribution: plannedContribution });
  Logger.log('■ CASE2（十分な余剰資金+市場環境良好・入金予定UNKNOWN）:');
  Logger.log(JSON.stringify(result, null, 2));
}

// CASE3: 十分な余剰資金 + 市場環境不安定 → strategyがCASE2と同じ判定基準で決まり、市場だけで反転しないことを確認
function testEngineB_Case3_SufficientCashBadMarket() {
  const cashRules = baseSufficientCashOverride_();
  const marketResult = { marketScore: 12, marketPhase: 'PANIC', indicators: [], dataQuality: 'OK', missingIndicators: [], warnings: [], calculatedAt: '' };
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'UNKNOWN', totalAmount: null, months: [], warnings: [] };
  const result = NisaStrategyEngineB({ engineAOverrides: { cashRules: cashRules, marketResult: marketResult }, cashRules: cashRules, marketResult: marketResult, plannedContribution: plannedContribution });
  Logger.log('■ CASE3（十分な余剰資金+市場環境不安定・入金予定UNKNOWN）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: CASE2とCASE3でstrategyが市場環境だけで反転していないか比較してください（strategyReasonsに市場情報は載るが決定要因ではないはず）');
}

// CASE4: 余剰資金少ない + 毎月入金あり → DCA寄り
function testEngineB_Case4_LimitedCashRecurringIncome() {
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin + 100000 });
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'CONFIRMED', totalAmount: 1200000, months: [], warnings: [] };
  const result = NisaStrategyEngineB({ engineAOverrides: { cashRules: cashRules }, cashRules: cashRules, plannedContribution: plannedContribution });
  Logger.log('■ CASE4（余剰資金少ない+次年度入金確定1,200,000円）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: strategy=' + result.strategy + ' (期待傾向: DCA)');
}

// CASE5: shockModeActive=true → shockMode.levelがCAUTIOUS/HOLDになり、かつLUMP_SUMが禁止されないことを確認
function testEngineB_Case5_ShockMode() {
  const cashRules = Object.assign({}, baseSufficientCashOverride_(), { shockModeActive: true });
  const result = NisaStrategyEngineB({ engineAOverrides: { cashRules: cashRules }, cashRules: cashRules });
  Logger.log('■ CASE5（shockModeActive=true）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: shockMode.level=' + JSON.stringify(result.shockMode) + '（NORMAL以外のはず）、strategyがLUMP_SUMになる可能性も残っているか確認してください');
}

// CASE6: NISA枠(360万) > 投資可能資金 → recommendedInvestmentAmountは投資可能資金側で頭打ちになる
function testEngineB_Case6_InvestableCashBelowNisaLimit() {
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin + 500000 });
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'UNKNOWN', totalAmount: null, months: [], warnings: [] };
  const result = NisaStrategyEngineB({ engineAOverrides: { cashRules: cashRules }, cashRules: cashRules, plannedContribution: plannedContribution });
  Logger.log('■ CASE6（投資可能資金50万円 < NISA枠360万円）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: investmentCapacity=' + result.investmentCapacity + ' (期待値: 500000、annualNisaLimitの3600000ではない)。recommendedInvestmentAmount=' + result.recommendedInvestmentAmount + '（実際の不足額に応じた配分合計、investmentCapacity以下のはず）');
}

// CASE7: 投資後に特定カテゴリがtargetWeightを超過しない設計になっているか確認（ウォーターフィルはneededAmount=0で頭打ち）
function testEngineB_Case7_NoOvershoot() {
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin + 20000000 }); // 意図的に大きな資金で全カテゴリ充足を試す
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'UNKNOWN', totalAmount: null, months: [], warnings: [] };
  const result = NisaStrategyEngineB({ engineAOverrides: { cashRules: cashRules }, cashRules: cashRules, plannedContribution: plannedContribution });
  Logger.log('■ CASE7（意図的に大資金を注入し全カテゴリ充足を試す）:');
  Logger.log(JSON.stringify(result, null, 2));
  const overshoot = result.categories.filter(c => c.proposedWeight > c.targetWeight + 0.01);
  Logger.log('検証: targetWeightを超過したカテゴリ件数=' + overshoot.length + ' (期待値: 0)。allocationCheck=' + JSON.stringify(result.allocationCheck));
}

// CASE8: NISA未保有カテゴリは優先候補になるが、UNCONFIRMEDなら自動配分されないことを確認
function testEngineB_Case8_NisaAbsentUnconfirmedNotAutoAllocated() {
  const cashRules = baseSufficientCashOverride_();
  const eligibility = { map: { 'オルカン': { growthEligible: true, tsumitateEligible: true }, 'S&P500': { growthEligible: true, tsumitateEligible: true }, 'ゴールド': { growthEligible: true, tsumitateEligible: false } }, dataQuality: 'OK' };
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'UNKNOWN', totalAmount: null, months: [], warnings: [] };
  const result = NisaStrategyEngineB({ engineAOverrides: { cashRules: cashRules }, cashRules: cashRules, eligibility: eligibility, plannedContribution: plannedContribution });
  Logger.log('■ CASE8（FANG+等はeligibility未定義=UNCONFIRMED扱い）:');
  Logger.log(JSON.stringify(result, null, 2));
  const fangp = result.categories.find(c => c.category === 'FANG+');
  Logger.log('検証: FANG+のnisaEligibility=' + (fangp && fangp.nisaEligibility) + ' (期待値: UNCONFIRMED), recommendedAmount=' + (fangp && fangp.recommendedAmount) + ' (期待値: 0)');
}

// 実データ確認用（本番シートは変更しない）
function testEngineB_RealDataWithSufficientCash() {
  const cashRules = baseSufficientCashOverride_();
  const result = NisaStrategyEngineB({ engineAOverrides: { cashRules: cashRules }, cashRules: cashRules });
  Logger.log('■ 実データ確認（currentCashのみ一時的に+300万円で注入、シートは未変更）:');
  Logger.log(JSON.stringify(result, null, 2));
}

// ══════════════════════════════════════════════════════════
// Phase4C: 次年度NISA投資判断の最終出力・実運用前QA
// ══════════════════════════════════════════════════════════
// 2026-08-14 実装。Phase4Aの判定ロジック・Phase4Bのstrategy/配分ロジックは一切変更していない。
// NisaStrategyEngineC()はNisaStrategyEngine()とNisaStrategyEngineB()の出力を
// 人間が判断しやすい形に整形する表示レイヤーであり、新しい判断基準・スコアは追加しない。
//
// engineA（Phase4A）を1回だけ呼び出し、その結果をそのままengineBOverrides.engineAResultとして
// NisaStrategyEngineB()に渡す（Phase4Bに既にあった拡張ポイントをそのまま利用）。これにより
// 「投資管理ダッシュボードへの重複フェッチ」を追加で増やさずにengineAのnisaWeight/nisaAbsent
// （Phase4Bの出力には含まれていなかった）をPhase4Cの表示に利用できる。

function NisaStrategyEngineC(testOverrides) {
  const opts = testOverrides || {};
  const calculatedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');

  const engineA = opts.engineAResult || NisaStrategyEngine(opts.engineAOverrides);
  const engineBOverrides = Object.assign({}, opts.engineBOverrides, { engineAResult: engineA });
  const engineB = opts.engineBResult || NisaStrategyEngineB(engineBOverrides);

  if (engineB.status === 'BLOCKED') {
    return {
      status: 'BLOCKED',
      summary: {
        headline: '判断保留',
        action: '現時点では新規のNISA投資判断を行いません',
        reason: engineB.reason,
        caution: '「資金ルール」シートのCURRENT_CASHや資金状況を確認してから再実行してください',
      },
      finalDecision: null,
      comparisonOptions: [],
      categories: [],
      nisaEligibilitySummary: null,
      plannedContribution: null,
      dataQuality: engineB.dataQuality,
      warnings: engineB.warnings,
      calculatedAt: calculatedAt,
    };
  }

  // ── ①最終判定サマリー（断定表現を避ける） ──
  // 2026-08-14仕様変更: 「投資可能資金がある」ことと「今回投資を推奨する」ことを区別する。
  // engineB.investmentRecommendation==='NONE'（実際の配分候補が0件）の場合は、
  // strategy（LUMP_SUM/DCA/HYBRID、Phase4Bの既存ロジックは無変更）の文言をそのまま
  // headlineに出すと「資金の使い方」の話と誤解されるため、headlineだけ専用文言に差し替える。
  // strategy自体の値・算出ロジックは変更していない。
  const strategyHeadline = {
    LUMP_SUM: '一括投資を優先する条件が成立',
    DCA:      '積立投資を優先する条件が成立',
    HYBRID:   'ハイブリッド（一括+積立の組み合わせ）が妥当',
  }[engineB.strategy] || '判断保留';

  const noCandidateHeadline = '投資資金はあるが、現在の目標配分上、新規投資を優先すべきカテゴリが確認できない';

  const summary = {
    headline: engineB.investmentRecommendation === 'NONE' ? noCandidateHeadline : strategyHeadline,
    action: engineB.investmentRecommendation === 'NONE'
      ? '現在のポートフォリオは目標配分を満たしています。無理に投資先を作らず、次回以降の乖離発生時に再判定してください'
      : '下記のcomparisonOptions（Conservative/Balanced/Aggressive）を比較したうえでご自身で最終判断してください',
    reason: engineB.strategyReasons.join(' / '),
    caution: engineB.warnings.length > 0 ? engineB.warnings.join(' / ') : '特にありません',
  };

  const finalDecision = {
    status: engineB.status,
    strategy: engineB.strategy,
    strategyConfidence: engineB.strategyConfidence,
    strategyReasons: engineB.strategyReasons,
    investableCash: engineB.investableCash,
    plannedContribution: engineB.plannedContribution,
    investmentCapacity: engineB.investmentCapacity,
    recommendedInvestmentAmount: engineB.recommendedInvestmentAmount,
    investmentRecommendation: engineB.investmentRecommendation,
    annualNisaLimit: engineB.annualNisaLimit,
    growthRemain: engineB.nisaLimitUsage.growthRemain,
    tsumitateRemain: engineB.nisaLimitUsage.tsumiRemain,
    shockMode: engineB.shockMode,
    marketPhase: engineB.marketPhase,
    marketScore: engineB.marketScore,
    // Phase5-D: engineB(Phase4B)が既に保持しているcurrentCash/protectedCashMin/totalValue/
    // marketDataQuality等を、判断履歴での再現性向上のためそのまま伝播する（再計算なし）
    currentCash: engineB.currentCash,
    protectedCashMin: engineB.protectedCashMin,
    totalValue: engineB.totalValue,
    marketDataQuality: engineB.marketDataQuality,
    missingIndicators: engineB.missingIndicators,
    indicators: engineB.indicators,
  };

  // ── ②一括・積立・ハイブリッドの比較表示（既存hybridOptionsをそのまま利用、新スコアは作らない） ──
  const comparisonOptions = engineB.hybridOptions.map(function (opt) {
    return {
      label: opt.label,
      rationale: opt.rationale,
      initialLumpSum: opt.initialLumpSum,
      monthlyInvestment: opt.monthlyInvestment,
      months: opt.months,
      totalPlannedInvestment: opt.initialLumpSum + (opt.monthlyInvestment * opt.months),
    };
  });

  // ── ③カテゴリ別投資優先順位（engineAのnisaWeight/nisaAbsentをengineBのcategoriesにマージ） ──
  const engineAByCategory = {};
  engineA.categories.forEach(function (c) { engineAByCategory[c.category] = c; });

  const categories = engineB.categories.map(function (c) {
    const a = engineAByCategory[c.category] || {};
    return {
      category: c.category,
      priorityRank: c.priorityRank,
      currentValue: c.currentValue,
      currentWeight: c.currentWeight,
      targetWeight: c.targetWeight,
      gapOverall: c.gapOverall,
      // Phase5-D: engineB(Phase4B)が既に伝播しているgapNisa/priorityScore/overallGapScore/
      // nisaPresenceScoreを、判断履歴での再現性向上のためそのまま伝播する（再計算なし）
      gapNisa: c.gapNisa,
      priorityScore: c.priorityScore,
      overallGapScore: c.overallGapScore,
      nisaPresenceScore: c.nisaPresenceScore,
      underweightOverall: c.gapOverall > 0,          // ①実資産全体では不足しているか
      nisaWeight: a.nisaWeight != null ? a.nisaWeight : null,
      nisaHolding: a.nisaAbsent === false,             // ②NISAでは保有しているか
      nisaEligibility: c.nisaEligibility,              // ③NISA適格性が確認済みか
      autoAllocated: c.recommendedAmount > 0,          // ④今回の自動配分対象になるか
      recommendedAmount: c.recommendedAmount,
      investmentMethod: c.investmentMethod,
      proposedWeight: c.proposedWeight,
      remainingGap: c.remainingGap,
      reasons: c.reasons,
      warnings: c.warnings,
    };
  });

  // ── ④NISA適格性サマリー ──
  const nisaEligibilitySummary = {
    CONFIRMED_BOTH:      categories.filter(function (c) { return c.nisaEligibility === 'CONFIRMED_BOTH'; }).map(function (c) { return c.category; }),
    CONFIRMED_GROWTH:    categories.filter(function (c) { return c.nisaEligibility === 'CONFIRMED_GROWTH'; }).map(function (c) { return c.category; }),
    CONFIRMED_TSUMITATE: categories.filter(function (c) { return c.nisaEligibility === 'CONFIRMED_TSUMITATE'; }).map(function (c) { return c.category; }),
    UNCONFIRMED:         categories.filter(function (c) { return c.nisaEligibility === 'UNCONFIRMED'; }).map(function (c) { return c.category; }),
  };

  return {
    status: 'OK',
    summary: summary,
    finalDecision: finalDecision,
    comparisonOptions: comparisonOptions,
    categories: categories,
    nisaEligibilitySummary: nisaEligibilitySummary,
    plannedContribution: engineB.plannedContribution,
    dataQuality: engineB.dataQuality,
    warnings: engineB.warnings,
    calculatedAt: calculatedAt,
  };
}

// ── テスト関数群（Phase4C）。本番のCURRENT_CASHは一切変更しない ──

// CASE9: currentCash = protectedCashMin → BLOCKED（Phase4AのHARD RULEがPhase4Cでも維持されるか）
function testEngineC_Case9_CashEqualsProtected() {
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin });
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules } });
  Logger.log('■ CASE9（currentCash=protectedCashMin）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: status=' + result.status + ' (期待値: BLOCKED)');
}

// CASE10: currentCash < protectedCashMin → BLOCKED
function testEngineC_Case10_CashBelowProtected() {
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin - 500000 });
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules } });
  Logger.log('■ CASE10（currentCash<protectedCashMin）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: status=' + result.status + ' (期待値: BLOCKED)');
}

// CASE11: currentCash = null → BLOCKED
function testEngineC_Case11_CashNull() {
  const cashRules = Object.assign({}, getCashRules(), { currentCash: null });
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules } });
  Logger.log('■ CASE11（currentCash=null）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: status=' + result.status + ' (期待値: BLOCKED)');
}

// CASE12: investableCash>0・plannedContribution=UNKNOWN → 正常判定（BLOCKEDにならない）
function testEngineC_Case12_NormalUnknownContribution() {
  const cashRules = baseSufficientCashOverride_();
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'UNKNOWN', totalAmount: null, months: [], warnings: [] };
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules, plannedContribution: plannedContribution } });
  Logger.log('■ CASE12（investableCash>0・plannedContribution=UNKNOWN）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: status=' + result.status + ' (期待値: OK), plannedContribution.status=' + result.plannedContribution.status + ' (期待値: UNKNOWN)');
}

// CASE13: investableCashが少額・plannedContributionが確定 → DCAまたはHYBRID寄りを確認
function testEngineC_Case13_LimitedCashConfirmedContribution() {
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin + 200000 });
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'CONFIRMED', totalAmount: 600000, months: [], warnings: [] };
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules, plannedContribution: plannedContribution } });
  Logger.log('■ CASE13（余剰資金20万円・次年度入金確定60万円）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: strategy=' + result.finalDecision.strategy + ' (期待傾向: DCAまたはHYBRID)');
}

// CASE14: NISA枠(360万)以上の資金 → recommendedInvestmentAmountがNISA残枠を超えない
function testEngineC_Case14_CashAboveNisaLimit() {
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin + 10000000 });
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules } });
  Logger.log('■ CASE14（投資可能資金1000万円 > NISA枠360万円）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: investmentCapacity=' + result.finalDecision.investmentCapacity + ' (期待値: 3600000以下)。recommendedInvestmentAmount=' + result.finalDecision.recommendedInvestmentAmount + '（実際の不足額ベースの配分合計）');
}

// CASE15: NISA残枠より投資可能資金が少ない → 投資可能資金が上限になる
function testEngineC_Case15_CashBelowNisaLimit() {
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin + 300000 });
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules } });
  Logger.log('■ CASE15（投資可能資金30万円 < NISA枠360万円）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: investmentCapacity=' + result.finalDecision.investmentCapacity + ' (期待値: 300000)。recommendedInvestmentAmount=' + result.finalDecision.recommendedInvestmentAmount + '（実際の不足額ベースの配分合計、300000以下のはず）');
}

// CASE16: PANIC + 十分な投資資金 → Market PhaseだけでDCAに変更されないことを確認
function testEngineC_Case16_PanicWithSufficientCash() {
  const cashRules = baseSufficientCashOverride_();
  const marketResult = { marketScore: 8, marketPhase: 'PANIC', indicators: [], dataQuality: 'OK', missingIndicators: [], warnings: [], calculatedAt: '' };
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'UNKNOWN', totalAmount: null, months: [], warnings: [] };
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules, marketResult: marketResult }, engineBOverrides: { cashRules: cashRules, marketResult: marketResult, plannedContribution: plannedContribution } });
  Logger.log('■ CASE16（PANIC+十分な投資資金）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: marketPhase=PANICでもstrategy=' + result.finalDecision.strategy + ' (期待値: DCAに強制変更されていない)');
}

// CASE17: shockModeActive=true → CAUTIOUS、LUMP_SUM禁止になっていないことを確認
function testEngineC_Case17_ShockModeAllowsLumpSum() {
  const cashRules = Object.assign({}, baseSufficientCashOverride_(), { shockModeActive: true });
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules } });
  Logger.log('■ CASE17（shockModeActive=true）:');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('検証: shockMode=' + JSON.stringify(result.finalDecision.shockMode) + '（levelはCAUTIOUS想定）、strategy=' + result.finalDecision.strategy + '（LUMP_SUMも許容されるはず）');
}

// CASE18: 全カテゴリ目標到達済み → 不要な投資を生成しない
function testEngineC_Case18_AllCategoriesAtTarget() {
  const targetAllocation = [
    { category: 'A', targetWeight: 50, enabled: true, note: '' },
    { category: 'B', targetWeight: 50, enabled: true, note: '' },
  ];
  const currentAllocation = {
    calculatedAt: '', totalValue: 1000000,
    byCategory: [
      { category: 'A', value: 500000, weight: 50, principal: 500000, gain: 0, gainPct: 0 },
      { category: 'B', value: 500000, weight: 50, principal: 500000, gain: 0, gainPct: 0 },
    ],
    dataQuality: 'OK', warnings: [],
  };
  const nisaAllocation = {
    calculatedAt: '', totalNisaValue: 0,
    byCategory: [
      { category: 'A', nisaValue: 0, nisaWeight: 0, nisaAbsent: true },
      { category: 'B', nisaValue: 0, nisaWeight: 0, nisaAbsent: true },
    ],
    dataQuality: 'OK', warnings: [],
  };
  const eligibility = { map: { 'A': { growthEligible: true, tsumitateEligible: true }, 'B': { growthEligible: true, tsumitateEligible: true } }, dataQuality: 'OK' };
  const cashRules = baseSufficientCashOverride_();
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'UNKNOWN', totalAmount: null, months: [], warnings: [] };
  const result = NisaStrategyEngineC({
    engineAOverrides: { targetAllocation: targetAllocation, currentAllocation: currentAllocation, nisaAllocation: nisaAllocation, cashRules: cashRules },
    engineBOverrides: { cashRules: cashRules, currentAllocation: currentAllocation, eligibility: eligibility, plannedContribution: plannedContribution },
  });
  Logger.log('■ CASE18（全カテゴリ目標到達済み）:');
  Logger.log(JSON.stringify(result, null, 2));
  const totalRecommended = result.categories.reduce(function (s, c) { return s + c.recommendedAmount; }, 0);
  Logger.log('検証: 全カテゴリrecommendedAmount合計=' + totalRecommended + ' (期待値: 0、目標到達済みのため不要な投資を生成しない)');
}

// CASE19: UNCONFIRMEDカテゴリしか不足していない → 自動配分対象外として警告
function testEngineC_Case19_OnlyUnconfirmedUnderweight() {
  const targetAllocation = [
    { category: 'A', targetWeight: 50, enabled: true, note: '' }, // NISA適格CONFIRMED、目標達成済み
    { category: 'B', targetWeight: 50, enabled: true, note: '' }, // NISA適格UNCONFIRMED、不足
  ];
  const currentAllocation = {
    calculatedAt: '', totalValue: 1000000,
    byCategory: [
      { category: 'A', value: 500000, weight: 50, principal: 500000, gain: 0, gainPct: 0 },
      { category: 'B', value: 300000, weight: 30, principal: 300000, gain: 0, gainPct: 0 }, // 不足
    ],
    dataQuality: 'OK', warnings: [],
  };
  const nisaAllocation = {
    calculatedAt: '', totalNisaValue: 500000,
    byCategory: [
      { category: 'A', nisaValue: 500000, nisaWeight: 100, nisaAbsent: false },
      { category: 'B', nisaValue: 0,      nisaWeight: 0,   nisaAbsent: true },
    ],
    dataQuality: 'OK', warnings: [],
  };
  const eligibility = { map: { 'A': { growthEligible: true, tsumitateEligible: true } }, dataQuality: 'OK' }; // Bは未定義=UNCONFIRMED
  const cashRules = baseSufficientCashOverride_();
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'UNKNOWN', totalAmount: null, months: [], warnings: [] };
  const result = NisaStrategyEngineC({
    engineAOverrides: { targetAllocation: targetAllocation, currentAllocation: currentAllocation, nisaAllocation: nisaAllocation, cashRules: cashRules },
    engineBOverrides: { cashRules: cashRules, currentAllocation: currentAllocation, eligibility: eligibility, plannedContribution: plannedContribution },
  });
  Logger.log('■ CASE19（不足カテゴリBがUNCONFIRMEDのみ）:');
  Logger.log(JSON.stringify(result, null, 2));
  const catB = result.categories.find(function (c) { return c.category === 'B'; });
  Logger.log('検証: Bのnisa Eligibility=' + (catB && catB.nisaEligibility) + ' (期待値: UNCONFIRMED), recommendedAmount=' + (catB && catB.recommendedAmount) + ' (期待値: 0), reasonsに未確認の注記があるはず');
}

// 実データ確認用（本番シートは変更しない）
function testEngineC_RealDataWithSufficientCash() {
  const cashRules = baseSufficientCashOverride_();
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules } });
  Logger.log('■ Phase4C 実データ確認（currentCashのみ一時的に+300万円で注入、シートは未変更）:');
  Logger.log(JSON.stringify(result, null, 2));
}

// ── CASE20〜27用の共通ヘルパー: A/B 2カテゴリのシナリオを組み立てる ──
// weights: { aWeight, bWeight, aTarget, bTarget }, capacity: currentCash上乗せ額
// eligibilityMap省略時は両方CONFIRMED_BOTH
function buildTwoCategoryScenario_(aWeight, bWeight, aTarget, bTarget, extraCash, eligibilityMap) {
  const total = 1000000;
  const targetAllocation = [
    { category: 'A', targetWeight: aTarget, enabled: true, note: '' },
    { category: 'B', targetWeight: bTarget, enabled: true, note: '' },
  ];
  const currentAllocation = {
    calculatedAt: '', totalValue: total,
    byCategory: [
      { category: 'A', value: Math.round(total * aWeight / 100), weight: aWeight, principal: Math.round(total * aWeight / 100), gain: 0, gainPct: 0 },
      { category: 'B', value: Math.round(total * bWeight / 100), weight: bWeight, principal: Math.round(total * bWeight / 100), gain: 0, gainPct: 0 },
    ],
    dataQuality: 'OK', warnings: [],
  };
  const nisaAllocation = {
    calculatedAt: '', totalNisaValue: 0,
    byCategory: [
      { category: 'A', nisaValue: 0, nisaWeight: 0, nisaAbsent: true },
      { category: 'B', nisaValue: 0, nisaWeight: 0, nisaAbsent: true },
    ],
    dataQuality: 'OK', warnings: [],
  };
  const eligibility = { map: eligibilityMap || { 'A': { growthEligible: true, tsumitateEligible: true }, 'B': { growthEligible: true, tsumitateEligible: true } }, dataQuality: 'OK' };
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin + extraCash });
  const plannedContribution = { year: new Date().getFullYear() + 1, status: 'UNKNOWN', totalAmount: null, months: [], warnings: [] };
  return NisaStrategyEngineC({
    engineAOverrides: { targetAllocation: targetAllocation, currentAllocation: currentAllocation, nisaAllocation: nisaAllocation, cashRules: cashRules },
    engineBOverrides: { cashRules: cashRules, currentAllocation: currentAllocation, eligibility: eligibility, plannedContribution: plannedContribution },
  });
}

// CASE20: A=60%(超過) / B=40%(不足)、目標50/50 → Bのみ投資候補
function testEngineC_Case20_OnlyBUnderweight() {
  const result = buildTwoCategoryScenario_(60, 40, 50, 50, 3000000);
  Logger.log('■ CASE20（A=60% B=40%、目標50/50）:');
  Logger.log(JSON.stringify(result.categories, null, 2));
  const a = result.categories.find(function (c) { return c.category === 'A'; });
  const b = result.categories.find(function (c) { return c.category === 'B'; });
  Logger.log('検証: A.recommendedAmount=' + a.recommendedAmount + ' (期待値: 0), B.recommendedAmount=' + b.recommendedAmount + ' (期待値: >0)');
}

// CASE21: A=40%(不足) / B=60%(超過)、目標50/50 → Aのみ投資候補
function testEngineC_Case21_OnlyAUnderweight() {
  const result = buildTwoCategoryScenario_(40, 60, 50, 50, 3000000);
  Logger.log('■ CASE21（A=40% B=60%、目標50/50）:');
  Logger.log(JSON.stringify(result.categories, null, 2));
  const a = result.categories.find(function (c) { return c.category === 'A'; });
  const b = result.categories.find(function (c) { return c.category === 'B'; });
  Logger.log('検証: A.recommendedAmount=' + a.recommendedAmount + ' (期待値: >0), B.recommendedAmount=' + b.recommendedAmount + ' (期待値: 0)');
}

// CASE22: A=49%(僅かに不足) / B=51%(僅かに超過)、目標50/50 → Aのみ投資候補（境界値）
function testEngineC_Case22_BoundaryUnderweight() {
  const result = buildTwoCategoryScenario_(49, 51, 50, 50, 3000000);
  Logger.log('■ CASE22（A=49% B=51%、目標50/50、境界値）:');
  Logger.log(JSON.stringify(result.categories, null, 2));
  const a = result.categories.find(function (c) { return c.category === 'A'; });
  const b = result.categories.find(function (c) { return c.category === 'B'; });
  Logger.log('検証: A.recommendedAmount=' + a.recommendedAmount + ' (期待値: >0), B.recommendedAmount=' + b.recommendedAmount + ' (期待値: 0)');
}

// CASE23: 全カテゴリが目標超過 → recommendedAmount=0
function testEngineC_Case23_AllOverweight() {
  const result = buildTwoCategoryScenario_(60, 60, 50, 40, 3000000); // 合計100%になるようtargetを調整(50+40=90のため厳密には合計100%制約はengineA側のvalidateのみ、テストでは直接targetAllocationを渡すため無視される)
  Logger.log('■ CASE23（A=60%>target50% B=60%>target40%、両方超過）:');
  Logger.log(JSON.stringify(result.categories, null, 2));
  const total = result.categories.reduce(function (s, c) { return s + c.recommendedAmount; }, 0);
  Logger.log('検証: recommendedAmount合計=' + total + ' (期待値: 0)、investmentRecommendation=' + result.finalDecision.investmentRecommendation + ' (期待値: NONE)');
}

// CASE24: 不足カテゴリがあるが全てNISA適格性UNCONFIRMED → recommendedAmount=0・警告
function testEngineC_Case24_OnlyUnconfirmedUnderweightAll() {
  const result = buildTwoCategoryScenario_(30, 30, 50, 50, 3000000, {}); // eligibilityMap空=両方UNCONFIRMED
  Logger.log('■ CASE24（A/Bとも不足だが両方UNCONFIRMED）:');
  Logger.log(JSON.stringify(result, null, 2));
  const total = result.categories.reduce(function (s, c) { return s + c.recommendedAmount; }, 0);
  Logger.log('検証: recommendedAmount合計=' + total + ' (期待値: 0)、warningsに未配分の注記があるはず=' + JSON.stringify(result.warnings));
}

// CASE25: 複数不足カテゴリのうち一部だけCONFIRMED → CONFIRMEDのみ自動配分対象
function testEngineC_Case25_MixedEligibilityUnderweight() {
  const result = buildTwoCategoryScenario_(30, 30, 50, 50, 3000000, { 'A': { growthEligible: true, tsumitateEligible: true } }); // Bは未定義=UNCONFIRMED
  Logger.log('■ CASE25（A/Bとも不足、AのみCONFIRMED）:');
  Logger.log(JSON.stringify(result.categories, null, 2));
  const a = result.categories.find(function (c) { return c.category === 'A'; });
  const b = result.categories.find(function (c) { return c.category === 'B'; });
  Logger.log('検証: A.recommendedAmount=' + a.recommendedAmount + ' (期待値: >0), B.recommendedAmount=' + b.recommendedAmount + ' (期待値: 0、UNCONFIRMEDのため)');
}

// CASE26: 投資可能資金が不足額合計を下回る → priorityRank順に配分（優先度の高い方から使い切る）
function testEngineC_Case26_CashBelowTotalNeeded() {
  // A/Bとも大きく不足(30%→50%、20%→50%)、資金はごく少額(10万円)に絞る
  const result = buildTwoCategoryScenario_(30, 20, 50, 50, 100000); // extraCash=10万円 → currentCash=protectedCashMin+10万円
  Logger.log('■ CASE26（不足額合計 > 投資可能資金10万円）:');
  Logger.log(JSON.stringify(result.categories, null, 2));
  const total = result.categories.reduce(function (s, c) { return s + c.recommendedAmount; }, 0);
  Logger.log('検証: recommendedAmount合計=' + total + '（investmentCapacity=100000以下のはず）。priorityRankが高い（数値が小さい）方に優先配分されているか確認してください');
}

// CASE27: 投資可能資金が不足額合計を上回る → 不足分だけ配分し、それ以上投資しない
function testEngineC_Case27_CashAboveTotalNeeded() {
  // A/Bともわずかに不足、資金は潤沢(2000万円)
  const result = buildTwoCategoryScenario_(48, 48, 50, 50, 20000000);
  Logger.log('■ CASE27（不足額合計 < 投資可能資金2000万円）:');
  Logger.log(JSON.stringify(result, null, 2));
  const total = result.categories.reduce(function (s, c) { return s + c.recommendedAmount; }, 0);
  Logger.log('検証: recommendedAmount合計=' + total + '（不足額ちょうどで頭打ちのはず、investmentCapacity2000万円を全額使わない）。investmentRecommendation=' + result.finalDecision.investmentRecommendation + ' (期待値: PARTIAL)');
}

// ══════════════════════════════════════════════════════════
// Phase5-B: 判断履歴の保存機構（オプトイン方式）
// ══════════════════════════════════════════════════════════
// 2026-08-14 承認済み仕様に基づく実装。「判断履歴の保存」のみを扱う。
// Phase1〜4Cの既存判断ロジック（HARD RULE・priorityScore・strategy判定・confidence・
// shockMode・recommendedAmount・investmentCapacity・investmentRecommendation・
// NISA適格性判定）は一切変更していない。
//
// ══════════════════════════════════════════════════════════
// Phase5-D: 既存判断ロジック変更なし。再現性向上のためのデータ伝播のみ
// ══════════════════════════════════════════════════════════
// Phase5-Cの調査で、以下のフィールドがPhase4A/4Bでは計算済みにも関わらず
// Phase4B/4Cの返却オブジェクトへ伝播されていなかったことが判明した。
//   - currentCash / protectedCashMin（Phase4Cの finalDecision に無かった）
//   - totalValue（currentAllocation.totalValueがPhase4A/4B/4Cのいずれの出力にも無かった）
//   - marketDataQuality / missingIndicators / indicators（calcMarketScore()の詳細出力）
//   - カテゴリ側の gapNisa / priorityScore（Phase4Cのマージで欠落） / overallGapScore /
//     nisaPresenceScore（Phase4A内部のローカル変数のみで、どの返却値にも含まれていなかった）
// Phase5-Dでは、これらの計算式・判断ロジックを一切変更せず、既に算出済みの値を
// NisaStrategyEngine() → NisaStrategyEngineB() → NisaStrategyEngineC() → 判断履歴
// の経路でそのまま伝播するようにした（Phase4A/4B/4C内の該当箇所に "Phase5-D:" という
// コメントを付けている）。これにより判断履歴の再現性（Phase5-CのLEVEL3評価）が向上する。

const JUDGMENT_HISTORY_SHEET_NAME = '判断履歴';
const JUDGMENT_HISTORY_CATEGORY_SHEET_NAME = '判断履歴_カテゴリ';
const JUDGMENT_ENGINE_VERSION = 'NisaStrategyEngine-Phase5D'; // 将来ロジック変更時に更新する定数（Phase5-D: 既存判断ロジック変更なし。再現性向上のためのデータ伝播のみ）

const JUDGMENT_HISTORY_HEADERS = [
  'executionId', 'calculatedAt', 'engineVersion', 'runMode', 'status', 'blockedReason',
  'currentCash', 'protectedCashMin', 'investableCash',
  'annualNisaLimit', 'growthRemain', 'tsumitateRemain',
  'plannedContributionYear', 'plannedContributionStatus', 'plannedContributionAmount',
  'marketScore', 'marketPhase', 'marketDataQuality', 'missingIndicatorsJSON', 'indicatorsJSON',
  'shockModeActive', 'shockModeLevel',
  'totalValue',
  'strategy', 'strategyConfidence', 'strategyReasonsJSON',
  'investmentCapacity', 'recommendedInvestmentAmount', 'investmentRecommendation',
  'hybridOptionsJSON', 'warningsJSON', 'dataQuality',
];

const JUDGMENT_HISTORY_CATEGORY_HEADERS = [
  'executionId', 'category',
  'currentValue', 'currentWeight', 'targetWeight', 'gapOverall', 'gapNisa',
  'nisaWeight', 'nisaAbsent', 'nisaEligibility',
  'priorityScore', 'priorityRank', 'overallGapScore', 'nisaPresenceScore',
  'recommendedAmount', 'investmentMethod', 'proposedWeight', 'remainingGap',
  'reasonsJSON', 'warningsJSON',
];

// 「判断履歴」「判断履歴_カテゴリ」シートを新設する。既に存在する場合は何もしない
// （内容もヘッダーも変更しない）。既存Phase1〜4のシートには一切触れない。
function setupJudgmentHistorySheets() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  let sheet = ss.getSheetByName(JUDGMENT_HISTORY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(JUDGMENT_HISTORY_SHEET_NAME);
    sheet.getRange(1, 1, 1, JUDGMENT_HISTORY_HEADERS.length).setValues([JUDGMENT_HISTORY_HEADERS]);
    sheet.getRange(1, 1, 1, JUDGMENT_HISTORY_HEADERS.length).setFontWeight('bold');
    Logger.log('✅ 「' + JUDGMENT_HISTORY_SHEET_NAME + '」シートを作成しました');
  } else {
    Logger.log('ℹ️ 「' + JUDGMENT_HISTORY_SHEET_NAME + '」は既に存在するため何もしません（内容・ヘッダーは変更していません）');
  }

  let catSheet = ss.getSheetByName(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);
  if (!catSheet) {
    catSheet = ss.insertSheet(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);
    catSheet.getRange(1, 1, 1, JUDGMENT_HISTORY_CATEGORY_HEADERS.length).setValues([JUDGMENT_HISTORY_CATEGORY_HEADERS]);
    catSheet.getRange(1, 1, 1, JUDGMENT_HISTORY_CATEGORY_HEADERS.length).setFontWeight('bold');
    Logger.log('✅ 「' + JUDGMENT_HISTORY_CATEGORY_SHEET_NAME + '」シートを作成しました');
  } else {
    Logger.log('ℹ️ 「' + JUDGMENT_HISTORY_CATEGORY_SHEET_NAME + '」は既に存在するため何もしません（内容・ヘッダーは変更していません）');
  }

  SpreadsheetApp.flush();
}

// executionId生成: YYYYMMDD-HHMMSS-XXX（同一秒の衝突回避に3桁乱数を付加）
function generateExecutionId_() {
  const now = new Date();
  const datePart = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
  const rand = Math.floor(100 + Math.random() * 900);
  return datePart + '-' + rand;
}

// undefined/null/NaN/Infinityをスプレッドシートに安全な空欄に変換する。それ以外はそのまま返す。
function toSafeCell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number' && (isNaN(v) || !isFinite(v))) return '';
  return v;
}

// 配列（reasons/warnings/indicators等）をJSON文字列化する。undefined/nullは空配列として扱う。
function toSafeJsonArray_(v) {
  if (v === undefined || v === null) return '[]';
  try {
    return JSON.stringify(v);
  } catch (e) {
    return '[]';
  }
}

// 判断履歴を保存する（オプトイン、明示的に呼び出した場合のみ動作）。
// この関数は「保存するだけ」。投資判断の再計算・書き換え・priorityScore等の再計算は行わない。
// resultはNisaStrategyEngineC()の戻り値を想定。runModeは'PRODUCTION'|'TEST'必須。
// TESTでは保存しない（安全側）。成功時はexecutionIdを返す。失敗時はnullを返し、
// 呼び出し元が保持しているresult自体には一切影響を与えない。
function logJudgmentToHistory(result, runMode) {
  if (result === null || result === undefined || typeof result !== 'object') {
    Logger.log('logJudgmentToHistory: resultが不正のため保存しません');
    return null;
  }
  if (runMode !== 'PRODUCTION') {
    Logger.log('logJudgmentToHistory: runMode=' + runMode + 'のため保存しません（PRODUCTIONのみ保存対象）');
    return null;
  }
  if (typeof result.status !== 'string' || (result.status !== 'OK' && result.status !== 'BLOCKED')) {
    Logger.log('logJudgmentToHistory: result.statusが不正のため保存しません');
    return null;
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(JUDGMENT_HISTORY_SHEET_NAME);
  const catSheet = ss.getSheetByName(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);
  if (!sheet || !catSheet) {
    Logger.log('logJudgmentToHistory: 判断履歴シートが未作成です。先に setupJudgmentHistorySheets() を実行してください');
    return null;
  }

  try {
    const executionId = generateExecutionId_();
    const finalDecision = result.finalDecision || {};
    const summary = result.summary || {};
    const plannedContribution = finalDecision.plannedContribution || {};
    const shockMode = finalDecision.shockMode || {};
    const blockedReason = result.status === 'BLOCKED' ? toSafeCell_(summary.reason) : '';

    const row = [
      executionId,
      toSafeCell_(result.calculatedAt),
      JUDGMENT_ENGINE_VERSION,
      runMode,
      toSafeCell_(result.status),
      blockedReason,
      toSafeCell_(finalDecision.currentCash),
      toSafeCell_(finalDecision.protectedCashMin),
      toSafeCell_(finalDecision.investableCash),
      toSafeCell_(finalDecision.annualNisaLimit),
      toSafeCell_(finalDecision.growthRemain),
      toSafeCell_(finalDecision.tsumitateRemain),
      toSafeCell_(plannedContribution.year),
      toSafeCell_(plannedContribution.status),
      toSafeCell_(plannedContribution.totalAmount),
      toSafeCell_(finalDecision.marketScore != null ? finalDecision.marketScore : result.marketScore),
      toSafeCell_(finalDecision.marketPhase != null ? finalDecision.marketPhase : result.marketPhase),
      // Phase5-D: Phase4Cのfinal Decisionにmarket DataQuality/missingIndicators/indicators/
      // totalValue/currentCash/protectedCashMinが伝播されるようになったため、そのまま保存する
      toSafeCell_(finalDecision.marketDataQuality),
      toSafeJsonArray_(finalDecision.missingIndicators),
      toSafeJsonArray_(finalDecision.indicators),
      toSafeCell_(shockMode.active),
      toSafeCell_(shockMode.level),
      toSafeCell_(finalDecision.totalValue),
      toSafeCell_(finalDecision.strategy),
      toSafeCell_(finalDecision.strategyConfidence),
      toSafeJsonArray_(finalDecision.strategyReasons),
      toSafeCell_(finalDecision.investmentCapacity),
      toSafeCell_(finalDecision.recommendedInvestmentAmount),
      toSafeCell_(finalDecision.investmentRecommendation),
      toSafeJsonArray_(result.comparisonOptions),
      toSafeJsonArray_(result.warnings),
      toSafeCell_(result.dataQuality),
    ];
    sheet.appendRow(row);

    const categories = Array.isArray(result.categories) ? result.categories : [];
    if (categories.length > 0) {
      const catRows = categories.map(function (c) {
        const nisaAbsentValue = c.nisaAbsent != null ? c.nisaAbsent : (c.nisaHolding != null ? !c.nisaHolding : undefined);
        return [
          executionId,
          toSafeCell_(c.category),
          toSafeCell_(c.currentValue),
          toSafeCell_(c.currentWeight),
          toSafeCell_(c.targetWeight),
          toSafeCell_(c.gapOverall),
          toSafeCell_(c.gapNisa),           // Phase5-Dで伝播開始（元Phase4Aで計算済みの値）
          toSafeCell_(c.nisaWeight),
          toSafeCell_(nisaAbsentValue),
          toSafeCell_(c.nisaEligibility),
          toSafeCell_(c.priorityScore),     // 同上
          toSafeCell_(c.priorityRank),
          toSafeCell_(c.overallGapScore),   // 同上
          toSafeCell_(c.nisaPresenceScore), // 同上
          toSafeCell_(c.recommendedAmount),
          toSafeCell_(c.investmentMethod),
          toSafeCell_(c.proposedWeight),
          toSafeCell_(c.remainingGap),
          toSafeJsonArray_(c.reasons),
          toSafeJsonArray_(c.warnings),
        ];
      });
      catSheet.getRange(catSheet.getLastRow() + 1, 1, catRows.length, JUDGMENT_HISTORY_CATEGORY_HEADERS.length).setValues(catRows);
    }

    SpreadsheetApp.flush();
    Logger.log('✅ 判断履歴を保存しました: executionId=' + executionId + '（カテゴリ' + categories.length + '件）');
    return executionId;
  } catch (e) {
    Logger.log('❌ logJudgmentToHistory失敗（既存の判断結果resultには影響していません）: ' + e.message);
    return null;
  }
}

// ── テスト関数群（Phase5-B）。本番のCURRENT_CASHは一切変更しない ──

function countSheetRows_(sheetName) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  return sheet ? sheet.getLastRow() : 0;
}

function testSetupJudgmentHistorySheets() {
  setupJudgmentHistorySheets();
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  Logger.log('検証: 「判断履歴」存在=' + !!ss.getSheetByName(JUDGMENT_HISTORY_SHEET_NAME) + ', 「判断履歴_カテゴリ」存在=' + !!ss.getSheetByName(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME));
}

// CASE A: PRODUCTION + 正常結果 → 判断履歴1行＋カテゴリn行
function testLogJudgmentToHistoryProduction() {
  const cashRules = baseSufficientCashOverride_();
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules } });

  const beforeMain = countSheetRows_(JUDGMENT_HISTORY_SHEET_NAME);
  const beforeCat = countSheetRows_(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);
  const executionId = logJudgmentToHistory(result, 'PRODUCTION');
  const afterMain = countSheetRows_(JUDGMENT_HISTORY_SHEET_NAME);
  const afterCat = countSheetRows_(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);

  Logger.log('■ CASE A（PRODUCTION正常保存）: executionId=' + executionId);
  Logger.log('検証: 判断履歴 ' + beforeMain + '→' + afterMain + ' (+1のはず)、カテゴリ ' + beforeCat + '→' + afterCat + ' (+' + result.categories.length + 'のはず)');
}

// CASE B: TEST → 保存されない
function testLogJudgmentToHistoryTestMode() {
  const cashRules = baseSufficientCashOverride_();
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules } });

  const beforeMain = countSheetRows_(JUDGMENT_HISTORY_SHEET_NAME);
  const beforeCat = countSheetRows_(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);
  const executionId = logJudgmentToHistory(result, 'TEST');
  const afterMain = countSheetRows_(JUDGMENT_HISTORY_SHEET_NAME);
  const afterCat = countSheetRows_(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);

  Logger.log('■ CASE B（TESTモードは保存しない）: executionId=' + executionId + ' (期待値: null)');
  Logger.log('検証: 判断履歴 ' + beforeMain + '→' + afterMain + ' (変化なしのはず)、カテゴリ ' + beforeCat + '→' + afterCat + ' (変化なしのはず)');
}

// CASE C: BLOCKED → BLOCKEDという判断結果そのものが保存される
function testLogJudgmentToHistoryBlocked() {
  const cashRules = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin });
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules } });

  const beforeMain = countSheetRows_(JUDGMENT_HISTORY_SHEET_NAME);
  const beforeCat = countSheetRows_(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);
  const executionId = logJudgmentToHistory(result, 'PRODUCTION');
  const afterMain = countSheetRows_(JUDGMENT_HISTORY_SHEET_NAME);
  const afterCat = countSheetRows_(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);

  Logger.log('■ CASE C（BLOCKEDも保存される）: result.status=' + result.status + ', executionId=' + executionId);
  Logger.log('検証: 判断履歴 ' + beforeMain + '→' + afterMain + ' (+1のはず)、カテゴリ ' + beforeCat + '→' + afterCat + ' (変化なしのはず、categories=[])');

  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(JUDGMENT_HISTORY_SHEET_NAME);
  const lastRow = sheet.getRange(sheet.getLastRow(), 1, 1, JUDGMENT_HISTORY_HEADERS.length).getValues()[0];
  Logger.log('保存されたstatus=' + lastRow[JUDGMENT_HISTORY_HEADERS.indexOf('status')] + ', blockedReason=' + lastRow[JUDGMENT_HISTORY_HEADERS.indexOf('blockedReason')]);
}

// CASE D + F: カテゴリ数一致確認、JSON parse可能確認
function testLogJudgmentToHistoryAllCategories() {
  const cashRules = baseSufficientCashOverride_();
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules } });

  const beforeCat = countSheetRows_(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);
  logJudgmentToHistory(result, 'PRODUCTION');
  const afterCat = countSheetRows_(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);

  Logger.log('■ CASE D（カテゴリ数一致確認）: result.categories.length=' + result.categories.length + ', 追加行数=' + (afterCat - beforeCat));

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(JUDGMENT_HISTORY_SHEET_NAME);
  const row = sheet.getRange(sheet.getLastRow(), 1, 1, JUDGMENT_HISTORY_HEADERS.length).getValues()[0];
  const strategyReasonsJSON = row[JUDGMENT_HISTORY_HEADERS.indexOf('strategyReasonsJSON')];
  try {
    const parsed = JSON.parse(strategyReasonsJSON);
    Logger.log('■ CASE F: strategyReasonsJSON parse成功、件数=' + parsed.length);
  } catch (e) {
    Logger.log('■ CASE F 失敗: ' + e.message);
  }

  const catSheet = ss.getSheetByName(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);
  const catRow = catSheet.getRange(catSheet.getLastRow(), 1, 1, JUDGMENT_HISTORY_CATEGORY_HEADERS.length).getValues()[0];
  const reasonsJSON = catRow[JUDGMENT_HISTORY_CATEGORY_HEADERS.indexOf('reasonsJSON')];
  try {
    const parsedReasons = JSON.parse(reasonsJSON);
    Logger.log('カテゴリ側reasonsJSON parse成功、件数=' + parsedReasons.length);
  } catch (e) {
    Logger.log('カテゴリ側reasonsJSON parse失敗: ' + e.message);
  }
}

// CASE E: 同一日に2回実行 → 2つのexecutionId、上書きされない
function testLogJudgmentToHistorySameDayTwice() {
  const cashRules = baseSufficientCashOverride_();
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules } });

  const before = countSheetRows_(JUDGMENT_HISTORY_SHEET_NAME);
  const id1 = logJudgmentToHistory(result, 'PRODUCTION');
  const id2 = logJudgmentToHistory(result, 'PRODUCTION');
  const after = countSheetRows_(JUDGMENT_HISTORY_SHEET_NAME);

  Logger.log('■ CASE E（同一日2回実行）: executionId1=' + id1 + ', executionId2=' + id2);
  Logger.log('検証: executionIdが異なる=' + (id1 !== id2) + '、行数 ' + before + '→' + after + ' (+2のはず、上書きされない)');
}

// CASE G: null / undefined / 不正result → 保存しない
function testLogJudgmentToHistoryInvalidResult() {
  const before = countSheetRows_(JUDGMENT_HISTORY_SHEET_NAME);
  const r1 = logJudgmentToHistory(null, 'PRODUCTION');
  const r2 = logJudgmentToHistory(undefined, 'PRODUCTION');
  const r3 = logJudgmentToHistory({}, 'PRODUCTION'); // statusフィールドなし
  const after = countSheetRows_(JUDGMENT_HISTORY_SHEET_NAME);

  Logger.log('■ CASE G（不正resultは保存しない）: r1(null)=' + r1 + ', r2(undefined)=' + r2 + ', r3({})=' + r3 + '（全てnullのはず）');
  Logger.log('検証: 判断履歴行数 ' + before + '→' + after + ' (変化なしのはず)');
}

// ── Phase5-D 動作確認用テスト ──

// TEST 1: Phase4Cの出力に新しく伝播されたフィールドが存在するか確認
function testPhase5D_NewFieldsPresent() {
  const cashRules = baseSufficientCashOverride_();
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules } });

  Logger.log('■ TEST 1（Phase4C finalDecisionの新規フィールド）:');
  Logger.log('currentCash=' + result.finalDecision.currentCash + ', protectedCashMin=' + result.finalDecision.protectedCashMin + ', totalValue=' + result.finalDecision.totalValue);
  Logger.log('marketDataQuality=' + result.finalDecision.marketDataQuality + ', missingIndicators=' + JSON.stringify(result.finalDecision.missingIndicators) + ', indicators件数=' + (result.finalDecision.indicators ? result.finalDecision.indicators.length : 'undefined'));

  const cat = result.categories[0];
  Logger.log('■ TEST 1（カテゴリ側の新規フィールド、先頭カテゴリ=' + cat.category + '）:');
  Logger.log('gapNisa=' + cat.gapNisa + ', priorityScore=' + cat.priorityScore + ', overallGapScore=' + cat.overallGapScore + ', nisaPresenceScore=' + cat.nisaPresenceScore);
}

// TEST 2: Phase5-Bへの保存で新規フィールドが空欄にならず、JSONもparse可能か確認
function testPhase5D_SavedFieldsNotBlank() {
  const cashRules = baseSufficientCashOverride_();
  const result = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRules }, engineBOverrides: { cashRules: cashRules } });
  const executionId = logJudgmentToHistory(result, 'PRODUCTION');

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(JUDGMENT_HISTORY_SHEET_NAME);
  const row = sheet.getRange(sheet.getLastRow(), 1, 1, JUDGMENT_HISTORY_HEADERS.length).getValues()[0];
  const idx = name => JUDGMENT_HISTORY_HEADERS.indexOf(name);

  Logger.log('■ TEST 2（判断履歴に保存された新規フィールド、executionId=' + executionId + '）:');
  Logger.log('currentCash=' + row[idx('currentCash')] + ', protectedCashMin=' + row[idx('protectedCashMin')] + ', totalValue=' + row[idx('totalValue')]);
  Logger.log('marketDataQuality=' + row[idx('marketDataQuality')]);
  try {
    const missing = JSON.parse(row[idx('missingIndicatorsJSON')]);
    const indicators = JSON.parse(row[idx('indicatorsJSON')]);
    Logger.log('missingIndicatorsJSON parse成功: ' + JSON.stringify(missing) + ', indicatorsJSON parse成功: 件数=' + indicators.length);
  } catch (e) {
    Logger.log('JSON parse失敗: ' + e.message);
  }

  const catSheet = ss.getSheetByName(JUDGMENT_HISTORY_CATEGORY_SHEET_NAME);
  const catLastRow = catSheet.getLastRow();
  const catHeaderRow = JUDGMENT_HISTORY_CATEGORY_HEADERS;
  const catRows = catSheet.getRange(catLastRow - result.categories.length + 1, 1, result.categories.length, catHeaderRow.length).getValues();
  const gapNisaIdx = catHeaderRow.indexOf('gapNisa');
  const priorityScoreIdx = catHeaderRow.indexOf('priorityScore');
  const overallGapScoreIdx = catHeaderRow.indexOf('overallGapScore');
  const nisaPresenceScoreIdx = catHeaderRow.indexOf('nisaPresenceScore');
  Logger.log('■ TEST 2（判断履歴_カテゴリに保存された新規フィールド、先頭行）:');
  Logger.log('gapNisa=' + catRows[0][gapNisaIdx] + ', priorityScore=' + catRows[0][priorityScoreIdx] + ', overallGapScore=' + catRows[0][overallGapScoreIdx] + ', nisaPresenceScore=' + catRows[0][nisaPresenceScoreIdx]);
}

// TEST 3: HARD RULEが従来どおり機能するか確認（currentCash=protectedCashMin / currentCash<protectedCashMin）
function testPhase5D_HardRuleUnchanged() {
  const cashRulesEqual = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin });
  const resultEqual = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRulesEqual } });
  Logger.log('■ TEST 3-a（currentCash=protectedCashMin）: status=' + resultEqual.status + ' (期待値: BLOCKED)');

  const cashRulesBelow = Object.assign({}, getCashRules(), { currentCash: getCashRules().protectedCashMin - 500000 });
  const resultBelow = NisaStrategyEngineC({ engineAOverrides: { cashRules: cashRulesBelow } });
  Logger.log('■ TEST 3-b（currentCash<protectedCashMin）: status=' + resultBelow.status + ' (期待値: BLOCKED)');
}
