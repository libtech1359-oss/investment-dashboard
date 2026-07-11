/**
 * AI Capital Database — シート初期セットアップ
 * Google スプレッドシートの Apps Script エディタで実行すること。
 *
 * 実行方法:
 *   1. スプレッドシートを開く
 *   2. 「拡張機能」→「Apps Script」
 *   3. このコードを貼り付けて保存
 *   4. setupSheets()    を実行（シート作成）
 *   5. setupAssetMaster() を実行（標準9銘柄を投入）
 *
 * 銘柄追加: asset_master シートに1行追加するだけ。コード修正不要。
 * 銘柄停止: enabled 列を FALSE に変更（行削除不要）。
 */

var SHEET_DEFS = [
  {
    name: 'market_data',
    headers: ['date', 'fear_greed', 'vix', 'sp500', 'nasdaq100', 'sox', 'gold', 'usdjpy'],
    color: '#E8F5E9',
  },
  {
    //
    // asset_master — 全候補資産のマスターテーブル
    //
    // id           : 識別子（英数字 + _ のみ。例: nasdaq100, fang, ztech20）
    // short_name   : 記事本文・エージェント表示用（例: NASDAQ100、FANG+、オルカン）
    // full_name    : 正式名称（例: ニッセイNASDAQ100インデックスファンド）
    // proxy_symbol : Yahoo Finance ティッカー（日本の投資信託は対応する指数/ETFを使用）
    //                空白: 価格データ取得不可として proxy_ok=FALSE・スコア=0（中立）で記録
    //                → 他資産と同一シンボルにしない（異なる資産のデータを流用しない原則）
    // category     : core / growth / defense / theme
    // enabled      : TRUE のみシステムが処理対象とする
    //
    name: 'asset_master',
    headers: ['id', 'short_name', 'full_name', 'proxy_symbol', 'category', 'enabled'],
    color: '#E8EAF6',
  },
  {
    //
    // candidate_assets — asset_master × Yahoo Finance の日次スコアリング結果
    //
    // asset_id     : asset_master.id と対応
    // asset_name   : short_name（記事表示用）
    // full_name    : 正式名称（詳細表示・記事注記用）
    // ath_gap_pct  : 52週高値からの乖離率(%) / 'N/A' = proxy_ok=FALSE
    // daily_change_pct: 前日比(%) / 'N/A' = proxy_ok=FALSE
    // score        : 逆張り優先スコア（高いほど買付優先）/ 0 = データなし or ATH近傍
    // rank         : スコア降順ランク
    // proxy_ok     : TRUE=価格データ取得成功 / FALSE=取得不可
    //
    name: 'candidate_assets',
    headers: ['date', 'asset_id', 'asset_name', 'full_name', 'category', 'ath_gap_pct', 'daily_change_pct', 'score', 'rank', 'proxy_ok'],
    color: '#E3F2FD',
  },
  {
    // portfolio_status は dataFetcher.updatePortfolioStatus() が orders から自動計算する。
    // 手動更新不要。
    name: 'portfolio_status',
    headers: ['date', 'total_assets', 'cash', 'invested', 'unrealized_pl', 'cash_ratio'],
    color: '#FFF9C4',
  },
  {
    // orders — 注文記録（手動 or orderManager が記録）
    // status: pending / ordered / filled / cancelled / sold
    name: 'orders',
    headers: ['order_id', 'date', 'asset_name', 'amount', 'status'],
    color: '#FCE4EC',
  },
  {
    // positions は dataFetcher.updatePortfolioStatus() が filled orders から自動再構築する。
    // 手動更新不要。
    name: 'positions',
    headers: ['asset_name', 'quantity', 'cost_basis', 'market_value', 'unrealized_pl', 'ath_gap_pct', 'daily_change_pct', 'category'],
    color: '#F3E5F5',
  },
  {
    name: 'agent_votes',
    headers: ['date', 'department', 'signal', 'confidence', 'comment'],
    color: '#E0F7FA',
  },
  {
    name: 'final_decisions',
    headers: ['date', 'final_signal', 'target_asset', 'amount', 'reason'],
    color: '#FFF3E0',
  },
];

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var results = [];

  for (var i = 0; i < SHEET_DEFS.length; i++) {
    var def = SHEET_DEFS[i];
    var sheet = ss.getSheetByName(def.name);

    if (!sheet) {
      sheet = ss.insertSheet(def.name);
      results.push('✅ 作成: ' + def.name);
    } else {
      results.push('🔄 既存: ' + def.name + '（ヘッダーを上書き）');
    }

    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);

    var headerRange = sheet.getRange(1, 1, 1, def.headers.length);
    headerRange.setBackground(def.color);
    headerRange.setFontWeight('bold');
    headerRange.setFontSize(11);
    headerRange.setBorder(true, true, true, true, true, true);

    sheet.autoResizeColumns(1, def.headers.length);
    sheet.setFrozenRows(1);
  }

  var defaultSheet = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() === 0) {
    ss.deleteSheet(defaultSheet);
    results.push('🗑️ デフォルトシート削除');
  }

  var msg = '=== セットアップ完了 ===\n' + results.join('\n') +
    '\n\n次に setupAssetMaster() を実行して標準9銘柄を投入してください。';
  Logger.log(msg);
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * asset_master シートに標準9銘柄を投入する。
 *
 * 列: id | short_name | full_name | proxy_symbol | category | enabled
 *
 * proxy_symbol は Yahoo Finance ティッカー。日本の投資信託は対応する
 * インデックス/ETFを代理として使用する（異なる資産が同一シンボルを
 * 共有することを避けること → 分析の独立性を保つ）。
 *
 * proxy_symbol が空白の場合、システムは価格データ取得不可として
 * proxy_ok=FALSE・スコア=0（中立）で記録する。
 *
 * ── proxy_symbol 参考値 ──
 *   ^NDX    : NASDAQ100 指数（ニッセイNASDAQ100 等の代理）
 *   ^GSPC   : S&P500 指数（eMAXIS Slim 米国株式 等の代理）
 *   ^N225   : 日経平均（日経平均連動ファンドの代理）
 *   ^NYFANG : NYSE FANG+ 指数（iFreeNEXT FANG+ の代理）
 *   SOX     : Philadelphia Semiconductor Index（SOX連動ファンドの代理）
 *   ACWI    : iShares MSCI ACWI ETF（オルカンの代理）
 *   GC=F    : Gold Futures（ゴールドファンドの代理）
 *   ARKX    : ARK Space Exploration ETF（宇宙開発テーマの代理）
 *   (空白)  : 取得不可 → proxy_ok=FALSE で記録（Zテック20 等）
 */
function setupAssetMaster() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('asset_master');
  if (!sheet) {
    SpreadsheetApp.getUi().alert(
      'asset_master シートが見つかりません。先に setupSheets() を実行してください。'
    );
    return;
  }

  if (sheet.getLastRow() > 1) {
    var ui       = SpreadsheetApp.getUi();
    var response = ui.alert(
      '資産マスター初期化',
      '既存データがあります。追記しますか？（既存行は変更されません）\n（キャンセルで中止）',
      ui.ButtonSet.OK_CANCEL
    );
    if (response !== ui.Button.OK) return;
  }

  // 列順: id | short_name | full_name | proxy_symbol | category | enabled
  var initialData = [
    // ── コア資産 ──────────────────────────────────────────────
    ['allcountry', 'オルカン',   'eMAXIS Slim 全世界株式（オール・カントリー）', 'ACWI',    'core',    'TRUE'],
    ['sp500',      'S&P500',    'eMAXIS Slim 米国株式（S&P500）',              '^GSPC',   'core',    'TRUE'],
    ['nasdaq100',  'NASDAQ100', 'ニッセイNASDAQ100インデックスファンド',         '^NDX',    'core',    'TRUE'],
    ['nikkei225',  '日経平均',   'eMAXIS Slim 国内株式（日経平均）',             '^N225',   'core',    'TRUE'],
    // ── 成長資産 ──────────────────────────────────────────────
    ['fang',       'FANG+',    'iFreeNEXT FANG+インデックス',                  '^NYFANG', 'growth',  'TRUE'],
    ['sox',        'SOX',      'SOX指数連動ファンド',                           'SOX',     'growth',  'TRUE'],
    // ── テーマ資産 ────────────────────────────────────────────
    ['space',      '宇宙開発',   'eMAXIS Neo 宇宙開発',                          'ARKX',    'theme',   'TRUE'],
    // proxy_symbol なし: Yahoo Finance 非対応 → proxy_ok=FALSE・スコア=0（中立）
    // NASDAQ100 と同一シンボルにしない（データ共有は分析上問題があるため）
    ['ztech20',    'Zテック20',  'Zテック20',                                    '',        'theme',   'TRUE'],
    // ── 守備資産 ──────────────────────────────────────────────
    ['gold',       'ゴールド',   'SBI・iシェアーズ・ゴールドファンド',            'GC=F',   'defense', 'TRUE'],
  ];

  for (var i = 0; i < initialData.length; i++) {
    sheet.appendRow(initialData[i]);
  }

  var msg =
    '✅ asset_master に ' + initialData.length + ' 銘柄を追加しました。\n\n' +
    '【銘柄一覧】\n' +
    'コア: オルカン / S&P500 / NASDAQ100 / 日経平均\n' +
    '成長: FANG+ / SOX\n' +
    'テーマ: 宇宙開発 / Zテック20（proxy_ok=FALSE 価格データなし）\n' +
    '守備: ゴールド\n\n' +
    '【銘柄追加方法】\n' +
    'このシートに1行追加するだけでシステムが自動対応します。\n' +
    'proxy_symbol は Yahoo Finance ティッカーを設定してください。\n' +
    '取得不可の銘柄は proxy_symbol を空欄にしてください。\n\n' +
    '【銘柄停止方法】\n' +
    'enabled 列を FALSE に変更します（行削除不要）。\n\n' +
    '【Zテック20について】\n' +
    'Yahoo Finance 非対応のため proxy_symbol が空欄です。\n' +
    'proxy_ok=FALSE・スコア=0（中立ランク）で記録されます。\n' +
    'NASDAQ100 と同一シンボルにはしません（データの独立性を維持）。';

  Logger.log(msg);
  SpreadsheetApp.getUi().alert(msg);
}
