/**
 * config.js のテンプレート（このファイル自体はgit管理対象・秘密情報なし）
 *
 * 使い方:
 *   1. このファイルを同じディレクトリに config.js としてコピーする
 *   2. GAS_URL / API_KEY を実際の値に書き換える
 *   3. config.js は .gitignore 対象のため、git commit されない
 *
 * GAS_URL: investment-command-center/gas-readonly をデプロイした際の
 *          Web App URL（.../macros/s/XXXXX/exec）
 * API_KEY: gas-readonly側スクリプトプロパティに設定したものと同じ値
 *
 * 重要: 本ページは「個人専用・非公開」運用が前提です。
 *       config.js に実キーを書いたこのフォルダを公開Webサーバーに
 *       アップロードしたり、他者と共有したりしないでください。
 */
window.APP_CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',
  API_KEY: 'YOUR_API_KEY_HERE',
};
