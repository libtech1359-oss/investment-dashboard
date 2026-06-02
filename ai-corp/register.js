/**
 * register.js
 * スラッシュコマンドを Discord に登録するスクリプト
 * 初回1回だけ実行すれば OK（コマンド追加・変更時も実行）
 * 実行方法: node register.js
 */

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('❌ .env ファイルに DISCORD_TOKEN / CLIENT_ID / GUILD_ID を設定してください');
  process.exit(1);
}

// ── スラッシュコマンドの定義 ──
const commands = [

  new SlashCommandBuilder()
    .setName('market')
    .setDescription('📊 現在の市場データを確認する（ドル円・NASDAQ・S&P500・ゴールド・BTC・Fear&Greed）'),

  new SlashCommandBuilder()
    .setName('portfolio')
    .setDescription('💼 ポートフォリオの概要を確認する（評価額・含み益・収益率）'),

  new SlashCommandBuilder()
    .setName('trades')
    .setDescription('📝 直近の取引履歴を確認する')
    .addStringOption(opt =>
      opt.setName('口座')
        .setDescription('絞り込む口座（デフォルト: 全口座）')
        .setRequired(false)
        .addChoices(
          { name: '全口座', value: 'all' },
          { name: '特定口座のみ', value: 'tokutei' },
          { name: 'NISA枠のみ（成長・積立）', value: 'nisa' },
        )
    ),

  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('🔍 各銘柄のATH比較と買い判断を表示する'),

  new SlashCommandBuilder()
    .setName('nisa')
    .setDescription('🎯 特定口座から次年度NISA移行候補を表示する')
    .addStringOption(opt =>
      opt.setName('枠')
        .setDescription('移行する NISA 枠の種類')
        .setRequired(false)
        .addChoices(
          { name: '成長投資枠 (上限¥240万)', value: 'growth' },
          { name: 'つみたて投資枠 (上限¥120万)', value: 'tsumitate' },
        )
    ),

  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('📋 現在の投資ルール状態を確認する')
    .addIntegerOption(opt =>
      opt.setName('現金')
        .setDescription('現在の現金残高（円）例: 3500000')
        .setRequired(true)
        .setMinValue(0)
    )
    .addBooleanOption(opt =>
      opt.setName('暴落モード')
        .setDescription('暴落時の特別投資枠を適用するか（デフォルト: OFF）')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('暴落枠使用済み')
        .setDescription('暴落枠のうち既に使った金額（円）例: 500000')
        .setRequired(false)
        .setMinValue(0)
    ),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('🧬 CEOプロファイル（構造化方針）を設定・確認する')
    .addSubcommand(sub =>
      sub.setName('show').setDescription('現在のプロファイルを表示')
    )
    .addSubcommand(sub =>
      sub.setName('set').setDescription('プロファイルの項目を設定する')
        .addStringOption(opt =>
          opt.setName('項目')
            .setDescription('設定する項目')
            .setRequired(true)
            .addChoices(
              { name: 'リスク許容度 (low/medium/high)',            value: 'risk_tolerance'     },
              { name: '投資期間 (short/medium/long)',               value: 'investment_horizon' },
              { name: '優先セクター (例: ["AI","Space"])',          value: 'preferred_sectors'  },
              { name: '除外セクター (例: ["Crypto"])',             value: 'excluded_sectors'   },
              { name: '最大許容下落率% (例: 20)',                   value: 'max_drawdown'       },
              { name: '最低現金残高円 (例: 3000000)',               value: 'cash_reserve_min'   },
              { name: 'VIX上限 (例: 30)',                          value: 'vix_threshold'      },
              { name: 'F&G買いゾーン (例: [0,35])',                value: 'fg_buy_zone'        },
              { name: '月次投資額円 (例: 100000)',                  value: 'monthly_investment' },
            )
        )
        .addStringOption(opt =>
          opt.setName('値')
            .setDescription('設定値（数値・文字列・JSON配列）')
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('remember')
    .setDescription('🧠 CEOの方針・メモを長期記憶に保存する')
    .addStringOption(opt =>
      opt.setName('種類')
        .setDescription('記憶の種類')
        .setRequired(true)
        .addChoices(
          { name: '💼 投資方針',   value: 'investment' },
          { name: '⚠️ リスク方針', value: 'risk'       },
          { name: '📋 一般ルール', value: 'general'    },
          { name: '📝 メモ',       value: 'note'       },
        )
    )
    .addStringOption(opt =>
      opt.setName('内容')
        .setDescription('記憶させる内容 例: VIXが30以上の時は絶対に買わない')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('🧠 長期記憶の一覧を表示する'),

  new SlashCommandBuilder()
    .setName('forget')
    .setDescription('🗑️ 長期記憶から特定の項目を削除する')
    .addStringOption(opt =>
      opt.setName('種類')
        .setDescription('削除する記憶の種類')
        .setRequired(true)
        .addChoices(
          { name: '方針', value: 'policy' },
          { name: '判断履歴', value: 'decision' },
          { name: 'メモ', value: 'note' },
        )
    )
    .addIntegerOption(opt =>
      opt.setName('id')
        .setDescription('/memory で確認した #番号')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('log')
    .setDescription('🔍 AI秘書のログを参照する（どのステップで変な判断をしたか追跡）')
    .addStringOption(opt =>
      opt.setName('ステップ')
        .setDescription('見たいステップ（デフォルト: summary）')
        .setRequired(false)
        .addChoices(
          { name: '📋 概要・所要時間',             value: 'summary'   },
          { name: '📦 取得データ（ポートフォリオ・指数）', value: 'data'      },
          { name: '🔀 タスク分解結果',              value: 'decompose' },
          { name: '🏢 market部の生返答',            value: 'market'    },
          { name: '🏢 portfolio部の生返答',         value: 'portfolio' },
          { name: '🏢 risk部の生返答',              value: 'risk'      },
          { name: '🔍 audit部の監査結果',           value: 'audit'     },
          { name: '📊 最終統合レポート',             value: 'report'    },
        )
    )
    .addIntegerOption(opt =>
      opt.setName('番号')
        .setDescription('今日のログ番号（0始まり、省略で最新）')
        .setRequired(false)
        .setMinValue(0)
    )
    .addStringOption(opt =>
      opt.setName('日付')
        .setDescription('日付指定 例: 2026-05-31（省略で今日）')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('halt')
    .setDescription('🛑 緊急停止: 自動取引・定期実行をすべて即時停止する'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('✅ 再開: 自動取引・定期実行を再開する（確認ボタンあり）'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('📋 現在のシステム状態を確認する（停止中 / 稼働中）'),

  new SlashCommandBuilder()
    .setName('events')
    .setDescription('📋 halt/resume/audit_override のイベント履歴を表示する')
    .addIntegerOption(opt =>
      opt.setName('件数')
        .setDescription('表示する件数（デフォルト: 10）')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(50)
    ),

].map(cmd => cmd.toJSON());

// ── Discord REST API でコマンドを登録 ──
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  console.log('⏳ スラッシュコマンドを登録中...');
  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('✅ コマンド登録完了！Discord で /market などが使えるようになります');
  } catch (err) {
    console.error('❌ コマンド登録失敗:', err.message);
  }
})();
