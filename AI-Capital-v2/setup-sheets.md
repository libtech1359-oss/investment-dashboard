# AI Capital Database — Googleスプレッドシート セットアップ手順

## 1. スプレッドシート作成

Googleドライブで新規スプレッドシートを作成:
**ファイル名**: `AI Capital Database`

以下の7シートを作成し、1行目にヘッダーを入力する。

### market_data
```
date | fear_greed | vix | sp500 | nasdaq100 | sox | gold | usdjpy
```

### candidate_assets
```
date | asset_name | category | ath_gap_pct | daily_change_pct | score | rank
```

### portfolio_status
```
date | total_assets | cash | invested | unrealized_pl | cash_ratio
```
※ 管理者が定期的に手動更新（または既存GASスクリプトから自動更新）

### orders
```
order_id | date | asset_name | amount | status
```
status値: pending / ordered / filled / cancelled / sold

### positions
```
asset_name | quantity | cost_basis | market_value | unrealized_pl | ath_gap_pct | daily_change_pct | category
```
※ 管理者が定期的に手動更新
ath_gap_pct: 現在価格とATHの乖離率（例: -15.3）
daily_change_pct: 前日比（例: -0.8）

### agent_votes
```
date | department | signal | confidence | comment
```
signal値: BUY / ACCUMULATE / WAIT / DEFEND / SELL

### final_decisions
```
date | final_signal | target_asset | amount | reason
```

---

## 2. Google Cloud Console — サービスアカウント作成

1. https://console.cloud.google.com/ を開く
2. プロジェクトを作成（または既存プロジェクトを選択）
3. 「APIとサービス」→「ライブラリ」→「Google Sheets API」を有効化
4. 「APIとサービス」→「認証情報」→「サービスアカウントを作成」
   - 名前: `ai-capital-v2`
5. 作成したサービスアカウントの「キー」タブ → 「新しいキーを追加」→ JSON
6. ダウンロードした JSON ファイルを `AI-Capital-v2/google-credentials.json` として保存

---

## 3. スプレッドシートへ共有

サービスアカウントのメールアドレス（例: `ai-capital-v2@xxx.iam.gserviceaccount.com`）を
スプレッドシートの「共有」に追加する。
権限: **編集者**

---

## 4. .env 設定

```
GOOGLE_SHEET_ID=（スプレッドシートURLの /d/ と /edit の間のID）
GOOGLE_CREDENTIALS_PATH=./google-credentials.json
```

---

## 5. インストール・起動

```bash
cd AI-Capital-v2
npm install
node register.js    # Discord スラッシュコマンド登録（初回のみ）
node index.js       # 起動
```

---

## 6. 動作確認

Discordで `/v2-run` を実行すると以下の順序で処理が走る:
1. market_data シートへ今日の市場データ書き込み
2. 各部署（market/portfolio/risk）が投票 → agent_votes へ書き込み
3. signalAggregator が機械判定 → final_decisions へ書き込み
4. 発注が必要なら orders へ記録
5. publisher が note記事・X投稿を生成

---

## 7. 移行条件（v1 → v2）

v2が7日間安定稼働した後に移行する。
移行前に以下をv2 Sheetsへ転記:
- 買付履歴 → orders シート
- 保有銘柄 → positions シート
- ファンド残高 → portfolio_status シート
