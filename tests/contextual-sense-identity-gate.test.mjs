// ── M2B.6a-v0 — Identity Evidence Gate regression test ─────────────────
//
// Reproduces the REAL poisoned-history condition of the failed retest:
//
//   Session A (historical): the shadow analyzer persisted a provisional AI
//     hypothesis that the fresh referent "X" most likely refers to 未来:
//       "上下文中最可能指向'未来'或'mirai no mirai'",
//       symbol "待填入具体内容。最自然的候选是'未来'…",
//       ambiguity choice "X 指'未来'…".
//   Session B (retest): after recent mirai/未来 discussion, the user says
//     "X 对我来说是某种自由". Retrieval ranks the poisoned episode and
//     injects its interpretation verbatim as
//     provisional_semantic_interpretation → the model re-generates
//     "X = 未来，对吗？".
//
// Required behavior (Fresh Referent Principle, identity evidence gate):
//   - the old AI hypothesis remains retrievable as provisional context
//   - it is NOT identity-authorized evidence
//   - the recent 未来 discussion remains available
//   - X remains distinct
//   - no model-facing identity suggestion X=未来 is produced by the Brain
//     context
//   - no identity/coreference clarification is encouraged
//   - no persistence mutation
//
// Identity separation while a fresh referent is active:
//   A. identity-authorized user evidence        — preserved (user_evidence)
//   B. related contextual evidence              — preserved (other episodes)
//   C. provisional AI hypotheses that speculate
//      about the fresh surface's referent       — withheld from the
//      model-facing context (explicitly non-identity-bearing marker)
//
// Offline: no provider calls, no network, no vault mutation.
// ────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: [
      "export { createSemanticSpec } from './src/SemanticSpec';",
      "export { createSemanticPriorEpisode, createEmptySemanticPriorState, addEpisodeToState, retrieveRelevantPriorsStructured, renderPriorsForPrompt } from './src/SemanticPrior';",
      "export { buildSemanticRetrievalQuery } from './src/SemanticRetrievalQuery';",
      "export { detectFreshReferentSurfaces, redactIdentitySuggestiveHypotheses, sanitizeProviderConversationHistory, isIdentitySpeculativeForSurface, assistantIdentityHypothesisWithheldMarker } from './src/ContextualSenseActivation';",
      "export { renderSenseContextAnnotation, degradedSenseContext } from './src/ContextualSensePrompt';",
      "export { prepareForegroundActivatedContext } from './src/ForegroundActivatedContext';",
      "export { createNormalChatSystemPrompt } from './src/DeepSeekClient';",
      "export { TFile } from 'obsidian';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "contextual-sense-identity-gate-entry.ts",
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
          "exports.normalizePath = (v) => v;",
          "exports.requestUrl = async () => { throw new Error('Unexpected network request'); };",
          "exports.Plugin = class {};",
          "exports.WorkspaceLeaf = class {};",
          "exports.Modal = class { constructor(){} open(){} close(){} };",
          "exports.setIcon = () => {};",
          "exports.TFile = class TFile { constructor(path, extension = 'md') { this.path = path; this.extension = extension; } };",
          "exports.MarkdownView = class MarkdownView {};",
          "exports.parseLinktext = (l) => ({ path: l.split('#')[0], subpath: l.includes('#') ? l.split('#')[1] : '' });"
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console,
  URL,
  setTimeout,
  clearTimeout,
  Promise
});

const {
  createSemanticSpec,
  createSemanticPriorEpisode,
  createEmptySemanticPriorState,
  addEpisodeToState,
  retrieveRelevantPriorsStructured,
  renderPriorsForPrompt,
  buildSemanticRetrievalQuery,
  detectFreshReferentSurfaces,
  redactIdentitySuggestiveHypotheses,
  sanitizeProviderConversationHistory,
  isIdentitySpeculativeForSurface,
  assistantIdentityHypothesisWithheldMarker,
  renderSenseContextAnnotation,
  degradedSenseContext,
  prepareForegroundActivatedContext,
  createNormalChatSystemPrompt,
  TFile
} = module.exports;

const X_UTTERANCE = "X 对我来说是某种自由";

// ── Fixtures ────────────────────────────────────────────────────────────

function makeUserEvidence(messageId, snapshot) {
  return { sourceKind: "message_span", messageId, snapshot, actor: "user" };
}

function makeSourceRef(id, messageId, snapshot) {
  return { id, messageId, snapshot };
}

// P — the REAL poisoned-history shape (Session A shadow hypothesis),
// transcribed from the deployed episode that caused the failed retest.
function makePoisonedEpisode() {
  const spec = createSemanticSpec({
    claimId: "claim-poisoned",
    sourceRefs: [makeSourceRef("sr-1", "message-9", X_UTTERANCE)],
    symbols: [
      {
        id: "sym-x",
        surface: "X",
        role: "variable",
        userDefined: false,
        description:
          "用户在 message-9 中使用的空位/变量 X；待填入具体内容。" +
          "最自然的候选是“未来”或“mirai no mirai”，但未确认。",
        sourceRefIds: ["sr-1"]
      }
    ],
    expressions: [{ id: "expr-x", kind: "symbol_ref", symbolId: "sym-x" }],
    statements: [
      {
        id: "stmt-x",
        kind: "assertion",
        exprId: "expr-x",
        description:
          "X 的所指未定，上下文中最自然可能是“未来”或“mirai no mirai”，" +
          "但未确认。原句：X 对我来说是某种自由"
      }
    ],
    ambiguities: [
      {
        id: "amb-x",
        kind: "reference_target",
        question: "你说“X 对我来说是某种自由”时，X 具体指什么？",
        affectedIds: ["sym-x"],
        blocking: true,
        choices: [
          {
            id: "choice-x-future",
            label: "X 指“未来”（即前面澄清过的 mirai / 未来这个词）"
          },
          {
            id: "choice-x-mirai-no-mirai",
            label: "X 指“mirai no mirai”（未来的未来）这个短语/概念"
          }
        ]
      }
    ],
    description:
      "用户先以“mirai”（后经澄清为“未来”/future）请求对“这个”作出评价；" +
      "随后询问“未来”是否读作 mirai；再给出“mirai no mirai”。" +
      "message-9 又说“X 对我来说是某种自由”，但 X 的所指未交代，" +
      "上下文中最可能指向“未来”或“mirai no mirai”。"
  });
  return createSemanticPriorEpisode({
    evidenceRefs: [
      makeUserEvidence("message-9", "X 对我来说是某种自由")
    ],
    semanticSpec: spec,
    semanticSessionId: "session-a",
    semanticRevision: 6
  });
}

// M — recent mirai/未来 discussion WITHOUT any X identity speculation.
// Must remain fully available (related contextual evidence, category B).
function makeMiraiDiscussionEpisode() {
  const spec = createSemanticSpec({
    claimId: "claim-mirai",
    sourceRefs: [makeSourceRef("sr-1", "message-7", "我说的 mirai 不是你，是未来")],
    symbols: [
      {
        id: "sym-mirai",
        surface: "mirai",
        role: "concept",
        userDefined: true,
        description: "“未来”的日语读音（みらい），不是对对话对象的称呼",
        sourceRefIds: ["sr-1"]
      }
    ],
    expressions: [],
    statements: [],
    ambiguities: [],
    description:
      "用户询问“未来”这个词读 mirai 吗；用户澄清“我说的 mirai 不是你，" +
      "是未来”——mirai 指“未来”，不是对对话对象的称呼。"
  });
  return createSemanticPriorEpisode({
    evidenceRefs: [
      makeUserEvidence("message-7", "我说的 mirai 不是你，是未来"),
      // As in the real retest, the shadow added the X utterance to the
      // recent-discussion episode's evidence — but this episode's spec
      // carries no X identity speculation.
      makeUserEvidence("message-9", "X 对我来说是某种自由")
    ],
    semanticSpec: spec,
    semanticSessionId: "session-b",
    semanticRevision: 5
  });
}

// U — an episode whose user evidence DOES carry identity-authorized
// wording ("这里 X 指未来"). Its AI interpretation is withheld like any
// other speculative spec, but the user-authored identity statement itself
// must survive (category A).
function makeIdentityAuthorizedEpisode() {
  const spec = createSemanticSpec({
    claimId: "claim-identity",
    sourceRefs: [makeSourceRef("sr-1", "message-2", "这里 X 指未来")],
    symbols: [
      {
        id: "sym-x2",
        surface: "X",
        role: "concept",
        userDefined: false,
        description: "用户说明 X 就是未来",
        sourceRefIds: ["sr-1"]
      }
    ],
    expressions: [{ id: "expr-x2", kind: "symbol_ref", symbolId: "sym-x2" }],
    statements: [
      {
        id: "stmt-x2",
        kind: "assertion",
        exprId: "expr-x2",
        description: "用户澄清：X 就是未来。"
      }
    ],
    ambiguities: [],
    description: "用户澄清：X 就是未来。"
  });
  return createSemanticPriorEpisode({
    evidenceRefs: [
      makeUserEvidence("message-2", "这里 X 指未来"),
      makeUserEvidence("message-9", "X 对我来说是某种自由")
    ],
    semanticSpec: spec,
    semanticSessionId: "session-c",
    semanticRevision: 2
  });
}

// Minimal read-only app surface for the activated-context pipeline.
function makeApp() {
  const files = [];
  const contentByPath = new Map();
  return {
    vault: {
      getMarkdownFiles: () => files.map((path) => new TFile(path, "md")),
      getAbstractFileByPath: (path) =>
        contentByPath.has(path) ? new TFile(path, "md") : null,
      getFileByPath: (path) =>
        contentByPath.has(path) ? new TFile(path, "md") : null,
      getFolderByPath: () => null,
      cachedRead: async (file) => contentByPath.get(file.path) ?? "",
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
      on: () => ({}),
      resolvedLinks: {},
      getFileCache: () => ({ links: [], embeds: [], frontmatterLinks: [] }),
      getFirstLinkpathDest: () => null
    }
  };
}

// ── Shared scenario ─────────────────────────────────────────────────────

const poisoned = makePoisonedEpisode();
const mirai = makeMiraiDiscussionEpisode();
const identity = makeIdentityAuthorizedEpisode();

let state = createEmptySemanticPriorState();
state = addEpisodeToState(state, poisoned);
state = addEpisodeToState(state, mirai);
state = addEpisodeToState(state, identity);

const freshSurfaces = [...detectFreshReferentSurfaces(X_UTTERANCE, ["蓝璃"])];
const stateBefore = JSON.stringify(state);

// The exact identities of the selected episode objects, in retrieval order.
const query = buildSemanticRetrievalQuery({ utteranceText: X_UTTERANCE });
const retrieved = retrieveRelevantPriorsStructured(state, X_UTTERANCE, query);
const retrievedIds = retrieved.map((episode) => episode.id);

// The gate, exactly as the session applies it.
const gated = redactIdentitySuggestiveHypotheses(retrieved, freshSurfaces);
const stateAfter = JSON.stringify(state);

// ── T01: fresh referent detection ───────────────────────────────────────

{
  assert.deepEqual(freshSurfaces, ["x"]);
  console.log("T01 PASS: fresh referent detected for " + JSON.stringify(X_UTTERANCE));
}

// ── T02: the poisoned hypothesis remains retrievable as provisional
//         context (persisted, ranked, untouched) — and nothing persisted
//         is mutated by the gate. ────────────────────────────────────────

{
  assert.ok(retrievedIds.includes(poisoned.id),
    "poisoned episode must be retrieved (provisional context)");
  assert.equal(stateAfter, stateBefore, "persisted state must be byte-identical");
  assert.equal(gated.length, retrieved.length, "gate never drops episodes");
  assert.deepEqual(gated.map((episode) => episode.id), retrievedIds);
  // The persisted episode object itself is untouched.
  assert.ok(poisoned.semanticSpec.description.includes("最可能指向"),
    "fixture must carry the real poisoned hypothesis before gating");
  console.log("T02 PASS: hypothesis stays retrievable; no persistence mutation");
}

// ── T03: A/B/C separation at the episode level ──────────────────────────

{
  const gatedPoisoned = gated[retrievedIds.indexOf(poisoned.id)];
  // C withheld: AI interpretation replaced by an explicitly
  // non-identity-bearing marker; all speculative spec content removed.
  assert.match(gatedPoisoned.semanticSpec.description, /AI interpretation withheld/);
  assert.equal(gatedPoisoned.semanticSpec.symbols.length, 0);
  assert.equal(gatedPoisoned.semanticSpec.statements.length, 0);
  assert.equal(gatedPoisoned.semanticSpec.ambiguities.length, 0);
  assert.doesNotMatch(gatedPoisoned.semanticSpec.description, /最可能指向/);
  // A preserved: the episode's own user evidence survives verbatim.
  assert.equal(gatedPoisoned.evidenceRefs, poisoned.evidenceRefs);
  assert.ok(gatedPoisoned.evidenceRefs.some(
    (ref) => ref.snapshot === X_UTTERANCE));

  // B preserved: the mirai discussion episode is not identity-speculative
  // about X, so it must remain fully available.
  const gatedMirai = gated[retrievedIds.indexOf(mirai.id)];
  assert.equal(gatedMirai, mirai,
    "non-identity-speculative episode must pass through untouched");
  assert.ok(gatedMirai.semanticSpec.description.includes("不是对对话对象的称呼"));

  // A preserved for the identity-authorized episode: its user statement
  // survives even though its AI interpretation is withheld.
  const gatedIdentity = gated[retrievedIds.indexOf(identity.id)];
  assert.match(gatedIdentity.semanticSpec.description, /AI interpretation withheld/);
  assert.ok(gatedIdentity.evidenceRefs.some(
    (ref) => ref.snapshot === "这里 X 指未来"));
  console.log("T03 PASS: A preserved, B preserved, C withheld");
}

// ── T04: the full provider-visible activated context contains no
//         identity suggestion X=未来 and keeps the related material. ─────

{
  const prepared = await prepareForegroundActivatedContext({
    app: makeApp(),
    currentUtterance: { text: X_UTTERANCE, messageId: "message-9" },
    selectedSemanticPriorEpisodes: gated
  });
  const serialized = prepared.promptSection.serializedText;

  for (const forbidden of [
    "最可能指向",       // poisoned description
    "指向未来",
    "最自然的候选",     // poisoned symbol
    "待填入",           // poisoned symbol placeholder framing
    "推测 X",           // retest shadow phrasing
    "X=未来",
    "X = 未来",
    "可能是未来",
    "X 具体指什么",     // poisoned clarification question
    "choice-x-future"   // poisoned ambiguity choice id
  ]) {
    assert.equal(serialized.includes(forbidden), false,
      `provider-visible activated context leaks: ${JSON.stringify(forbidden)}`);
  }
  // C's withheld marker is present and explicitly non-identity-bearing.
  assert.ok(serialized.includes("AI interpretation withheld"));
  // A survives: user-authored identity evidence remains user evidence.
  assert.ok(serialized.includes("这里 X 指未来"));
  // B survives: recent mirai/未来 discussion remains available.
  assert.ok(serialized.includes("不是对对话对象的称呼"));
  assert.ok(serialized.includes("我说的 mirai 不是你，是未来"));
  // The X utterance itself remains available as user evidence.
  assert.ok(serialized.includes(X_UTTERANCE));
  console.log("T04 PASS: no identity suggestion in activated context; A and B available");
}

// ── T05: the composed system prompt (activated mode + sense annotation)
//         carries no identity suggestion and does not encourage an
//         identity/clarification exchange. ───────────────────────────────

{
  const prepared = await prepareForegroundActivatedContext({
    app: makeApp(),
    currentUtterance: { text: X_UTTERANCE, messageId: "message-9" },
    selectedSemanticPriorEpisodes: gated
  });
  const annotation = renderSenseContextAnnotation(
    [], new Map(), [], freshSurfaces
  );
  const systemPrompt = createNormalChatSystemPrompt(
    undefined,
    undefined,
    { mode: "activated", activatedContext: prepared.promptSection.serializedText },
    annotation
  );

  for (const forbidden of [
    "最可能指向",
    "最自然的候选",
    "待填入",
    "推测 X",
    "X=未来",
    "X = 未来",
    "可能是未来",
    "X 具体指什么"
  ]) {
    assert.equal(systemPrompt.includes(forbidden), false,
      `composed system prompt leaks: ${JSON.stringify(forbidden)}`);
  }
  // X remains distinct: the fresh-referent advisory is present.
  assert.ok(systemPrompt.includes("fresh referent: x"));
  assert.ok(systemPrompt.includes("distinct referent"));
  assert.ok(systemPrompt.includes("not a placeholder"));
  assert.ok(systemPrompt.includes("AI interpretation withheld"));
  // No identity/coreference clarification question is posed.
  assert.doesNotMatch(systemPrompt, /X\s*具体指什么|X\s*指什么/);
  console.log("T05 PASS: composed system prompt keeps X distinct");
}

// ── T06: the legacy prior-rendering path is gated identically ───────────
//
// The legacy render shows anchors, spec symbols, blocking ambiguities, and
// evidence excerpts — never the spec description. The poisoned symbols and
// ambiguity choices live in those rendered fields, so the gate empties them
// there too: nothing speculative survives in the legacy rendering either.

{
  const legacy = renderPriorsForPrompt(gated);
  assert.doesNotMatch(legacy, /最可能指向|最自然的候选|待填入|推测 X|可能是未来/);
  // The poisoned ambiguity question and symbol description are gone.
  assert.doesNotMatch(legacy, /X 具体指什么/);
  assert.doesNotMatch(legacy, /待填入具体内容/);
  // Identity-authorized user evidence survives in the rendered excerpts.
  assert.ok(legacy.includes("这里 X 指未来"));
  assert.ok(legacy.includes("X 对我来说是某种自由"));
  assert.ok(legacy.includes("我说的 mirai 不是你，是未来"));
  console.log("T06 PASS: legacy prior rendering is gated");
}

// ── T07: without an active fresh referent the gate is a no-op ───────────

{
  const untouched = redactIdentitySuggestiveHypotheses(retrieved, []);
  assert.equal(untouched, retrieved,
    "no fresh referent => episodes pass through by reference");
  assert.ok(untouched[retrievedIds.indexOf(poisoned.id)]
    .semanticSpec.description.includes("最可能指向"));
  console.log("T07 PASS: gate inactive without a fresh referent");
}

// ── T08: degraded sense context defaults to no fresh referents; a
//         degraded context that still carries them keeps the gate alive ──

{
  assert.deepEqual([...degradedSenseContext().freshReferentSurfaces], []);
  const degradedWithFresh = Object.freeze({
    ...degradedSenseContext(),
    freshReferentSurfaces: freshSurfaces
  });
  const stillGated = redactIdentitySuggestiveHypotheses(
    retrieved,
    degradedWithFresh.freshReferentSurfaces
  );
  assert.doesNotMatch(
    stillGated[retrievedIds.indexOf(poisoned.id)].semanticSpec.description,
    /最可能指向/
  );
  console.log("T08 PASS: gate survives a degraded sense layer");
}

// ── T09: assistant-message identity speculation detection ──────────────

{
  // The exact deployed launder message: speculative X→未来 statement.
  assert.equal(
    isIdentitySpeculativeForSurface(
      "如果之前你说的『X 对我来说是某种自由』里的 X 是『未来』的话……",
      "x"
    ),
    true
  );
  // The final-turn failure form is speculative too.
  assert.equal(
    isIdentitySpeculativeForSurface(
      "我猜，这里的 X 就是我们刚刚说到的那个『未来』？",
      "x"
    ),
    true
  );
  // Plain repetition of the user's own declarative frame is not flagged.
  assert.equal(
    isIdentitySpeculativeForSurface("X 对我来说是某种自由", "x"),
    false
  );
  // No surface mention → never flagged.
  assert.equal(
    isIdentitySpeculativeForSurface(
      "我记住了……下次不会再把它当作称呼我的方式",
      "x"
    ),
    false
  );
  assert.equal(
    isIdentitySpeculativeForSurface("蓝璃是 lain 给钥匙起的名字", "x"),
    false
  );
  console.log("T09 PASS: assistant speculation detection");
}

// ── T10: assistant-history laundering — the exact live bypass ───────────

{
  const history = [
    { role: "user", content: "未来这个词读 mirai 吗" },
    { role: "assistant", content: "mirai 是「未来」的日语读音（みらい），中文读音是 wèilái。" },
    { role: "user", content: "mirai no mirai" },
    { role: "assistant", content: "如果之前你说的『X 对我来说是某种自由』里的 X 是『未来』的话……" },
    { role: "user", content: "我说的 mirai 不是你，是未来" },
    { role: "assistant", content: "mirai 不是指我，是未来。我记住了……下次不会再把它当作称呼我的方式。" },
    { role: "user", content: X_UTTERANCE }
  ];
  const historyBefore = JSON.stringify(history);

  const sanitized = sanitizeProviderConversationHistory(history, ["x"]);

  // User messages stay byte-exact and untouched.
  assert.equal(sanitized[0], history[0]);
  assert.equal(sanitized[2], history[2]);
  assert.equal(sanitized[4], history[4]);
  assert.equal(sanitized[6], history[6]);

  // Ordinary assistant context remains.
  assert.equal(sanitized[1], history[1]);
  assert.equal(sanitized[5], history[5]);

  // The launder message is quarantined with an explicit marker.
  const withheld = sanitized[3];
  assert.equal(withheld.role, "assistant");
  assert.equal(
    withheld.content,
    assistantIdentityHypothesisWithheldMarker("x")
  );
  assert.match(withheld.content, /identity requires user-authored evidence/);
  assert.doesNotMatch(withheld.content, /X 是『未来』/);
  assert.doesNotMatch(withheld.content, /未来/);

  // The stored transcript is never mutated.
  assert.equal(JSON.stringify(history), historyBefore);
  // And the un-sanitized view really did carry the speculation.
  assert.ok(history[3].content.includes("X 是『未来』"));
  console.log("T10 PASS: assistant-history laundering quarantined");
}

// ── T11: composed final-X-turn provider view carries no X=未来 support ──

{
  const history = [
    { role: "user", content: "未来这个词读 mirai 吗" },
    { role: "assistant", content: "mirai 是「未来」的日语读音（みらい），中文读音是 wèilái。" },
    { role: "user", content: "mirai no mirai" },
    { role: "assistant", content: "如果之前你说的『X 对我来说是某种自由』里的 X 是『未来』的话……" },
    { role: "user", content: "我说的 mirai 不是你，是未来" },
    { role: "assistant", content: "mirai 不是指我，是未来。我记住了……下次不会再把它当作称呼我的方式。" },
    { role: "user", content: X_UTTERANCE }
  ];
  const sanitized = sanitizeProviderConversationHistory(history, freshSurfaces);

  const prepared = await prepareForegroundActivatedContext({
    app: makeApp(),
    currentUtterance: { text: X_UTTERANCE, messageId: "message-9" },
    selectedSemanticPriorEpisodes: gated
  });
  const annotation = renderSenseContextAnnotation(
    [], new Map(), [], freshSurfaces
  );
  const systemPrompt = createNormalChatSystemPrompt(
    undefined,
    undefined,
    { mode: "activated", activatedContext: prepared.promptSection.serializedText },
    annotation
  );
  const providerVisible = [systemPrompt, ...sanitized.map((m) => m.content)]
    .join("\n");

  // No channel may supply historical support for X=未来.
  for (const forbidden of [
    "X 是『未来』",
    "X = 未来",
    "X=未来",
    "最可能指向",
    "最自然的候选",
    "待填入"
  ]) {
    assert.equal(providerVisible.includes(forbidden), false,
      `provider-visible final-X view leaks: ${JSON.stringify(forbidden)}`);
  }
  // 未来 remains semantically available through the user's own messages.
  assert.ok(providerVisible.includes("mirai no mirai"));
  assert.ok(providerVisible.includes("未来这个词读 mirai 吗"));
  assert.ok(providerVisible.includes("我说的 mirai 不是你，是未来"));
  // X remains a distinct referent.
  assert.ok(providerVisible.includes("fresh referent: x"));
  assert.ok(providerVisible.includes("not a placeholder"));
  assert.ok(providerVisible.includes("AI interpretation withheld"));
  console.log("T11 PASS: composed final-X provider view is identity-clean");
}

// ── T12: positive control — user-authored identity evidence survives ────

{
  const history = [
    { role: "user", content: "这里 X 指未来" },
    { role: "assistant", content: "X 是未来的另一个名字，对吗？" },
    { role: "user", content: X_UTTERANCE }
  ];
  const sanitized = sanitizeProviderConversationHistory(history, ["x"]);

  // The user's identity-authorized statement stays byte-exact.
  assert.equal(sanitized[0], history[0]);
  assert.ok(sanitized[0].content.includes("这里 X 指未来"));
  // The assistant's repetition is quarantined; the evidence itself is not
  // lost because it lives in the untouched user message.
  assert.equal(sanitized[1].content,
    assistantIdentityHypothesisWithheldMarker("x"));
  assert.equal(sanitized[2], history[2]);
  console.log("T12 PASS: user-authored identity evidence survives");
}

// ── T13: no active fresh referent → history passes through untouched ────

{
  const history = [
    { role: "user", content: "未来这个词读 mirai 吗" },
    { role: "assistant", content: "如果之前你说的『X 对我来说是某种自由』里的 X 是『未来』的话……" },
    { role: "user", content: X_UTTERANCE }
  ];
  assert.equal(sanitizeProviderConversationHistory(history, []), history,
    "no fresh referent => same array by reference");
  const forOther = sanitizeProviderConversationHistory(history, ["y"]);
  assert.deepEqual(forOther, history,
    "unmentioned fresh referent => messages unchanged");
  console.log("T13 PASS: history sanitization is scoped to active fresh referents");
}

// ── T14: Fresh Referent semantic typing — unresolved ≠ unbound ──────────
//
// "X 对我来说是某种自由" must establish: distinct referent, identity
// unresolved, semantic content NOT empty (the user attributed 某种自由 to
// X), not a placeholder, not an unbound variable. Forbidden positive
// framings ("is empty", "is an unbound variable") must never appear.

{
  const annotation = renderSenseContextAnnotation(
    [], new Map(), [], freshSurfaces, X_UTTERANCE
  );
  const prepared = await prepareForegroundActivatedContext({
    app: makeApp(),
    currentUtterance: { text: X_UTTERANCE, messageId: "message-9" },
    selectedSemanticPriorEpisodes: gated
  });
  const systemPrompt = createNormalChatSystemPrompt(
    undefined,
    undefined,
    { mode: "activated", activatedContext: prepared.promptSection.serializedText },
    annotation
  );

  // Required established properties.
  assert.ok(systemPrompt.includes("fresh referent: x"));
  assert.ok(systemPrompt.includes("distinct referent"));
  assert.ok(systemPrompt.includes("identity is unresolved"));
  assert.ok(systemPrompt.includes("Not semantically empty"));
  assert.ok(systemPrompt.includes("not a placeholder"));
  assert.ok(systemPrompt.includes("not an unbound variable"));
  assert.ok(systemPrompt.includes("not a blank slot"));
  // The user's exact statement is preserved as X's semantic content.
  assert.ok(systemPrompt.includes("user statement:"));
  assert.ok(systemPrompt.includes(`"${X_UTTERANCE}"`));
  // Forbidden positive framings never appear.
  assert.doesNotMatch(systemPrompt, /is (?:semantically )?empty/);
  assert.doesNotMatch(systemPrompt, /is an unbound variable/);
  console.log("T14 PASS: fresh referent is typed as unresolved, never unbound");
}

// ── T15: positive control — explicit let-binding stays a variable ───────

{
  // "设 X 为一个未知变量" has no declarative fresh frame, so no
  // fresh-referent annotation is produced and the mathematical-variable
  // interpretation remains fully available.
  const surfaces = detectFreshReferentSurfaces("设 X 为一个未知变量", []);
  assert.deepEqual([...surfaces], []);
  const annotation = renderSenseContextAnnotation(
    [], new Map(), [], [...surfaces], "设 X 为一个未知变量"
  );
  assert.equal(annotation, "");
  console.log("T15 PASS: explicit variable binding keeps variable interpretation");
}

console.log("contextual-sense-identity-gate.test.mjs PASS");
