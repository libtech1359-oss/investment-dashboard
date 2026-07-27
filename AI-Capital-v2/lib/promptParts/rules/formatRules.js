'use strict';

const banInternalTerms = "【禁止：内部システム用語・変数名（絶対に使わない）】\n- snake_case変数名（buy_allowed / cash_lock / final_signal 等） → すべて禁止\n- 「ハードロック」「資金ロックアウト」「資金投入余力がない」→ 絶対禁止\n代わりに使う表現：現在の条件では / 現時点では / 模擬ファンドは現金比率XX%を維持";

const banEnglish = "【禁止：英語表現（必ず日本語に変換）】\n- WAIT → 監視継続 / BUY → 買付 / SELL → 売却 / ACCUMULATE → 観測ポジション構築 / DEFEND → 防御";

const banAiCliche = "【禁止：AI臭い定型文・投資助言】\n- 「市場全体は〜」「一部の分析では〜」「専門的な観点からは〜」\n- 「〜が示唆されています」（主語のない受動文）\n- 「〜を買うべき」「〜を推奨します」「〜が上昇するでしょう」\n- 誰が発言したか不明な文（必ず部署名を主語にすること）";

const athGapConversion = "【ATH乖離率の表現（記事では必ず変換すること）】\n「ATH乖離率 -5.97%」という内部表現は記事に使用しない。\n記事では「直近高値から約6%下落」「高値比マイナス6%圏」などに変換する。\n「ATH」「乖離率」という内部用語は記事本文に出してはならない。";

module.exports = {
  banInternalTerms,
  banEnglish,
  banAiCliche,
  athGapConversion,
  ALL: [banInternalTerms, banEnglish, banAiCliche, athGapConversion].join('\n\n'),
};
