'use strict';

const { ask }                  = require('./lib/ollama');
const { buildContext }         = require('./lib/data');
const logger                   = require('./lib/logger');
const { writeLog, writeError } = require('./core/logger');
const memory                   = require('./lib/memory');
const audit                    = require('./agents/audit');
const devil                    = require('./agents/devil');
const taskStore                = require('./lib/taskStore');

// 部署一覧 ── 新規部署追加時はここに追加するだけ
const AGENTS = [
  require('./agents/market'),
  require('./agents/portfolio'),
  require('./agents/risk'),
];

// 日本語部署名 → タスクドキュメントのキー
const DEPT_KEY = {
  'マーケット分析部':     'market',
  'ポートフォリオ管理部': 'portfolio',
  'リスク管理部':         'risk',
  '反対意見部':           'devil',
  '監査部':               'audit',
};

// ── システムプロンプト ──────────────────────────────────────

const DECOMPOSE_SYSTEM = `
あなたはAI投資法人「AI Capital」の秘書室長です。

CEOからの指示と、以下に示すリアルタイムの投資データを受け取ります。
各部署（マーケット分析・ポートフォリオ管理・リスク管理）が分析しやすいよう、
データと指示を組み合わせた共通ブリーフィング文（300字以内）を作成してください。

出力はブリーフィング文のみ。説明不要。
`.trim();

const SYNTHESIZE_SYSTEM = `
あなたはAI投資法人「AI Capital」の秘書室長です。

各部署（マーケット・ポートフォリオ・リスク・反対意見・監査）からの報告を統合し、
CEOへの最終レポートを作成してください。

【出力形式】
## 📊 AI Capital 投資レポート

### 各部署サマリー
（各部署の要点を1〜2文で整理）

### 🔴 反対意見部が指摘した主なリスク
（Devil's Advocateの論点を簡潔に）

### 🎯 統合判断
（強気分析 vs 反対意見を踏まえた最終的な推奨アクション。リスクを認識した上での判断を示す）
`.trim();

// ── メイン処理 ─────────────────────────────────────────────

async function handle(instruction, taskId = null) {
  const session = logger.start(instruction, taskId);
  writeLog('secretary', `CEO指示受信: ${instruction}`, taskId);

  try {
    // Step 1: リアルデータ取得 + 長期記憶を結合
    writeLog('secretary', 'データ取得・記憶参照開始', taskId);
    const t0Data     = Date.now();
    const realData   = await buildContext();
    const memoryCtx  = memory.buildMemoryContext();
    const fullContext = memoryCtx
      ? `${memoryCtx}\n\n--- リアルタイムデータ ---\n${realData}`
      : realData;
    session.dataFetch(fullContext);
    memory.saveMemory('ceo_instruction', instruction);

    // Step 2: タスク分解
    writeLog('secretary', 'タスク分解開始', taskId);
    const t0Brief = Date.now();
    const briefing = await ask(
      DECOMPOSE_SYSTEM,
      `CEO指示: ${instruction}\n\n${fullContext}`
    );
    session.decompose(briefing);
    writeLog('secretary', `タスク分解完了: ${briefing.slice(0, 80)}…`, taskId);

    taskStore.patch(taskId, {
      secretary: {
        instruction,
        briefing,
        elapsedMs: Date.now() - t0Data,
      },
    });

    // Step 3: 全部署を並列実行
    writeLog('secretary', '全部署へ指示（並列実行）', taskId);
    const results = await Promise.all(
      AGENTS.map(async agent => {
        const t0     = Date.now();
        const result = await agent.analyze(briefing);
        const elapsedMs = Date.now() - t0;
        session.agent(result.dept, briefing, result.content, elapsedMs);
        memory.saveMemory(result.dept, result.content.slice(0, 200));

        const key = DEPT_KEY[result.dept];
        if (key) taskStore.patch(taskId, { [key]: { content: result.content, elapsedMs } });

        return result;
      })
    );

    // Step 3.5: 反対意見部（3部署の報告を見てから反論）
    writeLog('secretary', '反対意見部 分析開始', taskId);
    const t0Devil = Date.now();
    const devilResult = await devil.analyze(briefing, results);
    const devilElapsed = Date.now() - t0Devil;
    session.agent(devilResult.dept, briefing, devilResult.content, devilElapsed);
    memory.saveMemory(devilResult.dept, devilResult.content.slice(0, 200));
    taskStore.patch(taskId, { devil: { content: devilResult.content, elapsedMs: devilElapsed } });

    // 全部署結果（devil含む）
    const allResults = [...results, devilResult];

    // Step 4: 監査（全部署の結果を受けて直列実行）
    writeLog('secretary', '監査部レビュー開始', taskId);
    const t0Audit = Date.now();
    const policiesText = memory.getPolicies()
      .map(p => `・[${p.category}] ${p.content}`)
      .join('\n');
    const auditResult = await audit.review(briefing, allResults, policiesText);
    session.agent('監査部', briefing, auditResult.content, 0);
    memory.saveMemory('audit', `${auditResult.verdict}: ${auditResult.content.slice(0, 150)}`);

    taskStore.patch(taskId, {
      audit: {
        content: auditResult.content,
        verdict: auditResult.verdict,
        elapsedMs: Date.now() - t0Audit,
      },
    });

    if (auditResult.verdict === '要見直し') {
      writeError('secretary', new Error(`監査 要見直し: ${auditResult.content.slice(0, 200)}`), taskId);
    }

    // Step 5: 統合レポート（監査結果を含める）
    writeLog('secretary', '統合レポート生成開始', taskId);
    const reportsText = [
      ...allResults.map(r => `【${r.dept}】\n${r.content}`),
      `【${auditResult.dept}】\n${auditResult.content}`,
    ].join('\n\n');

    const report = await ask(
      SYNTHESIZE_SYSTEM,
      `CEO指示: ${instruction}\n\n${reportsText}`,
      { num_predict: 1000 }
    );
    session.synthesize(report);

    // 判断を長期記憶に保存
    const summary = report.replace(/#+\s*/g, '').slice(0, 150).trim();
    const decisionResult = memory.saveDecision(session.id, instruction, summary);
    const decisionId = decisionResult?.lastInsertRowid || null;
    writeLog('secretary', `完了 → ${summary.slice(0, 60)}…`, taskId);

    taskStore.patch(taskId, {
      final_report: report,
      status:       'completed',
      completedAt:  new Date().toISOString(),
      decisionId,
    });

    return report;

  } catch (err) {
    writeError('secretary', err, taskId);
    session.setError(err);
    taskStore.patch(taskId, { status: 'error', completedAt: new Date().toISOString() });
    throw err;

  } finally {
    session.finish();
  }
}

module.exports = { handle };
