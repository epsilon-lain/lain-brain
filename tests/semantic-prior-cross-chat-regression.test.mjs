// ── M2B.5 cross-chat memory regression: 蓝璃 survives Clear Chat ────────
//
// Reproduces the deployed dev-vault failure offline (no provider calls):
//   user statements create a semantic experience -> persistence completes
//   -> Clear Chat -> new foreground query must still retrieve the prior.
//
// Also covers the adversarial ordering that caused the real failure: when
// more historical episodes are retrieved than the materialization quota
// admits, the quota must keep the MOST RELEVANT episodes, not the ones
// whose ids happen to sort first (bounded-activation traversal orders
// seed targets by target key, not by retrieval relevance).
//
// And the realistic fast-clear case: Clear Chat immediately after the
// assistant response must not silently discard a semantic experience that
// is already eligible to be persisted.
// ────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: [
      "export { LainBrainSession } from './src/LainBrainSession';",
      "export { migrateSemanticPriorState } from './src/SemanticPrior';",
      "export { createSemanticSpec } from './src/SemanticSpec';",
      "export { createNormalChatSystemPrompt } from './src/DeepSeekClient';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "cross-chat-regression-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  write: false,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian",
        namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: [
          "exports.normalizePath = (value) => value;",
          "exports.requestUrl = async () => { throw new Error('Unexpected network request'); };",
          "exports.Plugin = class {};",
          "exports.WorkspaceLeaf = class {};",
          "exports.Modal = class { constructor(){} open(){} close(){} };",
          "exports.setIcon = () => {};"
        ].join("\n")
      }));
    }
  }]
});

const mod = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  DOMMatrix: class { constructor(){} },
  module: mod,
  exports: mod.exports,
  require,
  console,
  URL,
  crypto: { randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout,
  Promise
});

const {
  LainBrainSession,
  migrateSemanticPriorState,
  createSemanticSpec,
  createNormalChatSystemPrompt
} = mod.exports;

const M1 = "在这个测试里，蓝璃是 lain 给一把虚构钥匙起的名字";
const M3 = "蓝璃对 lain 来说代表“离开封闭系统”，不是用来开门的";
const M7 = "刚才那个代表“离开封闭系统”的东西叫什么？";

// ── Test Helpers ────────────────────────────────────────────────────────

function makeApp() {
  return {
    vault: {
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null,
      getFileByPath: () => null,
      getFolderByPath: () => null,
      cachedRead: async () => "",
      create: async () => ({}),
      modify: async () => {},
      trash: async () => {},
      createFolder: async () => {}
    },
    workspace: {
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
      getLeaf: () => null,
      getLeavesOfType: () => [],
      revealLeaf: async () => {},
      on: () => ({})
    },
    metadataCache: {
      on: () => ({})
    }
  };
}

function keySurfaceFor(text) {
  if (text.includes("蓝璃是") || text.includes("起的名字")) {
    return "蓝璃";
  }
  if (text.includes("离开封闭系统")) {
    return "离开封闭系统";
  }
  const cjk = text.match(/[一-鿿㐀-䶿]{2,}/);
  return cjk ? cjk[0] : text.slice(0, 10);
}

function buildStubSpec(request) {
  const evidence = request.userEvidence;
  return createSemanticSpec({
    claimId: request.semanticSessionId,
    sourceRefs: evidence.map((e, i) => ({
      id: `sr-${i + 1}`,
      messageId: e.messageId,
      snapshot: e.text
    })),
    symbols: evidence.map((item, index) => ({
      id: `sym-${index + 1}`,
      surface: keySurfaceFor(item.text),
      role: "concept",
      userDefined: true,
      sourceRefIds: [`sr-${index + 1}`]
    })),
    expressions: evidence.map((_, index) => ({
      id: `expr-${index + 1}`,
      kind: "symbol_ref",
      symbolId: `sym-${index + 1}`
    })),
    statements: evidence.map((_, index) => ({
      id: `stmt-${index + 1}`,
      kind: "assertion",
      exprId: `expr-${index + 1}`
    })),
    ambiguities: []
  });
}

function createTestSession() {
  const capturedCalls = [];
  const askText = async (
    apiKey, conversationHistory, noteContext, semanticPriorContext, foregroundContext
  ) => {
    const systemPrompt = createNormalChatSystemPrompt(
      noteContext, semanticPriorContext, foregroundContext
    );
    capturedCalls.push({
      systemPrompt,
      semanticPriorContext,
      foregroundContext,
      conversationHistory
    });
    return "mock assistant response";
  };

  const session = new LainBrainSession(
    makeApp(),
    () => "mock-api-key",
    () => null,
    undefined,
    askText,
    async () => [],
    async () => ({ error: "not_mathematical" })
  );

  session.setChatSemanticAnalyzer(async (apiKey, request) =>
    buildStubSpec(request));

  return { session, capturedCalls };
}

async function sendAndWait(session, text) {
  session.setDraft(text);
  const result = await session.send();
  await session.waitForChatSemanticShadow();
  return result;
}

/**
 * A historical episode whose anchors weakly overlap the follow-up query so
 * retrieval admits it, but whose id sorts BEFORE the live 蓝璃 episode ids.
 * The real failure dropped the relevant episode because the materialization
 * quota admitted episodes by id order instead of retrieval relevance.
 */
function distractorEpisode(id, createdAt) {
  return {
    id,
    createdAt,
    evidenceRefs: [{
      sourceKind: "message_span",
      messageId: `dm-${id}`,
      snapshot: "什么东西",
      actor: "user"
    }],
    anchors: ["什么", "东西"],
    semanticSpec: {
      id: `spec-${id}`,
      schemaVersion: 1,
      claimId: `claim-${id}`,
      sourceRefs: [],
      symbols: [],
      expressions: [],
      statements: [],
      ambiguities: [],
      analysisStatus: "ready_for_review",
      reviewStatus: "pending",
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z"
    },
    semanticSessionId: `session-${id}`,
    semanticRevision: 1
  };
}

function plainClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ═════════════════════════════════════════════════════════════════════════
// TEST 1 — cross-chat: 蓝璃 experience survives Clear Chat and is
//          retrieved, even when irrelevant episodes sort first by id
// ═════════════════════════════════════════════════════════════════════════

{
  const { session, capturedCalls } = createTestSession();

  // User statements create the 蓝璃 semantic experience.
  await sendAndWait(session, M1);
  await sendAndWait(session, M3);
  assert.equal(session.getSemanticPriorEpisodeCount(), 2,
    "both turns must persist their episodes");

  // Re-seat the state: keep the two live episodes (ids rewritten to sort
  // LAST) and prepend three irrelevant episodes whose ids sort FIRST.
  // All three distractors are retrieved for the follow-up query (weak
  // anchor overlap) so they compete for the materialization quota.
  const liveEpisodes = session.getSemanticPriorEpisodes().map((ep, i) => ({
    ...plainClone(ep),
    id: `spe-zzz-live-${i + 1}`
  }));
  session.setSemanticPriorState(migrateSemanticPriorState({
    schemaVersion: 1,
    episodes: [
      distractorEpisode("spe-aaa-distractor-1", 1000),
      distractorEpisode("spe-aaa-distractor-2", 1001),
      distractorEpisode("spe-aaa-distractor-3", 1002),
      ...liveEpisodes
    ]
  }));
  assert.equal(session.getSemanticPriorEpisodeCount(), 5);

  // Clear Chat — conversational state resets, prior state must survive.
  session.clearChat();
  assert.equal(session.getSemanticPriorEpisodeCount(), 5,
    "clearChat must never erase persisted prior episodes");
  assert.equal(session.getConversationHistory().length, 0,
    "clearChat must clear the transcript");

  // New foreground query in the cleared session.
  await sendAndWait(session, M7);

  const call = capturedCalls[capturedCalls.length - 1];
  const systemPrompt = call.systemPrompt;
  assert.equal(call.conversationHistory.length, 1,
    "cleared session sends only the current exchange as history");
  assert.ok(systemPrompt.includes("蓝璃"),
    "the model-facing prompt must contain the retrieved 蓝璃 prior");
  assert.ok(
    systemPrompt.includes("蓝璃对 lain 来说代表") ||
    systemPrompt.includes("蓝璃是 lain 给一把虚构钥匙起的名字"),
    "the model-facing prompt must contain the user evidence that defines 蓝璃"
  );
  assert.ok(systemPrompt.includes("离开封闭系统"),
    "the model-facing prompt must contain the 离开封闭系统 concept");
}

// ═════════════════════════════════════════════════════════════════════════
// TEST 2 — fast clear: Clear Chat immediately after the assistant response
//          must not discard a semantic experience eligible for persistence
// ═════════════════════════════════════════════════════════════════════════

{
  const capturedCalls = [];
  const askText = async (
    apiKey, conversationHistory, noteContext, semanticPriorContext, foregroundContext
  ) => {
    const systemPrompt = createNormalChatSystemPrompt(
      noteContext, semanticPriorContext, foregroundContext
    );
    capturedCalls.push({
      systemPrompt,
      semanticPriorContext,
      foregroundContext
    });
    return "mock assistant response";
  };
  const session = new LainBrainSession(
    makeApp(),
    () => "mock-api-key",
    () => null,
    undefined,
    askText,
    async () => [],
    async () => ({ error: "not_mathematical" })
  );

  let analyzeResolver = null;
  let holdFirst = true;
  session.setChatSemanticAnalyzer(async (apiKey, request) => {
    if (holdFirst) {
      await new Promise((resolve) => { analyzeResolver = resolve; });
    }
    return buildStubSpec(request);
  });

  // Send; the shadow analysis is held in flight while we clear.
  session.setDraft(M3);
  await session.send();
  session.clearChat();
  assert.equal(session.getSemanticPriorEpisodeCount(), 0,
    "nothing persisted yet while the analysis is in flight");
  holdFirst = false;
  analyzeResolver();
  analyzeResolver = null;
  await session.waitForChatSemanticShadow();

  assert.equal(session.getSemanticPriorEpisodeCount(), 1,
    "fast clear must not discard a semantic experience that was already eligible to be persisted");

  // The follow-up query in the cleared session must retrieve the survivor.
  await sendAndWait(session, M7);
  const call = capturedCalls[capturedCalls.length - 1];
  assert.ok(call.systemPrompt.includes("蓝璃"),
    "the prior that survived the fast clear must be retrieved for the new query");
  assert.ok(call.systemPrompt.includes("离开封闭系统"),
    "the retrieved prior must carry the 离开封闭系统 meaning");
}

console.log("SEMANTIC-PRIOR-CROSS-CHAT-REGRESSION PASS");
