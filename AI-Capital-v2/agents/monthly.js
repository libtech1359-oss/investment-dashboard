'use strict';

/**
 * monthly.js — 月刊レポートエージェント（土台のみ）
 *
 * 現時点の実装範囲:
 *   - monthId / buildMonthlyMeta / buildMonthlyDraft のインターフェース定義
 *   - 全セクションはテンプレートスタブ（TODO コメント付き）
 *
 * 未実装（将来: 十分なデータ蓄積後に追加）:
 *   - データ収集・集計（gatherMonthlyData）
 *   - AI社員コメント生成（LLM）
 *   - 月次分析・総括生成（LLM）
 *   - CEOコメント自動生成（LLM）
 *   - 月次ランキング・部署別勝率
 *   - 資産推移グラフ
 *   - note.com 下書き保存
 *   - publisher.js 連携
 *   - Scheduler 登録・自動実行
 *   - monthly_articles シートへの upsert 保存
 *
 * 手動確認: node _run_monthly.js YYYY-MM-DD YYYY-MM-DD
 */

// ── Month ID ──────────────────────────────────────────────────

/**
 * 月IDを生成する
 * 例: '2026-06-26' → '2026-06'
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} 'YYYY-MM'
 */
function monthId(dateStr) {
  return dateStr.slice(0, 7);
}

// ── メタデータ ────────────────────────────────────────────────

/**
 * 月刊記事の管理メタデータを返す
 * status: 'draft' | 'reviewed' | 'published'（現時点では draft のみ使用）
 * schema_version: 将来のスキーマ変更に備えたバージョン管理
 * @param {string} startDate - YYYY-MM-DD（月初）
 * @param {string} endDate   - YYYY-MM-DD（月末）
 * @returns {object}
 */
function buildMonthlyMeta(startDate, endDate) {
  return {
    month_id:       monthId(startDate),
    start_date:     startDate,
    end_date:       endDate,
    status:         'draft',
    generated_at:   null,  // 将来: 生成完了時に ISO 8601 タイムスタンプを設定
    published_at:   null,  // 将来: note.com 公開後に設定
    schema_version: '1.0',
  };
}

// ── セクションスタブ ──────────────────────────────────────────
// TODO: 各セクションに実データ取得・LLM生成を追加

function buildSection1(_data) {
  // TODO: market_data・market_snapshot から月次市場環境を集計
  // TODO: LLM で総括コメントを生成
  return [
    `## 1. 今月の市場総括`,
    '',
    `（将来実装: Fear & Greed / VIX / NASDAQ100 の月次推移と総括コメント）`,
  ].join('\n');
}

function buildSection2(_data) {
  // TODO: portfolio_status・orders から月次損益・勝率を計算
  return [
    `## 2. AI Capital 運用成績`,
    '',
    `（将来実装: 月間損益 / 勝率 / 最大ドローダウン / シャープレシオ等）`,
  ].join('\n');
}

function buildSection3(_data) {
  // TODO: nav_prices から月次資産推移を計算・グラフ化
  return [
    `## 3. 資産推移`,
    '',
    `（将来実装: 月次NAV推移グラフ / 累計損益推移）`,
  ].join('\n');
}

function buildSection4(_data) {
  // TODO: agent_votes・final_decisions から月次部署別シグナル集計
  return [
    `## 4. 部署別判断まとめ`,
    '',
    `（将来実装: 各部署の BUY / ACCUMULATE / WAIT / DEFEND / SELL 集計）`,
    `（将来実装: 部署別勝率・的中率 ※データ蓄積後）`,
  ].join('\n');
}

function buildSection5(_data) {
  // TODO: final_decisions + nav_prices の照合で最良パフォーマンス判断を特定
  return [
    `## 5. ベスト判断`,
    '',
    `（将来実装: 今月最もリターンに貢献した判断の詳細）`,
  ].join('\n');
}

function buildSection6(_data) {
  // TODO: final_decisions + nav_prices の照合で最低パフォーマンス判断を特定
  return [
    `## 6. ワースト判断`,
    '',
    `（将来実装: 今月最もリターンを損ねた判断の詳細と反省）`,
  ].join('\n');
}

function buildSection7(_data) {
  // TODO: 各部署に月次振り返りコメントを LLM で生成
  // ask(MONTHLY_COMMENT_MARKET,    monthlySummary) → 神谷
  // ask(MONTHLY_COMMENT_RISK,      monthlySummary) → 黒崎
  // ask(MONTHLY_COMMENT_PORTFOLIO, monthlySummary) → 橘
  // ask(MONTHLY_COMMENT_AUDIT,     monthlySummary) → 鬼塚
  // ask(MONTHLY_COMMENT_REI,       monthlySummary) → 相沢レイ
  return [
    `## 7. AI社員コメント`,
    '',
    `📈 神谷シン（マーケット分析部）`,
    `（将来実装: 今月の市場分析振り返り）`,
    '',
    `🛡️ 黒崎ミサキ（リスク管理部）`,
    `（将来実装: 今月のリスク管理振り返り）`,
    '',
    `💼 橘アオイ（ポートフォリオ管理部）`,
    `（将来実装: 今月のポートフォリオ運用振り返り）`,
    '',
    `🔍 鬼塚ガイ（審査部）`,
    `（将来実装: 今月の判断審査振り返り）`,
    '',
    `👑 相沢レイ（秘書室長）`,
    `（将来実装: 今月の総合所見）`,
  ].join('\n');
}

function buildSection8(_data) {
  // TODO: 管理者（CEO）からのコメント入力機能
  // 自動生成ではなく、管理者が記入する想定
  return [
    `## 8. CEOコメント`,
    '',
    `（将来実装: 管理者による今月の総括・方針コメント）`,
  ].join('\n');
}

function buildSection9(_data) {
  // TODO: market_data 最新値から来月の観測条件を機械生成
  // TODO: LLM で来月の戦略方針を生成
  return [
    `## 9. 来月の方針`,
    '',
    `（将来実装: 来月の市場観測条件 / 投資戦略方針）`,
  ].join('\n');
}

// ── メイン ──────────────────────────────────────────────────

/**
 * 月刊記事ドラフトを組み立てる
 * LLM呼び出しなし・note保存なし・データ取得なし（土台フェーズ）
 * @param {string} startDate - YYYY-MM-DD（月初）
 * @param {string} endDate   - YYYY-MM-DD（月末）
 * @returns {{ note: string, meta: object }}
 */
async function buildMonthlyDraft(startDate, endDate) {
  // TODO: 有効化時に gatherMonthlyData(startDate, endDate) を呼ぶ
  const data = null;
  const meta = buildMonthlyMeta(startDate, endDate);

  const header = [
    `# AI Capital Monthly Report ${meta.month_id}`,
    `${startDate}〜${endDate}`,
    '',
    '*AI社員4部署による市場観測の月間まとめです。*',
    '',
  ].join('\n');

  const sections = [
    buildSection1(data),
    buildSection2(data),
    buildSection3(data),
    buildSection4(data),
    buildSection5(data),
    buildSection6(data),
    buildSection7(data),
    buildSection8(data),
    buildSection9(data),
  ];

  const footer = [
    '',
    '---',
    '*AI Capitalは投資助言サービスではありません。AI社員による意思決定の記録を公開するプロジェクトです。投資判断はご自身の責任でお願いします。*',
  ].join('\n');

  const note = header + sections.join('\n\n') + footer;
  return { note, meta };
}

module.exports = { monthId, buildMonthlyMeta, buildMonthlyDraft };
