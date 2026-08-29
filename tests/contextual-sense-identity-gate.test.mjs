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
      "export { detectFreshReferentSurfaces, redactIdentitySuggestiveHypotheses } from './src/ContextualSenseActivation';",
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
  assert.ok(systemPrompt.includes("distinct provisional referent"));
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

console.log("contextual-sense-identity-gate.test.mjs PASS");
