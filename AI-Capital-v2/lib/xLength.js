'use strict';

/**
 * X（旧Twitter）の実際の文字数制限を扱うユーティリティ。
 * Xは280の「加重長」制限で、日本語（CJK）は1文字=weight2でカウントされるため、
 * 日本語中心の投稿は実質140字程度までしか通らない。URLは実文字数に関わらず
 * 一律23としてカウントされる（twitter-textが処理する）。
 * ローカル小型LLM（gemma4:e4b）に文字数指示を守らせるのは信頼できないため
 * （[[feedback-ollama-gemma4-behavior]]）、生成後に機械的に強制する。
 *
 * 2026-08-24に「無料プランでは実文字数130字が上限」として MAX_RAW_CHARS=130 の
 * 追加制約を課していたが、2026-08-25に実文字数192字・加重長267の投稿が実際に
 * 送信できたことを管理者が確認したため撤廃した。当時の投稿失敗は実文字数ではなく
 * 加重長280超過（289）が原因だったと考えられる。判定はX標準の加重長280に一本化する。
 */

const twttr = require('twitter-text');

// publisher.jsのX_SYSTEMが必ず出力する固定フッターの開始位置を示すマーカー。
// プロンプト側の文言を変更したらここも合わせて変更すること。
const SUFFIX_MARKER = '続きはnoteで';

function checkXLength(text) {
  const r = twttr.parseTweet(text);
  return { valid: r.valid, weightedLength: r.weightedLength, rawLength: Array.from(text).length };
}

/**
 * 制限超過時、固定フッター（URL・ハッシュタグを含む）は必ず残したまま、
 * それより前の自由記述部分をブロック単位で落として制限内に収める。
 *
 * 2026-08-25修正: 従来は1文字ずつ末尾をpopしていたため、
 * 「🛡️ 全資産への分散を」のように行の途中（多くは2択の片側）で文が切れた投稿文が
 * 生成されていた。X_SYSTEMの固定構成は空行区切りのブロック（①見出し／②2択の対立軸／
 * ③部署コメント／④締めの問い）であり、意味が壊れない最小単位はブロックなので、
 * 文字単位ではなくブロック単位で落とす。
 *
 * 落とす優先順位は「情報価値の低いものから」。②の2択（この投稿の主内容）は
 * ①の固定見出しより優先して残す＝どうしても入らない場合は見出しの方を捨てる。
 */
function enforceXLength(text) {
  if (checkXLength(text).valid) return text;

  const idx = text.indexOf(SUFFIX_MARKER);
  if (idx === -1) {
    console.warn('[xLength] フッターマーカーが見つからず機械トリムできません（生成結果をそのまま返します）');
    return text;
  }
  const suffix = text.slice(idx);

  // 空行区切りでブロック化（block[0]=①見出し, block[1]=②2択, block[2..]=③④）
  const blocks = text.slice(0, idx).trim().split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);

  // 試行順: 後ろのブロックから落とす（①見出し＋②2択までは維持）→ それでも入らなければ
  // ①見出しを捨てて②2択だけを残す → 最後の手段として①見出しのみ。
  // ①だけを残す試行を②より後ろに置くのが重要（先に試すと、中身のない見出し＋URLだけの
  // 投稿文が「制限内」として採用されてしまう）。
  const attempts = [];
  for (let keep = blocks.length; keep >= 2; keep--) {
    attempts.push(blocks.slice(0, keep));
  }
  if (blocks.length >= 2) attempts.push([blocks[1]]);   // ②の2択だけを残す（見出しを捨てる）
  if (blocks.length >= 1) attempts.push([blocks[0]]);   // 最後の手段: 見出しのみ

  for (const kept of attempts) {
    const candidate = `${kept.join('\n\n')}\n\n${suffix}`;
    if (checkXLength(candidate).valid) {
      console.warn(`[xLength] X投稿文が制限超過のためブロック単位でトリムしました（${text.length}字→${candidate.length}字・${blocks.length}→${kept.length}ブロック）`);
      return candidate;
    }
  }

  console.warn('[xLength] ブロックを全て落としてもフッターだけで制限超過。フッターのみ返します');
  return suffix;
}

module.exports = { checkXLength, enforceXLength };
