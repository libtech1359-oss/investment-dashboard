'use strict';

/**
 * scripts/auto-devlog.js — コミットから development_logs を自動生成する
 *
 * git の post-commit フック（リポジトリルート/.git/hooks/post-commit）から
 * 起動される。人が saveDevelopmentLog() を書く必要を完全に無くすための入口。
 *
 * 使い方（通常はフックが自動で呼ぶ。手動実行も可能）:
 *   node scripts/auto-devlog.js            # 直近のコミット(HEAD)を解析
 *   node scripts/auto-devlog.js <commit>   # 指定コミットを解析
 *
 * 処理の流れ:
 *   1. 対象コミットの変更ファイルのうち、AI-Capital-v2/{agents,lib,config,gas-deploy}/
 *      配下だけを対象にする（データファイル・チャート画像・メモ更新等は完全に無視）。
 *      config/systemVersion.json 自体の変更（後述の自動コミットの結果）は
 *      対象から除外する（自己参照によるログ・バージョンの水増しを防ぐため）。
 *      対象ファイルが無ければ何もせず終了する（development_logsを汚さない）。
 *   2. lib/changeClassifier.js が diff の内容だけから種別を決定的に分類する
 *      （Ollama等のLLMには依存しない＝オフラインでも必ず動く）。
 *   3. 分類が MAJOR_EVENT_TYPES のいずれかであれば:
 *        - lib/systemVersion.bumpMinor() で config/systemVersion.json のバージョンを繰り上げ
 *        - lib/changelog.appendEntry() で CHANGELOG.md を更新
 *      分類が OTHER であれば、バージョンもCHANGELOGも変更しない。
 *   4. どちらの場合も development_logs シートへ1行保存する（監査ログとして必ず残す）。
 *
 * コミットについて（重要）:
 *   AIは config/systemVersion.json / CHANGELOG.md / development_logs への保存 と
 *   git status確認・「コミット可能です」という通知 までを担当し、
 *   実際の git commit は人が行う運用をデフォルトとする（無断でのコミットは行わない）。
 *   将来の完全無人運転に備え、環境変数 AUTO_COMMIT=true を設定した場合のみ、
 *   config/systemVersion.json と CHANGELOG.md の2ファイルだけを対象に自動コミットする
 *   オプション機能として実装している（通常運用ではAUTO_COMMIT未設定＝OFFがデフォルト）。
 *
 * 失敗時の扱い:
 *   - git操作・分類自体が失敗した場合はコミットに一切影響を与えない（例外を投げず警告のみ）。
 *   - development_logsへのネットワーク書き込みが失敗しても、config/systemVersion.json /
 *     CHANGELOG.md へのローカル反映（バージョン・変更履歴）は既に完了しているため失われない。
 */

const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
} catch {
  // dotenv未インストール環境（テスト等）でも致命的にしない
}


const { execFileSync }  = require('child_process');

const REPO_DIR    = path.join(__dirname, '..'); // AI-Capital-v2/
const SOURCE_DIRS = ['agents/', 'lib/', 'config/', 'gas-deploy/'];
// このスクリプト自身が書き換える版数管理ファイルは分類対象から除外する（自己参照防止）
const EXCLUDE_FILES = ['config/systemVersion.json'];
const VERSION_FILE  = 'config/systemVersion.json';
const CHANGELOG_FILE = 'CHANGELOG.md';

function git(args) {
  return execFileSync('git', args, { cwd: REPO_DIR, maxBuffer: 50 * 1024 * 1024 }).toString();
}

function hasParent(hash) {
  try { git(['rev-parse', `${hash}~1`]); return true; }
  catch { return false; }
}

function getCommitMeta(hash) {
  const out = git(['log', '-1', '--format=%H%x1f%s%x1f%b%x1f%ad', '--date=format:%Y-%m-%d', hash]);
  const [full, subject, body, date] = out.split('\x1f');
  return { hash: (full || '').trim(), subject: (subject || '').trim(), body: (body || '').trim(), date: (date || '').trim() };
}

function getFileStatus(hash) {
  const args = hasParent(hash)
    ? ['diff', '--name-status', '--relative', `${hash}~1`, hash]
    : ['show', '--name-status', '--format=', '--relative', hash];
  const out = git(args);
  const fileStatus = {};
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split('\t');
    const file = rest.pop();
    if (file) fileStatus[file.trim()] = (status || '').trim()[0];
  }
  return fileStatus;
}

function getDiffText(hash, files) {
  if (files.length === 0) return '';
  const args = hasParent(hash)
    ? ['diff', '--relative', `${hash}~1`, hash, '--', ...files]
    : ['show', '--format=', '--relative', hash, '--', ...files];
  return git(args);
}

function getNumstat(hash, files) {
  if (files.length === 0) return { added: 0, deleted: 0 };
  const args = hasParent(hash)
    ? ['diff', '--numstat', '--relative', `${hash}~1`, hash, '--', ...files]
    : ['show', '--numstat', '--format=', '--relative', hash, '--', ...files];
  const out = git(args);
  let added = 0, deleted = 0;
  for (const line of out.split('\n')) {
    const m = /^(\d+)\t(\d+)\t/.exec(line);
    if (m) { added += Number(m[1]); deleted += Number(m[2]); }
  }
  return { added, deleted };
}

async function main() {
  const hash = process.argv[2] || 'HEAD';

  const meta       = getCommitMeta(hash);
  const fileStatus = getFileStatus(hash);
  const allFiles   = Object.keys(fileStatus);
  const relevant   = allFiles
    .filter(f => SOURCE_DIRS.some(dir => f.startsWith(dir)))
    .filter(f => !EXCLUDE_FILES.includes(f));

  if (relevant.length === 0) {
    console.log('[auto-devlog] AI Capitalのソースコードに関わる変更なし — スキップ');
    return;
  }

  const diffText = getDiffText(hash, relevant);
  const { classify, CORE_FILES } = require('../lib/changeClassifier');
  const { type: typeKey, rule } = classify({
    files: relevant,
    fileStatus,
    diffText,
    subject: meta.subject,
    body: meta.body,
  });

  const development = require('../agents/development');
  const isMajor  = typeKey !== 'OTHER';
  const category = isMajor ? development.MAJOR_EVENT_TYPES[typeKey] : 'OTHER';
  const touchesCore = relevant.some(f => CORE_FILES.has(f));
  const { deleted } = getNumstat(hash, relevant);

  const systemVersion = require('../lib/systemVersion');
  const changelog      = require('../lib/changelog');

  let versionDisplay = systemVersion.getVersion().display;
  const breaking = isMajor
    && ['PHILOSOPHY', 'RULE_ENGINE', 'EVAL_LOGIC', 'MAJOR_BUGFIX'].includes(typeKey)
    && touchesCore
    && deleted >= 3;

  if (isMajor) {
    const bump = systemVersion.bumpMinor(meta.subject);
    versionDisplay = bump.next.display;
    changelog.appendEntry({
      version: bump.next.display,
      date:    meta.date,
      title:   meta.subject,
      type:    category,
    });
    console.log(`[auto-devlog] バージョン更新: ${bump.previous.display} → ${bump.next.display}（${VERSION_FILE} / ${CHANGELOG_FILE} 反映済み）`);

    const AUTO_COMMIT = process.env.AUTO_COMMIT === 'true';

    if (AUTO_COMMIT) {
      // 将来の完全無人運転向けオプション機能。AUTO_COMMIT=true の時のみ、
      // VERSION_FILE / CHANGELOG_FILE の2ファイルだけを対象に自動コミットする。
      // この2ファイルは EXCLUDE_FILES / ルート直下のためrelevant判定に含まれず、
      // このコミット自体がフックを再誘発しても main() は即スキップする（無限ループにならない）。
      try {
        git(['add', VERSION_FILE, CHANGELOG_FILE]);
        git(['commit', '-m',
          `chore(auto): ${bump.next.display} — ${meta.subject}\n\n` +
          `scripts/auto-devlog.js による自動コミット（AUTO_COMMIT=true / development_logs自動検出）。\n` +
          `対象コミット: ${meta.hash}`]);
        console.log(`[auto-devlog] AUTO_COMMIT=true のためバージョン更新を自動コミットしました (${bump.next.display})`);
      } catch (e) {
        console.warn(`[auto-devlog] 自動コミットに失敗（${VERSION_FILE}/${CHANGELOG_FILE}はローカルに変更済み・手動コミットが必要）: ${e.message}`);
      }
    } else {
      // 通常運用（デフォルト）: コミットはしない。人が確認してコミットする前提で、
      // git status確認と「コミット可能です」通知までを行う。
      let statusOut = '(git status取得失敗)';
      try {
        statusOut = git(['status', '--short', VERSION_FILE, CHANGELOG_FILE]).trim() || '(差分なし)';
      } catch (e) {
        statusOut = `(git status取得失敗: ${e.message})`;
      }
      console.log([
        '',
        '========================================',
        '[auto-devlog] ★ コミット可能です ★',
        `  変更: ${bump.previous.display} → ${bump.next.display}（${category}: ${meta.subject}）`,
        `  対象ファイル: ${VERSION_FILE}, ${CHANGELOG_FILE}`,
        '  git status:',
        ...statusOut.split('\n').map(l => `    ${l}`),
        '  次のコマンドでコミットしてください（AI-Capital-v2/がリポジトリルート相対パス）:',
        `    git add AI-Capital-v2/${VERSION_FILE} AI-Capital-v2/${CHANGELOG_FILE}`,
        `    git commit -m "chore: ${bump.next.display} — ${meta.subject}"`,
        '========================================',
        '',
      ].join('\n'));
    }
  }

  const impact = !isMajor ? 'low' : (touchesCore ? 'high' : 'medium');
  const affectedFiles = relevant.length > 10
    ? relevant.slice(0, 10).join(', ') + ` 他${relevant.length - 10}件`
    : relevant.join(', ');

  try {
    await development.saveDevelopmentLog({
      type:            category,
      title:           meta.subject || '(無題のコミット)',
      summary:         meta.body || meta.subject,
      affected_files:  affectedFiles,
      reason:          meta.body || `[自動検出] ${rule}`,
      impact,
      breaking_change: breaking,
      version:         versionDisplay,
      status:          development.STATUS.AUTO_DETECTED,
    }, meta.date);
    console.log(`[auto-devlog] ${meta.hash.slice(0, 7)} → type=${category}${isMajor ? ` version=${versionDisplay}` : ''}`);
  } catch (e) {
    console.warn(`[auto-devlog] development_logs書き込み失敗（バージョン/CHANGELOGは既にローカル反映済み）: ${e.message}`);
  }
}

main().catch(e => {
  console.warn(`[auto-devlog] 失敗（コミット自体には影響しません）: ${e.stack || e.message}`);
});
