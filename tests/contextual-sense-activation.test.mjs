// ── M2B.6a-v0 — contextual sense activation + runtime integration ──────
//
// Covers (design §13.6):
//   B. authority/relevance separation (authority contributes zero score)
//   C. mirai scenarios A1–A4
//   D. session-direction lifetime
//   E. X/蓝璃 identity safety (mandatory)
//   F. fail-safe degradation
//   G. serialization invariant (nothing transient is persisted)
// All provider-dependent pieces are stubbed; no network calls.
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
      "export { createNormalChatSystemPrompt } from './src/DeepSeekClient';",
      "export { createSemanticSpec } from './src/SemanticSpec';",
      "export { createConceptNode, updateConceptNode } from './src/BrainGrowth';",
      "export { serializeConceptNodeIntoMarkdown } from './src/BrainGrowthPersistence';",
      "export {",
      "  activateRuntimeSenses,",
      "  detectSessionDirection,",
      "  MIN_CONTEXT_EVIDENCE,",
      "  CLEAR_WIN_MARGIN",
      "} from './src/ContextualSenseActivation';",
      "export {",
      "  projectRuntimeSenseCandidates,",
      "  conceptSurfaces,",
      "  findConceptSurfaceMentions",
      "} from './src/RuntimeSenseProjection';",
      "export { TFile } from 'obsidian';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "activation-entry.ts",
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
          "exports.setIcon = () => {};",
          "exports.TFile = class TFile { constructor(path, extension = 'md') { this.path = path; this.extension = extension; } };",
          "exports.MarkdownView = class MarkdownView {};",
          "exports.parseLinktext = (link) => ({ path: link.split('#')[0], subpath: link.includes('#') ? link.split('#')[1] : '' });"
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
  createNormalChatSystemPrompt,
  createSemanticSpec,
  createConceptNode,
  updateConceptNode,
  serializeConceptNodeIntoMarkdown,
  activateRuntimeSenses,
  detectSessionDirection,
  TFile
} = mod.exports;

const CREATED_AT = "2026-08-27T00:00:00.000Z";

const MIRAI_ASSISTANT =
  "lain 的助手实体，lain 用这个名字指代自己的助手，会回应 lain 的问题";
const MIRAI_FUTURE = "日语里的未来，读作 mirai，意思是 future";

const LANLI_MEANING =
  "蓝璃是 lain 给一把虚构钥匙起的名字，代表离开封闭系统，是某种自由";

// ── Fixtures ────────────────────────────────────────────────────────────

function userDefinition(id, text) {
  return {
    id,
    text,
    sourceRefs: [{
      sourceKind: "user_edit",
      editId: `chat-semantic-confirmation:${id}`,
      snapshot: text,
      actor: "user"
    }]
  };
}

function makeMiraiConcept() {
  const base = createConceptNode({
    id: "concept:mirai",
    title: "mirai",
    createdAt: CREATED_AT
  });
  return updateConceptNode(base, {
    userDefinition: userDefinition("chat-definition:assistant", MIRAI_ASSISTANT),
    userDefinitionMode: "explicit_user_redefinition",
    standardDefinitions: [{
      id: "ext:future",
      text: MIRAI_FUTURE,
      sourceReferences: ["https://example.org/ja-mirai"]
    }]
  }, {
    changedAt: CREATED_AT,
    reason: "mirai fixture"
  });
}

function makeLanliConcept() {
  const base = createConceptNode({
    id: "concept:lanli",
    title: "蓝璃",
    createdAt: CREATED_AT
  });
  return updateConceptNode(base, {
    userDefinition: userDefinition("chat-definition:lanli", LANLI_MEANING),
    userDefinitionMode: "explicit_user_redefinition"
  }, {
    changedAt: CREATED_AT,
    reason: "蓝璃 fixture"
  });
}

function conceptMarkdown(node, readable) {
  return serializeConceptNodeIntoMarkdown(readable, node, {
    candidateId: "test-fixture",
    candidateRevision: 0,
    approvedAt: CREATED_AT
  });
}

function makeVaultApp(conceptEntries) {
  const contentByPath = new Map();
  const files = [];
  for (const { path, markdown } of conceptEntries) {
    contentByPath.set(path, markdown);
    files.push(new TFile(path, "md"));
  }
  const writes = { create: 0, modify: 0, trash: 0, createFolder: 0 };
  return {
    contentByPath,
    writes,
    app: {
      vault: {
        getMarkdownFiles: () => [...files],
        getAbstractFileByPath: (p) =>
          contentByPath.has(p) ? new TFile(p, "md") : null,
        getFileByPath: (p) => (contentByPath.has(p) ? new TFile(p, "md") : null),
        getFolderByPath: () => null,
        cachedRead: async (f) => contentByPath.get(f.path) ?? "",
        create: async () => { writes.create += 1; return {}; },
        modify: async () => { writes.modify += 1; },
        trash: async () => { writes.trash += 1; },
        createFolder: async () => { writes.createFolder += 1; }
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
        on: () => ({}),
        resolvedLinks: {},
        getFileCache: () => null
      }
    }
  };
}

function keySurfaceFor(text) {
  if (text.includes("离开封闭系统")) {
    return "离开封闭系统";
  }
  if (text.includes("自由")) {
    return "自由";
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

function createTestSession(app) {
  const capturedCalls = [];
  const askText = async (
    apiKey, conversationHistory, noteContext, semanticPriorContext,
    foregroundContext, senseContext
  ) => {
    const systemPrompt = createNormalChatSystemPrompt(
      noteContext, semanticPriorContext, foregroundContext, senseContext
    );
    capturedCalls.push({
      systemPrompt,
      semanticPriorContext,
      foregroundContext,
      senseContext,
      conversationHistory
    });
    return "mock assistant response";
  };

  const session = new LainBrainSession(
    app,
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

function lastCall(capturedCalls) {
  return capturedCalls[capturedCalls.length - 1];
}

function senseAnnotationOf(call) {
  return call.senseContext ?? "";
}

// ═════════════════════════════════════════════════════════════════════════
// TEST B — authority/relevance separation (authority contributes zero)
// ═════════════════════════════════════════════════════════════════════════

{
  const candidateA = {
    id: "sense:concept:x:user_confirmed_personal:a",
    conceptId: "concept:x",
    conceptTitle: "x",
    matchedSurface: "x",
    meaning: "lain 的助手实体，会回应 lain 的问题",
    authority: "user_confirmed_personal",
    provenance: { kind: "user_text", refs: [] },
    sourceBucket: "userDefinition"
  };
  const candidateB = {
    id: "sense:concept:x:external_conventional:b",
    conceptId: "concept:x",
    conceptTitle: "x",
    matchedSurface: "x",
    meaning: "日语里的未来，读作 mirai",
    authority: "external_conventional",
    provenance: { kind: "external_source", refs: [] },
    sourceBucket: "standardDefinitions"
  };
  const baseInput = {
    conceptId: "concept:x",
    surface: "mirai",
    conceptSurfaces: ["mirai"],
    utterance: "未来这个词读 mirai 吗",
    priorEpisodes: [],
    sessionDirections: new Map()
  };

  const report = activateRuntimeSenses({
    ...baseInput,
    candidates: [candidateA, candidateB]
  });
  assert.equal(report.resolution, "selected");
  assert.equal(report.selectedSenseId, candidateB.id,
    "stronger contextual evidence must beat stronger authority");

  // Structural proof: swapping authority labels must not change scores.
  const swapped = activateRuntimeSenses({
    ...baseInput,
    candidates: [
      { ...candidateA, authority: "external_conventional" },
      { ...candidateB, authority: "user_confirmed_personal" }
    ]
  });
  const scoreBy = (entries) => Object.fromEntries(
    entries.map((e) => [e.senseId, { score: e.score, fired: e.firedSignals }])
  );
  assert.equal(
    JSON.stringify(scoreBy(swapped.entries)),
    JSON.stringify(scoreBy(report.entries)),
    "authority contributes ZERO to the contextual score"
  );
  assert.equal(swapped.selectedSenseId, candidateB.id);
  assert.equal(
    JSON.stringify(swapped.fallbackOrderSenseIds),
    JSON.stringify([candidateB.id, candidateA.id]),
    "fallback ordering is authority-based (presentation only) and separate"
  );
}

// ═════════════════════════════════════════════════════════════════════════
// TEST C — mirai scenarios (A1–A4)
// ═════════════════════════════════════════════════════════════════════════

{
  const mirai = makeMiraiConcept();
  const markdown = conceptMarkdown(mirai, `# mirai\n\n${MIRAI_ASSISTANT}\n`);
  const vault = makeVaultApp([{ path: "Lain Brain/Notes/mirai.md", markdown }]);
  const { session, capturedCalls } = createTestSession(vault.app);

  const miraiReport = () => {
    const context = session.getLastSenseContext();
    assert.ok(context !== undefined && !context.degraded);
    return context.reports.find((r) => r.conceptId === "concept:mirai");
  };
  const externalId =
    "sense:concept:mirai:external_conventional:ext:future";

  // C1 — "mirai 你觉得这个怎么样" → entity/assistant sense
  await sendAndWait(session, "mirai 你觉得这个怎么样");
  {
    const report = miraiReport();
    assert.equal(report.resolution, "selected");
    assert.notEqual(report.selectedSenseId, externalId);
    const entry = report.entries.find(
      (e) => e.authority === "user_confirmed_personal"
    );
    assert.equal(entry.senseId, report.selectedSenseId);
    assert.ok(entry.firedSignals.includes("co_text_interlocutor"));
    const annotation = senseAnnotationOf(lastCall(capturedCalls));
    assert.ok(
      /lain 的助手实体[\s\S]*current-context: selected/u.test(annotation),
      "assistant sense annotated as selected"
    );
  }

  // C2 — "未来这个词读 mirai 吗" → future sense, without authority scoring
  await sendAndWait(session, "未来这个词读 mirai 吗");
  {
    const report = miraiReport();
    assert.equal(report.resolution, "selected");
    assert.equal(report.selectedSenseId, externalId,
      "external sense wins on lexical/co-text evidence alone");
    const entry = report.entries.find(
      (e) => e.authority === "external_conventional"
    );
    assert.ok(entry.firedSignals.includes("lexical_co_text"));
    assert.equal(entry.score >= 0 && entry.authority === "external_conventional", true);
    const annotation = senseAnnotationOf(lastCall(capturedCalls));
    assert.ok(
      /日语里的未来[\s\S]*current-context: selected/u.test(annotation)
    );
    assert.ok(annotation.includes("authority: external"));
  }

  // C3 — "mirai no mirai" → ambiguous, no mandatory clarification.
  // Run in a FRESH session: in the main session the earlier turns' prior
  // episodes legitimately provide V2 evidence for the recently discussed
  // sense, which is correct v0 behavior but would not exercise ambiguity.
  {
    const fresh = createTestSession(vault.app);
    await sendAndWait(fresh.session, "mirai no mirai");
    const report = fresh.session.getLastSenseContext().reports[0];
    assert.equal(report.resolution, "unresolved");
    assert.equal(report.selectedSenseId, undefined);
    const annotation = senseAnnotationOf(
      lastCall(fresh.capturedCalls)
    );
    assert.ok(
      annotation.includes("unresolved (multiple plausible senses)"),
      "ambiguity is carried, never pretended away"
    );
    assert.ok(!annotation.includes("current-context: selected"));
    // v0 never generates clarification questions on its own.
  }

  // C4 — "我说的 mirai 不是你，是未来" → future via correction; assistant
  // sense is de-ranked but never deleted, and nothing is persisted/mutated.
  await sendAndWait(session, "我说的 mirai 不是你，是未来");
  {
    const report = miraiReport();
    assert.equal(report.resolution, "selected");
    assert.equal(report.selectedSenseId, externalId);
    const assistant = report.entries.find(
      (e) => e.authority === "user_confirmed_personal"
    );
    assert.ok(assistant.firedSignals.includes("correction_rejected"));
    const external = report.entries.find(
      (e) => e.authority === "external_conventional"
    );
    assert.ok(external.firedSignals.includes("correction_named_alternative"));
    const annotation = senseAnnotationOf(lastCall(capturedCalls));
    const assistantLine = annotation.split("\n").find((line) =>
      line.includes("lain 的助手实体")
    );
    assert.ok(assistantLine !== undefined, "rejected candidate still listed");
    assert.ok(!assistantLine.includes("current-context: selected"));
    assert.ok(/日语里的未来[\s\S]*current-context: selected/u.test(annotation));
  }

  // No concept mutation happened across the whole scenario.
  assert.equal(vault.writes.create, 0);
  assert.equal(vault.writes.modify, 0);
  assert.equal(vault.writes.trash, 0);
  assert.equal(
    vault.contentByPath.get("Lain Brain/Notes/mirai.md"),
    markdown,
    "the persisted concept note is byte-identical"
  );
}

// ═════════════════════════════════════════════════════════════════════════
// TEST D — session-direction lifetime
// ═════════════════════════════════════════════════════════════════════════

{
  const mirai = makeMiraiConcept();
  const markdown = conceptMarkdown(mirai, `# mirai\n\n${MIRAI_ASSISTANT}\n`);
  const vault = makeVaultApp([{ path: "Lain Brain/Notes/mirai.md", markdown }]);
  const { session, capturedCalls } = createTestSession(vault.app);
  const externalId = "sense:concept:mirai:external_conventional:ext:future";

  // Direction statement: recorded and applied for this turn.
  await sendAndWait(session, "这里的 mirai 指未来");
  {
    const report = session.getLastSenseContext().reports[0];
    assert.equal(report.resolution, "selected");
    assert.equal(report.selectedSenseId, externalId);
    assert.equal(report.firedDirectionSenseId, externalId);
    assert.ok(
      senseAnnotationOf(lastCall(capturedCalls))
        .includes("current-context: selected (session direction)")
    );
  }

  // The direction dominates a later turn inside the same session even
  // though the interlocutor cue would otherwise favor the assistant.
  await sendAndWait(session, "mirai 你觉得这个怎么样");
  {
    const report = session.getLastSenseContext().reports[0];
    assert.equal(report.selectedSenseId, externalId,
      "session direction dominates inside the session");
    assert.equal(report.firedDirectionSenseId, externalId);
  }

  // Clear Chat: the direction expires with the session.
  session.clearChat();
  assert.equal(session.getLastSenseContext(), undefined,
    "transient sense context cleared with the chat");

  await sendAndWait(session, "mirai 你觉得这个怎么样");
  {
    const report = session.getLastSenseContext().reports[0];
    assert.notEqual(report.selectedSenseId, externalId,
      "after clear, the assistant sense wins again");
    assert.equal(report.firedDirectionSenseId, undefined);
  }
}

// ═════════════════════════════════════════════════════════════════════════
// TEST E — X / 蓝璃 identity safety (MANDATORY)
// ═════════════════════════════════════════════════════════════════════════

{
  const lanli = makeLanliConcept();
  const markdown = conceptMarkdown(lanli, `# 蓝璃\n\n${LANLI_MEANING}\n`);
  const vault = makeVaultApp([{ path: "Lain Brain/Notes/蓝璃.md", markdown }]);
  const { session, capturedCalls } = createTestSession(vault.app);

  // Seed a prior episode about 蓝璃 (freedom-adjacent meaning).
  await sendAndWait(session, "蓝璃对 lain 来说代表离开封闭系统，是某种自由");

  // New statement about a NEW surface that is only similar.
  await sendAndWait(session, "X 对我来说是某种自由");

  const call = lastCall(capturedCalls);
  const annotation = senseAnnotationOf(call);
  const context = session.getLastSenseContext();

  // 蓝璃 may appear as related context, labeled a distinct referent.
  assert.ok(annotation.includes("蓝璃"), "蓝璃 appears as related context");
  assert.ok(
    annotation.includes("related meaning / distinct referent"),
    "related context is labeled distinct referent"
  );
  assert.equal(context.degraded, false);
  assert.equal(context.reports.length, 0,
    "X is not a stored concept — no sense candidates, no identity machinery");
  assert.ok(context.relatedOnlySurfaces.includes("蓝璃"));

  // The model-facing prompt forbids identity inference from similarity.
  assert.ok(
    call.systemPrompt.includes(
      "never infer same object, alias, or coreference"
    ),
    "identity-forbidding policy present in the model-facing prompt"
  );
  assert.ok(
    !annotation.match(/\bsame_as\b|\balias_of\b|\brefers_to\b/u),
    "no generated identity annotation"
  );

  // No mutation: the 蓝璃 ConceptNode is byte-identical, no vault writes.
  assert.equal(vault.writes.create, 0);
  assert.equal(vault.writes.modify, 0);
  assert.equal(vault.writes.trash, 0);
  assert.equal(
    vault.contentByPath.get("Lain Brain/Notes/蓝璃.md"),
    markdown,
    "existing 蓝璃 ConceptNode unchanged"
  );
}

// ═════════════════════════════════════════════════════════════════════════
// TEST F — fail-safe degradation
// ═════════════════════════════════════════════════════════════════════════

{
  // F1 — concept lookup blows up: the send still works, no annotation.
  const empty = makeVaultApp([]);
  const brokenApp = {
    ...empty.app,
    vault: {
      ...empty.app.vault,
      getMarkdownFiles: () => { throw new Error("boom"); }
    }
  };
  {
    const { session, capturedCalls } = createTestSession(brokenApp);
    const result = await sendAndWait(session, "mirai 你觉得这个怎么样");
    assert.equal(result, "sent", "sense-layer failure must not break chat");
    assert.equal(senseAnnotationOf(lastCall(capturedCalls)), "");
    const context = session.getLastSenseContext();
    assert.equal(context.degraded, true);
  }

  // F2 — empty vault (no concepts): current behavior, no annotation, and
  // the existing prior persistence/retrieval path keeps working.
  {
    const { session, capturedCalls } = createTestSession(empty.app);
    await sendAndWait(session, "蓝璃对 lain 来说代表离开封闭系统");
    assert.equal(session.getSemanticPriorEpisodeCount(), 1);
    assert.equal(senseAnnotationOf(lastCall(capturedCalls)), "");

    await sendAndWait(session, "刚才说的蓝璃是什么");
    assert.equal(senseAnnotationOf(lastCall(capturedCalls)), "");
    assert.equal(session.getSemanticPriorEpisodeCount(), 2,
      "existing shadow persistence path unaffected");
  }
}

// ═════════════════════════════════════════════════════════════════════════
// TEST G — serialization invariant
// ═════════════════════════════════════════════════════════════════════════

{
  const mirai = makeMiraiConcept();
  const markdown = conceptMarkdown(mirai, `# mirai\n\n${MIRAI_ASSISTANT}\n`);
  const vault = makeVaultApp([{ path: "Lain Brain/Notes/mirai.md", markdown }]);
  const { session, capturedCalls } = createTestSession(vault.app);

  const persistedSnapshots = [];
  session.setSemanticPriorSaveCallback(() => {
    persistedSnapshots.push(
      JSON.parse(JSON.stringify(session.getSemanticPriorState()))
    );
  });

  await sendAndWait(session, "未来这个词读 mirai 吗");
  const call = lastCall(capturedCalls);

  // The transient sense layer WAS active for this turn…
  assert.ok(senseAnnotationOf(call).includes("current-context: selected"));
  assert.ok(
    session.getLastSenseContext() !== undefined &&
    !session.getLastSenseContext().degraded
  );

  // …but nothing transient leaked into any persisted state snapshot.
  assert.ok(persistedSnapshots.length > 0);
  for (const snapshot of persistedSnapshots) {
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      "current-context",
      "selectedSenseId",
      "firedSignals",
      "extraSeedSurfaces",
      "relatedOnlySurfaces",
      "SenseActivation",
      "session direction"
    ]) {
      assert.ok(
        !serialized.includes(forbidden),
        `persisted state must not contain "${forbidden}"`
      );
    }
  }
}

console.log("CONTEXTUAL-SENSE-ACTIVATION PASS");
