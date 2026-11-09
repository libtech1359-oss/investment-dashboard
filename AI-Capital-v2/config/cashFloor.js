'use strict';

/**
 * config/cashFloor.js — 買い側キャッシュフロア v1 設定
 *
 * 現金比率が下限に近づくにつれて日次買付額を線形に逓減させ、暴落逆張り用の
 * 資金余力を残すための「買い側ブレーキ」。売却は一切発生させない（利確は
 * 財務戦略部＝財前ミナの専任のまま。churn source を増やさない）。
 *
 * 設計仕様: 買い側キャッシュフロア v1 設計 / 2026-09-07 確定
 *
 * 【判定の単位】
 *   現金比率（cashRatioPct）… 時価基準の % 値（portfolio_status.cash_ratio と同じ）
 *   bu(y)Amount / baseAmount   … 買い注文と同じ「取得原価相当額」の円
 *
 * 数値はこのファイルでのみ管理し、lib/signalAggregator.js にハードコードしない。
 * env で上書き可能（主にテスト・段階検証用）。
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// 現金比率・金額のパース。'' / null / undefined は Number() だと 0 に化けるため
// parseFloat を使い、数値化できないものは NaN のまま返す（signalAggregator と同じ流儀）。
const pf = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};

// ── フロア水準 ───────────────────────────────────────────────
// SOFT 以上: 通常買付（逓減なし）。財前ミナ ACTIVATE_BELOW_PCT と揃える。
// SOFT 未満 HARD 超: baseAmount を線形係数 (cr - hard)/(soft - hard) で逓減。
// HARD 以下: 買付見送り（通常時）。
// CRASH 以下: 暴落例外時でも買付見送り（最終下限）。
const CASH_FLOOR_SOFT_PCT   = num(process.env.CASH_FLOOR_SOFT_PCT, 20);
const CASH_FLOOR_HARD_PCT   = num(process.env.CASH_FLOOR_HARD_PCT, 10);
const CASH_FLOOR_CRASH_PCT  = num(process.env.CASH_FLOOR_CRASH_PCT, 5);

// ── 暴落例外の発火条件（どちらか一方で ON）──────────────────
// 暴落局面では逆張り用に HARD ではなく CRASH まで買いを許可する。
const CRASH_FG_MAX          = num(process.env.CASH_FLOOR_CRASH_FG_MAX, 25);      // Fear&Greed これ以下
const CRASH_NASDAQ_DROP_PCT = num(process.env.CASH_FLOOR_CRASH_NASDAQ_DROP_PCT, -3.0); // NASDAQ 前日比 これ以下

// ── 逓減後の最小発注額 ───────────────────────────────────────
// これ未満に縮小されたら 0（＝買付見送り）に丸める。orderManager の下限（¥1,000）と揃える。
const MIN_ORDER_AMOUNT      = num(process.env.CASH_FLOOR_MIN_ORDER_AMOUNT, 1000);

// ── 小口買付（2026-11-06 確定仕様）────────────────────────────
// 現金比率が下限〜SOFT(20%)の間では、現金フロア適用後の最終金額に小口キャップをかける。
// 目的は「現金が少ない間も、合理的な機会に限って少額で買い続けられる」ようにすること。
// 取引回数を増やすこと自体は目的にしない（買付ゲートは従来の実効スコア0.5以上のまま）。
const SMALL_LOT_NORMAL_AMOUNT     = num(process.env.SMALL_LOT_NORMAL_AMOUNT, 10000);    // 通常の小口上限
const SMALL_LOT_STRONG_AMOUNT     = num(process.env.SMALL_LOT_STRONG_AMOUNT, 30000);    // 強根拠のときの小口上限
const SMALL_LOT_CRASH_BAND_AMOUNT = num(process.env.SMALL_LOT_CRASH_BAND_AMOUNT, 10000); // 暴落時の下限帯(5〜10%)は固定
// ポートフォリオ管理部（アオイ）の買い票を有効にする条件（現金比率が下限〜SOFTの間のみ）
const SMALL_LOT_AOI_MAX_FEAR_GREED  = num(process.env.SMALL_LOT_AOI_MAX_FEAR_GREED, 30);  // Fear&Greed これ以下
const SMALL_LOT_AOI_MIN_OTHER_BUYS  = num(process.env.SMALL_LOT_AOI_MIN_OTHER_BUYS, 2);   // 他3部署の買い票 これ以上
// 強根拠の条件（両方満たすとき）。Rule Engineスコアは candidate_assets.score の 0〜100 スケールで、
// 既存の TIEBREAK_MIN_RULE_SCORE(0.70) とは別物（スケール不整合は別件。流用しない）。
const SMALL_LOT_STRONG_MIN_VOTE_SCORE = num(process.env.SMALL_LOT_STRONG_MIN_VOTE_SCORE, 0.75); // 実効の部署スコア
const SMALL_LOT_STRONG_MIN_RULE_SCORE = num(process.env.SMALL_LOT_STRONG_MIN_RULE_SCORE, 20);   // 採用銘柄の Rule Engine スコア(0-100)

const PORTFOLIO_DEPT = 'ポートフォリオ管理部';
const BUY_SIGNALS    = new Set(['BUY', 'ACCUMULATE']);

/**
 * 暴落シグナル判定（純粋関数）。
 * @param {{fearGreed?:number|string, nasdaqChangePct?:number|string}} mkt
 * @returns {boolean}
 */
function isCrashSignal({ fearGreed, nasdaqChangePct } = {}) {
  const fg = Number(fearGreed);
  const nd = Number(nasdaqChangePct);
  return (Number.isFinite(fg) && fg <= CRASH_FG_MAX)
      || (Number.isFinite(nd) && nd <= CRASH_NASDAQ_DROP_PCT);
}

/**
 * 買付予算の決定（純粋関数）。
 *
 *   cashRatioPct 数値化不可         -> baseAmount 素通し（既存挙動を変えない・安全側）
 *   cashRatioPct >= SOFT            -> baseAmount 素通し
 *   cashRatioPct <= floor           -> 0（買付見送り）  ※floor = crash ? CRASH : HARD
 *   floor < cashRatioPct < SOFT     -> floorTo1000(baseAmount * factor)、ただし
 *                                      ・cashJpy を超えない
 *                                      ・MIN_ORDER_AMOUNT 未満なら 0
 *     factor = (cashRatioPct - floor) / (SOFT - floor)   （0〜1）
 *
 * @param {object} args
 * @param {number|string} args.cashRatioPct  現在の現金比率（%）
 * @param {number|string} [args.cashJpy]     現在の現金残高（円）。逓減後でも残高は超えない
 * @param {number|string} args.baseAmount    フロア適用前の買付額（円）
 * @param {boolean}       [args.crashSignal] 暴落例外を有効にするか（isCrashSignal() の結果）
 * @param {object}        [args.cfg]         このモジュール（テスト時に差し替え可）
 * @returns {{amount:number, factor:number, note:string, floorPct:number}}
 */
function resolveBuyBudget({ cashRatioPct, cashJpy = Infinity, baseAmount, crashSignal = false, cfg = module.exports }) {
  const base = Math.max(0, num(baseAmount, 0));
  const cr   = pf(cashRatioPct);
  const soft = cfg.CASH_FLOOR_SOFT_PCT;
  const floorPct = crashSignal ? cfg.CASH_FLOOR_CRASH_PCT : cfg.CASH_FLOOR_HARD_PCT;

  if (!Number.isFinite(cr)) {
    return { amount: base, factor: 1, note: '', floorPct };
  }
  if (cr >= soft) {
    return { amount: base, factor: 1, note: '', floorPct };
  }
  if (cr <= floorPct) {
    return {
      amount: 0, factor: 0, floorPct,
      note: `現金比率${cr}%が下限${floorPct}%以下のため、買付を見送りました。`,
    };
  }

  const factor = (cr - floorPct) / (soft - floorPct);
  let amt = Math.floor((base * factor) / 1000) * 1000;
  const parsedCash = pf(cashJpy);
  const cashCap = Number.isFinite(parsedCash) ? Math.max(0, parsedCash) : Infinity;
  amt = Math.min(amt, cashCap);

  if (amt < cfg.MIN_ORDER_AMOUNT) {
    return {
      amount: 0, factor, floorPct,
      note: `現金比率${cr}%が下限圏のため、現金フロア抑制後の買付額が下限未満となり見送りました。`,
    };
  }
  return {
    amount: amt, factor, floorPct,
    note: `現金比率${cr}%が下限圏（${floorPct}〜${soft}%）のため、現金フロアにより買付を¥${amt.toLocaleString()}に抑制しました。`,
  };
}

/**
 * ポートフォリオ管理部（アオイ）の実効票を決める（純粋関数・小口買付）。
 *
 * アオイは他部署の票を見られない（マーケット/リスクと並列に投票し、審査部は後続）ため、
 * 「他3部署の買い票が○票以上」という条件は全票が揃った集計側（signalAggregator）で判定する。
 * アオイの買い票（BUY/ACCUMULATE）だけが対象で、WAIT等はそのまま返す。
 *
 *   cashRatioPct 数値化不可 / SOFT(20%)以上      -> そのまま（従来ルール）
 *   cashRatioPct <= 下限（通常10% / 暴落5%）     -> WAIT（原則WAIT。現金フロアでも買付ゼロ）
 *   下限 < cashRatioPct < SOFT                    -> Fear&Greed <= 30 かつ 他3部署の買い票 >= 2 のときだけ有効。
 *                                                    満たさなければ WAIT 扱い（票の置換のみ。元データは変更しない）
 *
 * @param {object} args
 * @param {string}        args.signal         アオイの投票シグナル
 * @param {number|string} args.cashRatioPct   現在の現金比率（%）
 * @param {number|string} args.fearGreed      Fear & Greed
 * @param {boolean}       [args.crashSignal]  暴落シグナル（isCrashSignal() の結果）
 * @param {number}        [args.otherBuyVotes] マーケット/リスク/審査のうち BUY|ACCUMULATE の部署数
 * @returns {{signal:string, downgraded:boolean, note:string}}
 */
function resolvePortfolioVote({ signal, cashRatioPct, fearGreed, crashSignal = false, otherBuyVotes = 0, cfg = module.exports }) {
  const sig = String(signal || '').toUpperCase();
  if (!BUY_SIGNALS.has(sig)) return { signal: sig, downgraded: false, note: '' };

  const cr = pf(cashRatioPct);
  if (!Number.isFinite(cr) || cr >= cfg.CASH_FLOOR_SOFT_PCT) {
    return { signal: sig, downgraded: false, note: '' };
  }

  const floorPct = crashSignal ? cfg.CASH_FLOOR_CRASH_PCT : cfg.CASH_FLOOR_HARD_PCT;
  if (cr <= floorPct) {
    return {
      signal: 'WAIT', downgraded: true,
      note: `現金比率${cr}%が下限${floorPct}%以下のため、ポートフォリオ管理部の買い票は見送り扱いとしました。`,
    };
  }

  const fg = pf(fearGreed);
  const fgOk    = Number.isFinite(fg) && fg <= cfg.SMALL_LOT_AOI_MAX_FEAR_GREED;
  const votesOk = otherBuyVotes >= cfg.SMALL_LOT_AOI_MIN_OTHER_BUYS;
  if (fgOk && votesOk) return { signal: sig, downgraded: false, note: '' };

  return {
    signal: 'WAIT', downgraded: true,
    note: `現金比率${cr}%の小口買付条件（Fear & Greed ${cfg.SMALL_LOT_AOI_MAX_FEAR_GREED}以下、かつ他の3部署のうち${cfg.SMALL_LOT_AOI_MIN_OTHER_BUYS}部署以上が買い支持）を満たさなかったため、ポートフォリオ管理部の買い票は見送り扱いとしました。`,
  };
}

/**
 * 小口キャップ（純粋関数）。現金フロア適用「後」の最終金額に対して上限をかける。
 *
 *   cashRatioPct 数値化不可 / SOFT以上  -> 素通し（キャップなし）
 *   cashRatioPct <= 下限                 -> 0（現金フロアと同じ最終下限。防御的）
 *   暴落シグナル かつ 現金比率 <= HARD(10%) -> 上限 ¥10,000 固定（強根拠は適用しない）
 *   強根拠（実効スコア>=0.75 かつ 採用銘柄の Rule Engine スコア>=20） -> 上限 ¥30,000
 *   それ以外                              -> 上限 ¥10,000
 *   最終額 = floorTo1000(min(フロア後の額, 上限, 現金残高))。MIN_ORDER_AMOUNT(¥1,000)未満は 0。
 *   ※ 部署の推薦額の平均がいくら大きくても、上限を超えない。
 *
 * @param {object} args
 * @param {number|string} args.cashRatioPct
 * @param {number|string} [args.cashJpy]
 * @param {number|string} args.amount        現金フロア適用後の金額（円）
 * @param {boolean}       [args.crashSignal]
 * @param {number|string} [args.voteScore]   実効の部署スコア（アオイの実効票を反映した normalizedScore）
 * @param {number|string} [args.ruleScore]   採用銘柄自身の candidate_assets.score（0〜100）
 * @returns {{amount:number, applied:boolean, strong:boolean, cap:number|null, note:string}}
 *   applied=true は「金額を変更した（または見送りにした）」ことを表す。
 */
function resolveSmallLotAmount({ cashRatioPct, cashJpy = Infinity, amount, crashSignal = false, voteScore, ruleScore, cfg = module.exports }) {
  const base = Math.max(0, num(amount, 0));
  const cr   = pf(cashRatioPct);
  if (!Number.isFinite(cr) || cr >= cfg.CASH_FLOOR_SOFT_PCT) {
    return { amount: base, applied: false, strong: false, cap: null, note: '' };
  }

  const floorPct = crashSignal ? cfg.CASH_FLOOR_CRASH_PCT : cfg.CASH_FLOOR_HARD_PCT;
  if (cr <= floorPct) {
    return {
      amount: 0, applied: true, strong: false, cap: 0,
      note: `現金比率${cr}%が下限${floorPct}%以下のため、買付を見送りました。`,
    };
  }

  const crashBand = crashSignal && cr <= cfg.CASH_FLOOR_HARD_PCT;
  const vs = pf(voteScore);
  const rs = pf(ruleScore);
  const strong = !crashBand
    && Number.isFinite(vs) && vs >= cfg.SMALL_LOT_STRONG_MIN_VOTE_SCORE
    && Number.isFinite(rs) && rs >= cfg.SMALL_LOT_STRONG_MIN_RULE_SCORE;
  const cap = crashBand ? cfg.SMALL_LOT_CRASH_BAND_AMOUNT
            : strong    ? cfg.SMALL_LOT_STRONG_AMOUNT
            :             cfg.SMALL_LOT_NORMAL_AMOUNT;

  const parsedCash = pf(cashJpy);
  const cashCap = Number.isFinite(parsedCash) ? Math.max(0, parsedCash) : Infinity;
  const amt = Math.floor(Math.min(base, cap, cashCap) / 1000) * 1000;

  if (amt < cfg.MIN_ORDER_AMOUNT) {
    return {
      amount: 0, applied: true, strong, cap,
      note: `現金比率${cr}%のため小口買付に絞った結果、買付額が最小発注額未満となり見送りました。`,
    };
  }
  if (amt === base) {
    return { amount: amt, applied: false, strong, cap, note: '' };
  }
  return {
    amount: amt, applied: true, strong, cap,
    note: `現金比率${cr}%と資金余力が限られているため、小口買付として買付を¥${amt.toLocaleString()}に抑制しました` +
          (strong ? `（根拠が強いため上限¥${cap.toLocaleString()}）。` : '。'),
  };
}

/**
 * 部署プロンプト用の金額ガイド行（現金比率が小口帯のときだけ返す。それ以外は空文字）。
 * 部署の推薦額が後段の現金フロア/小口キャップと大きく食い違わないようにするための参考情報で、
 * シグナル（買う/買わない）の判断基準には一切影響させない。
 */
function smallLotAmountHint(cashRatioPct, cfg = module.exports) {
  const cr = Number(cashRatioPct);
  if (cashRatioPct === '' || cashRatioPct == null || !Number.isFinite(cr)) return '';
  if (cr >= cfg.CASH_FLOOR_SOFT_PCT || cr <= cfg.CASH_FLOOR_HARD_PCT) return '';
  return `【資金面の参考（金額欄のみに反映）】現金比率${cr}%（${cfg.CASH_FLOOR_HARD_PCT}%以上${cfg.CASH_FLOOR_SOFT_PCT}%未満の小口帯）。` +
    `買い判断のときの recommended_amount は小口の¥${cfg.SMALL_LOT_NORMAL_AMOUNT.toLocaleString()}を基本とし、` +
    `通常レンジ（数十万円）は使わないこと。signal（買う/買わない）の判断基準はこの情報で変えない。`;
}

module.exports = {
  smallLotAmountHint,
  SMALL_LOT_NORMAL_AMOUNT,
  SMALL_LOT_STRONG_AMOUNT,
  SMALL_LOT_CRASH_BAND_AMOUNT,
  SMALL_LOT_AOI_MAX_FEAR_GREED,
  SMALL_LOT_AOI_MIN_OTHER_BUYS,
  SMALL_LOT_STRONG_MIN_VOTE_SCORE,
  SMALL_LOT_STRONG_MIN_RULE_SCORE,
  PORTFOLIO_DEPT,
  BUY_SIGNALS,
  resolvePortfolioVote,
  resolveSmallLotAmount,
  CASH_FLOOR_SOFT_PCT,
  CASH_FLOOR_HARD_PCT,
  CASH_FLOOR_CRASH_PCT,
  CRASH_FG_MAX,
  CRASH_NASDAQ_DROP_PCT,
  MIN_ORDER_AMOUNT,
  isCrashSignal,
  resolveBuyBudget,
};
