'use strict';

/**
 * config/financeStrategy.js — 財務戦略部（財前ミナ）v1 設定
 *
 * 財務戦略部は「現金比率が危険水準まで低下したときだけ、ポートフォリオの集中と
 * 資金余力を確認し、長期投資を維持するために必要な範囲で限定的な REDUCE（部分売却）を
 * "提案" する」隠し部署。売買を頻繁に行う AI にはしない。
 *
 * 設計仕様: 財務戦略部（財前ミナ）v1 設計 / 2026-08-30 確定
 *
 * 【重要な単位の整理】
 *   REDUCE 額・10% 上限・30 日 NAV 上限・FIFO ロット原価 … すべて「取得原価相当額」
 *   現金比率・NAV 比率・目標配分下限判定 … すべて「時価基準」
 *
 * 数値はこのファイルでのみ管理し、agents/finance.js にハードコードしない。
 * env で上書き可能（主にテスト・段階検証用）。
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// ── 登場・発動条件 ───────────────────────────────────────────
const PUBLIC_FROM         = process.env.FINANCE_PUBLIC_FROM || '2026-08-31'; // この日以降 resolveMode が動く（finance_proposals へ記録開始）
const ACTIVATE_BELOW_PCT  = num(process.env.FINANCE_ACTIVATE_BELOW_PCT, 20); // この現金比率"未満"で active
const DEACTIVATE_AT_PCT   = num(process.env.FINANCE_DEACTIVATE_AT_PCT, 25);  // この現金比率"以上"で monitoring へ戻る

// ── 日刊記事への登場条件 ─────────────────────────────────────
// PUBLIC_FROM（記録開始）とは別。この日以降だけ記事に財務戦略部セクションを出す。
const ARTICLE_FROM            = process.env.FINANCE_ARTICLE_FROM || '2026-09-07'; // 記事デビュー日
// monitoring（平常）でも「現金比率が発動ラインへ ARTICLE_MONITORING_MARGIN_PCT 以内に接近」した日は
// 軽い監視コメントを出す。それより現金余力がある平常日はセクションごと非表示（記事を肥大化させない）。
const ARTICLE_MONITORING_MARGIN_PCT = num(process.env.FINANCE_ARTICLE_MONITORING_MARGIN_PCT, 2);

// ── REDUCE 候補生成のゲート・上限 ────────────────────────────
const MIN_GAIN_PCT             = num(process.env.FINANCE_MIN_GAIN_PCT, 15);          // 含み益下限（必要条件）
const MIN_LOT_AGE_DAYS         = num(process.env.FINANCE_MIN_LOT_AGE_DAYS, 30);      // 削減可能ロットの経過日数下限（カレンダー日）
const REDUCE_COOLDOWN_DAYS     = num(process.env.FINANCE_REDUCE_COOLDOWN_DAYS, 7);   // 前回"提案日"からの最小間隔
const MAX_REDUCE_RATIO         = num(process.env.FINANCE_MAX_REDUCE_RATIO, 0.10);    // 1 回の REDUCE ≤ 対象銘柄の取得原価の 10%
const MAX_REDUCE_NAV_RATIO_30D = num(process.env.FINANCE_MAX_REDUCE_NAV_RATIO_30D, 0.05); // 直近 30 日 REDUCE 累計 ≤ NAV の 5%
const ROLLING_WINDOW_DAYS      = num(process.env.FINANCE_ROLLING_WINDOW_DAYS, 30);   // R2 ローリング窓（カレンダー日）

// ── 実行モード ───────────────────────────────────────────────
// FINANCE_DRY_RUN が明示的に 'false' のときだけ本番売却。それ以外（未設定含む）は安全側でドライラン。
function isDryRun() {
  return process.env.FINANCE_DRY_RUN !== 'false';
}

// ── 登場ゲート ───────────────────────────────────────────────
function isPublic(date) {
  return String(date || '') >= PUBLIC_FROM;
}

/**
 * 発動状態マシン（ヒステリシス付き・純粋関数）
 *
 *   date < PUBLIC_FROM                         -> 'inactive'（記事にも出ない）
 *   prevMode='active' かつ cashRatio >= 25     -> 'monitoring'（回復解除）
 *   prevMode='active' かつ cashRatio  < 25     -> 'active'（据え置き）
 *   それ以外で「今回<20% かつ 前回<20%」       -> 'active'（2 連続 <20% で発動）
 *   それ以外                                   -> 'monitoring'
 *
 * 「2 連続 <20%」は pending 由来の一時的な現金比率ディップで誤発動しないための条件。
 * prevCashRatioPct は直近の finance_proposals 行の cash_ratio_before（無ければ null）。
 *
 * @param {{date:string, cashRatioPct:number|string, prevMode?:string, prevCashRatioPct?:number|string|null}} args
 * @returns {'inactive'|'monitoring'|'active'}
 */
function resolveMode({ date, cashRatioPct, prevMode = 'monitoring', prevCashRatioPct = null }) {
  if (!isPublic(date)) return 'inactive';

  const cr = Number(cashRatioPct);
  if (!Number.isFinite(cr)) return prevMode === 'active' ? 'active' : 'monitoring'; // 現金比率不明 → 状態維持（安全側）

  if (prevMode === 'active') {
    return cr >= DEACTIVATE_AT_PCT ? 'monitoring' : 'active';
  }

  const below     = cr < ACTIVATE_BELOW_PCT;
  const prevBelow = prevCashRatioPct != null && Number(prevCashRatioPct) < ACTIVATE_BELOW_PCT;
  if (below && prevBelow) return 'active';
  return 'monitoring';
}

// ── 記事登場ゲート ───────────────────────────────────────────
function isArticleVisible(date) {
  return String(date || '') >= ARTICLE_FROM;
}

/**
 * 日刊記事に財務戦略部セクションを出すか・どのトーンで出すかを決める（純粋関数）。
 *
 *   date < ARTICLE_FROM                          -> { show:false }（デビュー前）
 *   financeRow なし / mode='inactive'            -> { show:false }（Step 2c が記録していない）
 *   mode='monitoring' かつ 現金比率が発動ライン+margin より上 -> { show:false }（平常日）
 *   mode='monitoring' かつ 発動ラインへ margin 以内に接近     -> { show:true, tone:'monitoring' }
 *   mode='active' かつ REDUCE 提案あり（proposed/approved/rejected/executed*) -> { show:true, tone:'proposal' }
 *   mode='active' かつ 提案なし（no_action 等）               -> { show:true, tone:'active' }
 *
 * @param {{date:string, financeRow?:object|null, cashRatioPct?:number|string|null}} args
 * @returns {{show:boolean, tone?:'monitoring'|'active'|'proposal', reason:string}}
 */
function resolveArticleVisibility({ date, financeRow = null, cashRatioPct = null }) {
  if (!isArticleVisible(date)) return { show: false, reason: `ARTICLE_FROM(${ARTICLE_FROM})前` };
  if (!financeRow)             return { show: false, reason: 'finance_proposals に当日行なし' };

  const mode = String(financeRow.mode || '');
  if (mode === 'inactive' || mode === '') return { show: false, reason: `mode=${mode || '空'}` };

  if (mode === 'monitoring') {
    // '' / null は Number() だと 0 に化けるため parseFloat で判定し、順に finite を採用する
    const parseNum = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
    let cr = parseNum(cashRatioPct);
    if (!Number.isFinite(cr)) cr = parseNum(financeRow.cash_ratio_before);
    if (!Number.isFinite(cr)) return { show: false, reason: '現金比率不明' };
    const nearLine = cr <= ACTIVATE_BELOW_PCT + ARTICLE_MONITORING_MARGIN_PCT;
    return nearLine
      ? { show: true, tone: 'monitoring', reason: `monitoring・現金比率${cr}%が発動ライン接近` }
      : { show: false, reason: `monitoring・現金比率${cr}%は余力あり` };
  }

  // mode === 'active'（no_action も含む）
  const PROPOSAL_STATUSES = ['proposed', 'approved', 'rejected', 'executed', 'executed_dryrun'];
  if (PROPOSAL_STATUSES.includes(String(financeRow.status || ''))) {
    return { show: true, tone: 'proposal', reason: `active・status=${financeRow.status}` };
  }
  return { show: true, tone: 'active', reason: `active・status=${financeRow.status || '空'}` };
}

module.exports = {
  PUBLIC_FROM,
  ACTIVATE_BELOW_PCT,
  DEACTIVATE_AT_PCT,
  ARTICLE_FROM,
  ARTICLE_MONITORING_MARGIN_PCT,
  MIN_GAIN_PCT,
  MIN_LOT_AGE_DAYS,
  REDUCE_COOLDOWN_DAYS,
  MAX_REDUCE_RATIO,
  MAX_REDUCE_NAV_RATIO_30D,
  ROLLING_WINDOW_DAYS,
  isDryRun,
  isPublic,
  isArticleVisible,
  resolveMode,
  resolveArticleVisibility,
};
