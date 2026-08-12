# Investment Command Center (v1)

AI Capital v2 の状態を閲覧するための、個人専用・非公開の読み取り専用ダッシュボード。
AI-Capital-v2 本体（Discordボット・スケジューラ・既存GASプロジェクト）とは完全に独立しており、
本体側のコードは一切変更しない前提で追加された。

## 構成

```
investment-command-center/
├── gas-readonly/            読み取り専用GAS Web API（AI-Capital-v2本体とは別の新規スタンドアロンApps Scriptプロジェクト）
│   ├── gas-v2-readonly.gs   本体（doPost未実装、書き込み系関数なし）
│   ├── appsscript.json      マニフェスト（timeZone/webapp設定）
│   └── .clasp.json          clasp設定（scriptId）
└── web/                     フロントエンド（静的ページ、ローカルで直接開く運用）
    ├── index.html
    ├── styles.css
    ├── app.js
    ├── config.js            実際のURL・APIキーを格納。.gitignore対象（git管理外）
    └── config.example.js    config.jsのテンプレート（秘密情報なし）
```

## デプロイ情報

- 参照スプレッドシート: AI Capital v2 本体と同一（`SpreadsheetApp.openById()`で読み取り専用オープン）
- Apps Script プロジェクト: 新規スタンドアロン（AI-Capital-v2本体の`gas-v2.gs`プロジェクトとは別物）
  - Script ID: `1KedpTCi_FWtLYWHummHu4OCA0KXeZ0zK7IuNeO4NoinV0B3dQNp2B9mF`
  - Web App URL: `https://script.google.com/macros/s/AKfycbzgvihKV8u3Q_nzRTB3LVfjSwlKOzThW2m-AD56Da2IjJI0UGPbmi8yqJVTvt2VanpE/exec`
  - デプロイ設定: 実行ユーザー=自分（USER_DEPLOYING） / アクセス=全員・匿名含む（ANYONE_ANONYMOUS）
  - バージョン: 1

## セキュリティ設計

- `doPost` は未実装。`setValue`/`setValues`/`appendRow`/`deleteRow`/`clearContents`/`clear`/`deleteSheet`/`insertSheet`等、シートを変更しうる関数は一切呼び出していない（監査済み）
- クライアントから任意のシート名を受け取らない。`type`クエリパラメータのホワイトリスト方式で固定シートにのみアクセス
- `API_KEY`はスクリプトプロパティ（PropertiesService）に保存。ソースコードにハードコードしていない
- `API_KEY`未設定時はデフォルトで全リクエストを拒否（安全側デフォルト）
- `CacheService`で5分キャッシュ。`type`ごとに実際に使用するパラメータのみをキャッシュキーに含め、無関係なクエリパラメータを付与してもキャッシュを回避できない設計
- `web/config.js`に実キーを保存し`.gitignore`で除外。フロントエンドは個人専用・非公開運用（ローカルファイルとして直接開く。公開Webホスティングはしない）
- 発注・データ変更機能はCommand Center側に一切存在しない（完全閲覧専用）

## APIエンドポイント（`?type=`）

| type | 補助パラメータ | 内容 |
|---|---|---|
| dashboard | なし | market/portfolio/positions/decision/votes/candidatesをまとめて返す |
| market | なし | 最新の市況（Fear&Greed/VIX/指数等） |
| portfolio | なし | 資産サマリー（positions_json/pending_json展開済み） |
| positions | なし | 保有銘柄一覧 |
| votes | date（省略時は最新） | 部署投票 |
| decision | date（省略時は最新） | 最終判断 |
| candidates | date（省略時は最新） | 候補銘柄ランキング |
| orders | limit（既定20・上限100） | 発注履歴 |
| capital | なし | 資金イベント履歴・累計元本 |
| history | series=portfolio\|market_snapshot, days（既定90・上限365） | 時系列データ |

## セットアップ（新しい端末で使う場合）

1. `web/config.example.js` を `web/config.js` としてコピー
2. `GAS_URL`・`API_KEY`を実際の値に書き換え（値はこのファイルではなく別途安全な手段で管理者本人が把握しておくこと）
3. `web/index.html` をブラウザで直接開く

## 運用ルール

- `gas-readonly/`はAI-Capital-v2本体・既存GASプロジェクトから完全独立。本体のコード変更・再デプロイをここから行うことはない
- `config.js`を公開・共有・コミットしないこと
- 本Command Centerは閲覧専用。発注や既存スプレッドシートの更新は行わない

## QA履歴（2026-08-12）

- ReadOnly API 全エンドポイント（dashboard/market/portfolio/positions/votes/decision/candidates/orders/capital/history）のGETテスト、認証（キーなし/不正キー/不正type/不正series）、limit/days境界値、キャッシュキーのスコープ検証 → 全てPASS
- フロントエンド総合QA（初期表示・セクション照合・シグナル色分け・ORDERS/HISTORY開閉・Refresh・エラー耐性・レスポンシブ3幅・セキュリティ・ネットワーク） → 41項目中41 PASS
- 途中発見した「FINAL DECISION/DEPARTMENT MEETINGのシグナル別ドット色が反映されない」不具合は`styles.css`のみの修正（`.dept-dot`定義順の入れ替え、`.sig-*`は無変更）で解消し、Playwrightで5シグナル×2箇所を実測確認済み

**v1として凍結。**

## v1.1 改善候補（未実装・記録のみ）

- **ORDERS/HISTORYのローディング表示・タイムアウト表示**
  - 背景: GAS側インフラの一時的な遅延により、まれに30秒以上応答が返らないケースをQA中に観測（直後の再試行では1〜2秒に回復する一過性の事象）。現状のUIには「取得中」を示す表示がなく、遅延時にユーザーが「動作していない」と誤解する可能性がある
  - 対応案（次フェーズ）: ORDERS/HISTORY展開時に読み込み中インジケータを表示し、一定時間（例: 20秒程度）応答がない場合はタイムアウトメッセージを表示する
