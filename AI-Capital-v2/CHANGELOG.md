# AI Capital Changelog

AI Capitalの開発履歴。development_logsで自動検出された重大変更のみを記録する（新しい順）。

## v2.19 (2026-11-06)
- feat(ai-capital-v2): 現金比率10〜20%帯の小口買付を導入（通常¥10,000／強根拠¥30,000・アオイの買い票に条件付き許可・現金フロア後に小口キャップ）（Rule Engine変更）

## v2.18 (2026-11-06)
- feat(ai-capital-v2): 日刊末尾に特別号アーカイブ案内を追加＋Rule 43/28の誤検出・重複を修正（重大バグ修正）

## v2.17 (2026-11-05)
- fix(ai-capital-v2): 自由文判定ルールの誤検出を共通ヘルパーで抑制（Rule 11/12/20/22/24/25/39/43）（Validator追加）

## v2.16 (2026-09-08)
- fix(ai-capital-v2): 財前ミナ記事デビュー初回(2026-09-08)の公開ブロック4件を修正（重大バグ修正）

## v2.15 (2026-09-07)
- feat(ai-capital-v2): 財務戦略部（財前ミナ）を日刊記事に登場させる（Validator追加）

## v2.14 (2026-09-07)
- feat(ai-capital-v2): 買い側キャッシュフロアを導入（暴落逆張り用の資金余力を残す）（Rule Engine変更）

## v2.13 (2026-08-25)
- fix(ai-capital-v2): 日刊記事が数日連続で公開に至らなかった5件の不具合を修正（重大バグ修正）

## v2.12 (2026-08-25)
- @ fix(ai-capital-v2): 日刊記事が数日連続で公開に至らなかった5件の不具合を修正（重大バグ修正）

## v2.11 (2026-08-14)
- fix(ai-capital-v2): 記事生成パイプラインのstale heartbeat/DNS障害/Rule28重複/グラフ埋め込み検証を修正（大型イベント）

## v2.10 (2026-08-13)
- fix(article): 部署判断→記事→最終判断の整合性トレーサビリティを修復（重大バグ修正）

## v2.9 (2026-08-09)
- phase3: apply article autonomous validation and fail logging（Validator追加）

## v2.8 (2026-08-08)
- feat(article): v2.7 記事生成品質改善（Rule Engine透明性・候補整合・週次評価の過程化）（重大バグ修正）

## v2.7 (2026-08-05)
- fix(article): 記事のストーリー性・整合性を改善(候補3カテゴリ欠落/結論先出し/審査部論理/最終判断構成/秘書室長テンプレ化)（重大バグ修正）

## v2.6 (2026-08-01)
- feat(decision): add Observation Candidate Filter for long-term asset preference（Rule Engine変更）

## v2.5 (2026-08-01)
- feat(decision): add secretary tie-break for 2-2 department votes（Rule Engine変更）

## v2.4 (2026-08-01)
- feat(decision): add WAIT-avoidance observation-position override（Rule Engine変更）

## v2.3 (2026-07-29)
- feat: add Core asset category bonus and category-grouped candidate display（Rule Engine変更）

## v2.2 (2026-07-28)
- feat: add candidate balance adjustment to reduce repetitive asset selection（Rule Engine変更）

## v2.1 (2026-07-27)
- AI Capital v2: 週次テンプレート化・記事品質Phase1-5・Rule12誤検知修正をまとめてコミット（投資哲学変更）
