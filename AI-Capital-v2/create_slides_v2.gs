// ══════════════════════════════════════════════════════════
//  AI Capital v2 システム概要スライド自動生成
//  使い方: GASエディタで createV2Presentation() を実行
// ══════════════════════════════════════════════════════════

function createV2Presentation() {
  var prs = SlidesApp.create('RYO.AI // AI Capital v2 システム概要');

  // ── ヘルパー ──────────────────────────────────────────────
  // 設計座標は 960×540。スライド実寸 720×405pt に合わせて 0.75 倍変換。
  var S = 0.75;
  function addSlide() {
    return prs.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  }
  function box(slide, text, x, y, w, h, size, color, bold) {
    var tb = slide.insertTextBox(text, x*S, y*S, w*S, h*S);
    var st = tb.getText().getTextStyle();
    st.setFontSize(Math.round((size || 16) * 0.8)).setBold(bold || false).setForegroundColor(color || '#FFFFFF');
    tb.getText().getParagraphStyle().setLineSpacing(150);
    return tb;
  }
  function bg(slide, hex) {
    slide.getBackground().setSolidFill(hex);
  }
  function rect(slide, x, y, w, h, hex) {
    var r = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, x*S, y*S, w*S, h*S);
    r.getFill().setSolidFill(hex);
    r.getBorder().setTransparent();
    return r;
  }
  function line(slide, x, y, w) {
    rect(slide, x, y, w, 4, CYAN);
  }

  var BG     = '#0F1428';
  var CYAN   = '#00D4FF';
  var WHITE  = '#FFFFFF';
  var GRAY   = '#AAAAAA';
  var GREEN  = '#00FF88';
  var YELLOW = '#FFD700';
  var RED    = '#FF6655';
  var PURPLE = '#C084FC';

  // ══════════════════════════════════════════════════════════
  // スライド 1: タイトル
  // ══════════════════════════════════════════════════════════
  var s1 = prs.getSlides()[0];
  bg(s1, BG);
  rect(s1, 0, 0, 10, 540, CYAN);
  box(s1, 'RYO.AI // AI Capital v2',               60, 80,  840, 90,  48, CYAN,  true);
  box(s1, 'AI社員4部署による市場会議・投資判断記録プロジェクト',  60, 185, 840, 45,  20, WHITE, false);
  box(s1, '毎日の議論と意思決定をそのまま公開する、透明な投資観測記録', 60, 240, 840, 36, 14, GRAY,  false);
  line(s1, 60, 295, 840);
  box(s1, '正式運用開始: 2026-06-26', 60, 320, 400, 36, 15, GREEN, true);
  box(s1, '初期資産: ¥10,000,000（全額現金）', 60, 360, 500, 36, 15, GREEN, true);
  box(s1, '記事公開: note.com / X（毎営業日）', 60, 400, 500, 36, 15, YELLOW, false);

  // ══════════════════════════════════════════════════════════
  // スライド 2: v1 → v2 何が変わったか
  // ══════════════════════════════════════════════════════════
  var s2 = addSlide();
  bg(s2, BG);
  line(s2, 0, 0, 960);
  box(s2, 'v1 → v2 何が変わったか', 40, 20, 880, 55, 28, CYAN, true);

  box(s2, 'v1（ai-corp）', 40, 90, 400, 36, 18, RED, true);
  box(s2, [
    '・Discord チャンネルへ投稿',
    '・Python Rule Engine（HARD/SOFT）',
    '・SQLite ローカルDB',
    '・ローカルのみで閉じた運用',
    '・仮想ファンド（内部管理）',
  ].join('\n'), 40, 130, 420, 200, 15, WHITE, false);

  box(s2, 'v2（AI-Capital-v2）', 500, 90, 400, 36, 18, GREEN, true);
  box(s2, [
    '・note.com に毎日記事を公開',
    '・X（Twitter）で予告投稿',
    '・Google スプレッドシート（13シート）',
    '・AI社員キャラクター 5名に明確化',
    '・読者に意思決定プロセスを公開',
  ].join('\n'), 500, 130, 420, 200, 15, WHITE, false);

  line(s2, 40, 350, 880);
  box(s2, '最大の変化: 「内部ツール」→「公開プロジェクト」', 40, 370, 880, 40, 17, YELLOW, true);
  box(s2, 'AIと人間の共同観測を毎日公開。自動売買なし・管理者が最終判断。', 40, 415, 880, 36, 14, GRAY, false);

  // ══════════════════════════════════════════════════════════
  // スライド 3: AI社員紹介
  // ══════════════════════════════════════════════════════════
  var s3 = addSlide();
  bg(s3, BG);
  line(s3, 0, 0, 960);
  box(s3, 'AI社員 — 5名', 40, 20, 880, 55, 28, CYAN, true);

  var members = [
    ['📈', '神谷 シン',   'マーケット分析部',   'Fear & Greed・VIX・各指数を分析\nATH乖離率から逆張り候補を選定'],
    ['🛡️', '黒崎 ミサキ', 'リスク管理部',       'VIX・ドル円・ポジションリスクを監視\n損失限定条件を提示'],
    ['💼', '橘 アオイ',   'ポートフォリオ管理部', '現金比率・分散度・買付金額を提案\n予算配分ルールに基づき具体額を算出'],
    ['🔍', '鬼塚 ガイ',   '審査部',             '他3部署の判断を審査・批評\n分散不足・バイアスを指摘'],
    ['👑', '相沢 レイ',   '秘書室長',           '会議全体をまとめ最終補足コメント\n記事の「秘書室長所見」担当'],
  ];

  members.forEach(function(m, i) {
    var y = 90 + i * 87;
    box(s3, m[0] + ' ' + m[1], 40, y, 220, 36, 17, CYAN, true);
    box(s3, m[2], 265, y, 220, 36, 14, YELLOW, false);
    box(s3, m[3], 490, y, 440, 60, 13, WHITE, false);
  });

  // ══════════════════════════════════════════════════════════
  // スライド 4: 毎日のスケジュール
  // ══════════════════════════════════════════════════════════
  var s4 = addSlide();
  bg(s4, BG);
  line(s4, 0, 0, 960);
  box(s4, '毎日のスケジュール（平日自動実行）', 40, 20, 880, 55, 28, CYAN, true);

  var steps = [
    ['11:30', YELLOW, 'NAV取得',      'Yahoo Japan から8銘柄の基準価格を取得 → nav_prices シートへ書き込み'],
    ['12:00', GREEN,  'データ取得',   'Fear & Greed / VIX / NASDAQ100 / USD/JPY → market_data シートへ'],
    ['12:00', GREEN,  '各部署分析',   '4部署が並列で市場分析・投票（market / portfolio / risk → 並列、audit → 逐次）'],
    ['12:00', GREEN,  'シグナル集約', '機械判定のみ（LLM不使用）。加重スコア + 銘柄 combined scoring → final_decisions'],
    ['12:00', GREEN,  '発注記録',     'BUY / ACCUMULATE 時のみ orders シートへ記録。portfolio_status を自動更新'],
    ['12:00', CYAN,   '記事生成・公開', 'LLM が note 記事を生成 → note.com へ自動下書き保存 → X 投稿文も生成'],
  ];

  steps.forEach(function(s, i) {
    var y = 95 + i * 72;
    box(s4, s[0], 40, y + 2, 80, 26, 13, s[1], true);
    box(s4, s[2], 135, y, 160, 36, 15, s[1], true);
    box(s4, s[3], 305, y, 620, 55, 13, WHITE, false);
    if (i < steps.length - 1) line(s4, 40, y + 65, 880);
  });

  // ══════════════════════════════════════════════════════════
  // スライド 5: パイプライン（技術）
  // ══════════════════════════════════════════════════════════
  var s5 = addSlide();
  bg(s5, BG);
  line(s5, 0, 0, 960);
  box(s5, '処理パイプライン（5ステップ）', 40, 20, 880, 55, 28, CYAN, true);
  box(s5, [
    'Step 1  lib/dataFetcher.js',
    '        market_data / nav_prices / candidate_assets をスプレッドシートへ書き込み',
    '',
    'Step 2a agents/market.js  agents/portfolio.js  agents/risk.js    （並列）',
    '        各部署が市場分析し agent_votes + agent_recommendations へ投票',
    '',
    'Step 2b agents/audit.js                                          （逐次）',
    '        他3部署の投票を読み、審査・投票',
    '',
    'Step 3  lib/signalAggregator.js',
    '        加重スコア集計 → combined scoring で銘柄選択 → final_decisions へ書き込み',
    '',
    'Step 4  lib/orderManager.js',
    '        BUY/ACCUMULATE 時のみ orders シートへ記録 / portfolio_status 自動更新',
    '',
    'Step 5  agents/publisher.js',
    '        LLM で note 記事生成 → note.com 下書き保存 → X 投稿文生成',
  ].join('\n'), 40, 90, 880, 400, 13, WHITE, false);

  // ══════════════════════════════════════════════════════════
  // スライド 6: 意思決定ロジック
  // ══════════════════════════════════════════════════════════
  var s6 = addSlide();
  bg(s6, BG);
  line(s6, 0, 0, 960);
  box(s6, '意思決定ロジック（機械判定）', 40, 20, 880, 55, 28, CYAN, true);

  box(s6, 'シグナル判定（加重スコア）', 40, 90, 880, 36, 18, YELLOW, true);
  box(s6, [
    'score = Σ(signal_weight × confidence / 100) / Σ(confidence / 100)',
    '',
    'BUY=+2  /  ACCUMULATE=+1  /  WAIT=0  /  DEFEND=−1  /  SELL=−2',
    '',
    'score ≥ 1.5 → BUY   /   ≥ 0.5 → ACCUMULATE   /   ≥ −0.3 → WAIT',
    'score ≥ −1.0 → DEFEND   /   < −1.0 → SELL',
  ].join('\n'), 40, 132, 880, 160, 14, WHITE, false);

  line(s6, 40, 305, 880);
  box(s6, '銘柄選択（combined scoring）', 40, 320, 880, 36, 18, YELLOW, true);
  box(s6, [
    'combined = candidateScore × 0.5  +  deptScore × 0.5',
    '',
    'candidateScore: ATH 乖離率・前日比・5日/20日騰落率・リバウンド率をスコア化',
    '                rank1 が最も逆張り候補として有力',
    '',
    'deptScore:      各部署の推薦銘柄が一致した割合',
    '                複数部署が同じ銘柄を推薦 → deptScore が上がる',
    '',
    '金額:            勝利銘柄を推薦した部署の提案額の平均値（推薦なし → 現金×3%）',
  ].join('\n'), 40, 362, 880, 150, 13, WHITE, false);

  // ══════════════════════════════════════════════════════════
  // スライド 7: データ基盤（13シート）
  // ══════════════════════════════════════════════════════════
  var s7 = addSlide();
  bg(s7, BG);
  line(s7, 0, 0, 960);
  box(s7, 'データ基盤 — Google スプレッドシート（13シート）', 40, 20, 880, 55, 28, CYAN, true);

  var sheets_list = [
    ['価格データ',     'nav_prices / asset_master', 'Yahoo Japan から日次取得。8銘柄の基準価格を蓄積。'],
    ['市場データ',     'market_data / market_snapshot / candidate_assets', 'FG・VIX・NASDAQ 等の日次スナップショット。'],
    ['部署記録',       'agent_votes / agent_recommendations', '各部署の投票・推薦銘柄・金額・理由を記録。'],
    ['意思決定記録',   'final_decisions / article_decisions', 'シグナル集約結果。記事生成時のスナップショット。'],
    ['ファンド管理',   'portfolio_status / orders / positions', '現金残高・注文・保有ポジションをリアルタイム管理。'],
    ['部署評価',       'department_recommendations', '将来実績追跡用（result_7d / 30d / 90d）。'],
  ];

  sheets_list.forEach(function(sh, i) {
    var y = 90 + i * 73;
    box(s7, sh[0], 40,  y, 140, 30, 14, YELLOW, true);
    box(s7, sh[1], 190, y, 340, 30, 13, CYAN,   false);
    box(s7, sh[2], 540, y, 380, 55, 13, WHITE,  false);
    if (i < sheets_list.length - 1) line(s7, 40, y + 62, 880);
  });

  // ══════════════════════════════════════════════════════════
  // スライド 8: 公開フロー（メディア）
  // ══════════════════════════════════════════════════════════
  var s8 = addSlide();
  bg(s8, BG);
  line(s8, 0, 0, 960);
  box(s8, '公開フロー — note.com + X（毎営業日）', 40, 20, 880, 55, 28, CYAN, true);

  box(s8, '📝 note.com 記事（本編）', 40, 90, 880, 36, 20, GREEN, true);
  box(s8, [
    '・📊 AI Capital Market Check（機械生成: F&G / VIX / 市場環境 / 為替）',
    '・🎯 本日の判断（シグナル / 銘柄 / 金額）',
    '・🌍 今日の市場 / 🎯 本日の買付候補（3銘柄）',
    '・🏢 各部署の判断（全4部署 + 推奨銘柄・金額）',
    '・⚖️ 最終判断ブロック（🟢🎯💴🤖 機械生成）',
    '・💰 ポートフォリオ状況（資産・現金・注文中・保有）',
    '・👀 次回の注目点（現在値ベース・未達条件のみ 機械生成）',
    '・👑 秘書室長所見（相沢レイ）',
  ].join('\n'), 40, 132, 880, 200, 13, WHITE, false);

  line(s8, 40, 340, 880);
  box(s8, '🐦 X（旧Twitter）投稿（予告編）', 40, 355, 880, 36, 20, CYAN, true);
  box(s8, [
    '・記事の要約は書かない。「会議を覗き見したくなる予告」として設計',
    '・今日一番議論になったテーマを2項対立で表現',
    '・最も対立した2部署の意見を抜粋（結論は書かない）',
    '・「続きを知りたい」と思わせる疑問形で締め → note URL を誘導',
  ].join('\n'), 40, 397, 880, 110, 13, WHITE, false);

  // ══════════════════════════════════════════════════════════
  // スライド 9: 運用コスト
  // ══════════════════════════════════════════════════════════
  var s9 = addSlide();
  bg(s9, BG);
  line(s9, 0, 0, 960);
  box(s9, '運用コスト', 40, 20, 880, 55, 28, CYAN, true);

  box(s9, [
    '✅  Ollama（ローカル LLM: gemma4:e4b）     無料',
    '✅  Google Apps Script / Spreadsheet      無料',
    '✅  note.com                               無料',
    '✅  X（旧 Twitter）                        無料',
    '✅  Node.js / npm パッケージ              無料',
    '✅  PM2（プロセス管理）                    無料',
  ].join('\n'), 40, 100, 880, 220, 19, WHITE, false);

  line(s9, 40, 330, 880);
  box(s9, '⚡ 全てローカル実行。外部 AI API は一切使用しない。', 40, 348, 880, 40, 16, GREEN, true);
  box(s9, 'Claude Code（開発補助）のみ有料。運用コストは PC 電気代のみ。', 40, 392, 880, 36, 14, GRAY, false);

  // ══════════════════════════════════════════════════════════
  // スライド 10: 現在の状況・今後
  // ══════════════════════════════════════════════════════════
  var s10 = addSlide();
  bg(s10, BG);
  line(s10, 0, 0, 960);
  box(s10, '現在の状況と今後', 40, 20, 880, 55, 28, CYAN, true);

  box(s10, '✅ 稼働中（2026-06-26〜）', 40, 90, 880, 36, 18, GREEN, true);
  box(s10, [
    '  ・毎日 12:00 に全パイプライン自動実行（PM2: ai-v2-secretary）',
    '  ・初回発注: SOX ¥325,000（2026-06-26、F&G=25 極端な恐怖局面）',
    '  ・記事 AC-2026-0001〜 を連番公開中',
  ].join('\n'), 40, 130, 880, 90, 14, WHITE, false);

  line(s10, 40, 230, 880);
  box(s10, '📋 今後の展望', 40, 245, 880, 36, 18, YELLOW, true);
  box(s10, [
    '  ・部署別実績トラッキング（result_7d / 30d / 90d 蓄積後に精度評価）',
    '  ・銘柄 combined scoring のチューニング（実績に基づく重み調整）',
    '  ・iPhone PWA 化（投資ダッシュボードとの統合）',
    '  ・有料記事化・マガジン化（読者が判断根拠を深く読める構成）',
  ].join('\n'), 40, 285, 880, 120, 14, WHITE, false);

  line(s10, 40, 415, 880);
  box(s10, '「AI社員が毎日議論して、人間が最終判断する」という構造を保ちながら', 40, 432, 880, 36, 14, GRAY, false);
  box(s10, '透明性・継続性・読者との対話を積み重ねていく。', 40, 468, 880, 36, 14, GRAY, false);

  // ── 完了 ──────────────────────────────────────────────────
  var url = prs.getUrl();
  Logger.log('✅ スライド作成完了 (10枚): ' + url);
  return url;
}
