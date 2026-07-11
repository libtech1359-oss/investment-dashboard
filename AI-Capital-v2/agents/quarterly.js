'use strict';

/**
 * quarterly.js — 四半期レポートエージェント（土台のみ）
 *
 * 現時点の実装範囲:
 *   - quarterId / buildQuarterlyMeta / buildQuarterlyDraft のインターフェース定義
 *   - 全セクションはテンプレートスタブ（TODO コメント付き）
 *
 * 未実装（将来: 十分なデータ蓄積後に追加）:
 *   - データ収集・集計（gatherQuarterlyData）
 *   - AI社員コメント生成（LLM）
 *   - 四半期分析・総括生成（LLM）
 *   - 部署別勝率・ランキング
 *   - 資産推移グラフ
 *   - note.com 下書き保存
 *   - publisher.js 連携
 *   - Scheduler 登録・自動実行
 *   - quarterly_articles シートへの upsert 保存
 *
 * 手動確認: node _run_quarterly.js YYYY-MM-DD YYYY-MM-DD
 */

// ── Quarter ID ────────────────────────────────────────────────

/**
 * 四半期IDを生成する
 * Q1: 1〜3月 / Q2: 4〜6月 / Q3: 7〜9月 / Q4: 10〜12月
 * 例: '2026-02-15' → '2026-Q1'
 *     '2026-05-20' → '2026-Q2'
 *     '2026-08-10' → '2026-Q3'
 *     '2026-11-01' → '2026-Q4'
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} 'YYYY-Qn'
 */
function quarterId(dateStr) {
  const year  = parseInt(dateStr.slice(0, 4));
  const month = parseInt(dateStr.slice(5, 7));
  const q     = Math.ceil(month / 3);
  return `${year}-Q${q}`;
}

// ── メタデータ ────────────────────────────────────────────────

/**
 * 四半期レポートの管理メタデータを返す
 * status: 'draft' | 'reviewed' | 'published'（現時点では draft のみ使用）
 * @param {string} startDate - YYYY-MM-DD（四半期初日）
 * @param {string} endDate   - YYYY-MM-DD（四半期末日）
 * @returns {object}
 */
function buildQuarterlyMeta(startDate, endDate) {
  return {
    quarter_id:   quarterId(startDate),
    start_date:   startDate,
    end_date:     endDate,
    status:       'draft',
    generated_at: null,  // 将来: 生成完了時に ISO 8601 タイムスタンプを設定
    published_at: null,  // 将来: note.com 公開後に設定
  };
}

// ── セクションスタブ ──────────────────────────────────────────
// TODO: 各セクションに実データ取得・LLM生成を追加

function buildSection1(_data) {
  // TODO: 四半期全体の市場環境・出来事を集計し LLM で総括を生成
  return [
    `## 1. 四半期総括`,
    '',
    `（将来実装: 四半期を通じた市場環境と AI Capital の行動方針の総括）`,
  ].join('\n');
}

function buildSection2(_data) {
  // TODO: market_data から四半期の FG / VIX / NASDAQ / USD/JPY 推移を集計
  return [
    `## 2. 市場環境`,
    '',
    `（将来実装: Fear & Greed / VIX / NASDAQ100 / USD/JPY の四半期推移）`,
  ].join('\n');
}

function buildSection3(_data) {
  // TODO: portfolio_status・orders・nav_prices から四半期損益・勝率を計算
  return [
    `## 3. パフォーマンス`,
    '',
    `（将来実装: 四半期損益 / 勝率 / 最大ドローダウン / シャープレシオ）`,
    `（将来実装: 月別パフォーマンス比較）`,
  ].join('\n');
}

function buildSection4(_data) {
  // TODO: agent_votes・final_decisions から四半期部署別シグナル集計
  // TODO: 部署別勝率・的中率（十分なデータ蓄積後）
  return [
    `## 4. 部署別評価`,
    '',
    `（将来実装: 各部署の四半期シグナル集計 BUY / WAIT / DEFEND 等）`,
    `（将来実装: 部署別勝率・的中率 ※データ蓄積後）`,
    `（将来実装: 部署ランキング）`,
  ].join('\n');
}

function buildSection5(_data) {
  // TODO: 各部署に四半期振り返りコメントを LLM で生成
  // ask(QUARTERLY_COMMENT_MARKET,    quarterlySummary) → 神谷
  // ask(QUARTERLY_COMMENT_RISK,      quarterlySummary) → 黒崎
  // ask(QUARTERLY_COMMENT_PORTFOLIO, quarterlySummary) → 橘
  // ask(QUARTERLY_COMMENT_AUDIT,     quarterlySummary) → 鬼塚
  // ask(QUARTERLY_COMMENT_REI,       quarterlySummary) → 相沢レイ
  return [
    `## 5. AI社員コメント`,
    '',
    `📈 神谷シン（マーケット分析部）`,
    `（将来実装: 四半期の市場分析振り返り）`,
    '',
    `🛡️ 黒崎ミサキ（リスク管理部）`,
    `（将来実装: 四半期のリスク管理振り返り）`,
    '',
    `💼 橘アオイ（ポートフォリオ管理部）`,
    `（将来実装: 四半期のポートフォリオ運用振り返り）`,
    '',
    `🔍 鬼塚ガイ（審査部）`,
    `（将来実装: 四半期の判断審査振り返り）`,
    '',
    `👑 相沢レイ（秘書室長）`,
    `（将来実装: 四半期の総合所見）`,
  ].join('\n');
}

function buildSection6(_data) {
  // TODO: final_decisions + nav_prices の照合で四半期最良パフォーマンス判断を特定
  return [
    `## 6. ベスト判断`,
    '',
    `（将来実装: 四半期を通じて最もリターンに貢献した判断の詳細）`,
  ].join('\n');
}

function buildSection7(_data) {
  // TODO: final_decisions + nav_prices の照合で四半期最低パフォーマンス判断を特定
  return [
    `## 7. ワースト判断`,
    '',
    `（将来実装: 四半期を通じて最もリターンを損ねた判断の詳細と反省）`,
  ].join('\n');
}

function buildSection8(_data) {
  // TODO: 翌四半期の市場観測条件・投資戦略方針を LLM で生成
  return [
    `## 8. 次四半期の戦略`,
    '',
    `（将来実装: 翌四半期の市場観測条件 / 重点銘柄 / 投資戦略方針）`,
  ].join('\n');
}

function buildSection9(_data) {
  // TODO: 四半期全体の学びを「AI会社の経営報告」として LLM で文章化
  // ask(QUARTERLY_CLOSING_SYSTEM, quarterlySummary, { num_predict: 800 })
  return [
    `## 9. 秘書室長総括（相沢レイ）`,
    '',
    `（将来実装: AI会社として四半期を通じて何を学んだかを経営報告として文章化）`,
  ].join('\n');
}

// ── メイン ──────────────────────────────────────────────────

/**
 * 四半期レポートドラフトを組み立てる
 * LLM呼び出しなし・note保存なし・データ取得なし（土台フェーズ）
 * @param {string} startDate - YYYY-MM-DD（四半期初日）
 * @param {string} endDate   - YYYY-MM-DD（四半期末日）
 * @returns {{ note: string, meta: object }}
 */
async function buildQuarterlyDraft(startDate, endDate) {
  // TODO: 有効化時に gatherQuarterlyData(startDate, endDate) を呼ぶ
  const data = null;
  const meta = buildQuarterlyMeta(startDate, endDate);

  const header = [
    `# AI Capital Quarterly Report ${meta.quarter_id}`,
    `${startDate}〜${endDate}`,
    '',
    '*AI社員4部署による市場観測の四半期まとめです。*',
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

module.exports = { quarterId, buildQuarterlyMeta, buildQuarterlyDraft };
