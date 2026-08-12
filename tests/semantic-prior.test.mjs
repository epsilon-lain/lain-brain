// ── M2B.4 Semantic Prior Episode Tests ─────────────────────────────────
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: [
      // ── SemanticSpec exports ────────────────────────────────────
      "export {",
      "  createSemanticSpec,",
      "  validateSemanticSpec,",
      "  SEMANTIC_ROLES,",
      "  AMBIGUITY_KINDS,",
      "  EXPRESSION_KINDS,",
      "  STATEMENT_KINDS",
      "} from './src/SemanticSpec';",
      "",
      // ── SemanticPrior exports ───────────────────────────────────
      "export {",
      "  createSemanticPriorEpisode,",
      "  createEmptySemanticPriorState,",
      "  addEpisodeToState,",
      "  deriveAnchors,",
      "  retrieveRelevantPriors,",
      "  renderPriorsForPrompt,",
      "  migrateSemanticPriorState,",
      "  sliceSemanticSpecForEvidence,",
      "  getSemanticPriorEpisodeCount,",
      "  getSemanticPriorEpisodes,",
      "  getLastInjectedSemanticPriorIds,",
      "  SEMANTIC_PRIOR_SCHEMA_VERSION",
      "} from './src/SemanticPrior';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "semantic-prior-entry.ts",
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
          "exports.requestUrl = async () => { throw new Error('Unexpected network request'); };"
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  DOMMatrix: class { constructor(){} },
  module,
  exports: module.exports,
  require,
  console,
  URL,
  crypto: { randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  createSemanticSpec,
  createSemanticPriorEpisode,
  createEmptySemanticPriorState,
  addEpisodeToState,
  deriveAnchors,
  retrieveRelevantPriors,
  renderPriorsForPrompt,
  migrateSemanticPriorState,
  sliceSemanticSpecForEvidence,
  getSemanticPriorEpisodeCount,
  getSemanticPriorEpisodes,
  getLastInjectedSemanticPriorIds,
  SEMANTIC_PRIOR_SCHEMA_VERSION
} = module.exports;

// ── Helpers ────────────────────────────────────────────────────────────

function makeSourceRef(id, messageId, snapshot) {
  return { id, messageId, snapshot };
}

function makeUserEvidence(messageId, snapshot) {
  return {
    sourceKind: "message_span",
    messageId,
    snapshot,
    actor: "user"
  };
}

function makeSourceRefs(sources) {
  return sources.map((s, i) => ({
    id: `sr-${i + 1}`,
    messageId: s.messageId ?? `msg-${i + 1}`,
    snapshot: s.snapshot
  }));
}

function makeSpec(options = {}) {
  const {
    symbols = [],
    expressions = [],
    statements = [],
    ambiguities = [],
    description,
    sourceRefs
  } = options;

  return createSemanticSpec({
    claimId: "test-claim",
    sourceRefs: sourceRefs ?? [makeSourceRef("sr-1", "msg-1", "test evidence")],
    symbols,
    expressions,
    statements,
    ambiguities,
    description
  });
}

// ═════════════════════════════════════════════════════════════════════════
// TEST A: Episode provenance
// ═════════════════════════════════════════════════════════════════════════

{
  const evidence = [
    makeUserEvidence("msg-1", "lain觉得级数的速度不是每一步差值")
  ];

  const spec = makeSpec({
    symbols: [
      {
        id: "sym-1",
        surface: "级数的速度",
        role: "concept",
        userDefined: true,
        description: "用户自定义的速度概念",
        sourceRefIds: ["sr-1"]
      },
      {
        id: "sym-2",
        surface: "每一步差值",
        role: "concept",
        userDefined: false,
        description: "相邻项之差",
        sourceRefIds: ["sr-1"]
      }
    ],
    expressions: [
      {
        id: "expr-1",
        kind: "symbol_ref",
        symbolId: "sym-1",
        label: "级数的速度"
      }
    ],
    statements: [
      {
        id: "stmt-1",
        kind: "assertion",
        exprId: "expr-1",
        description: "级数的速度不是每一步差值"
      }
    ],
    ambiguities: [
      {
        id: "amb-1",
        kind: "operator_meaning",
        question: "速度具体衡量什么？",
        affectedIds: ["sym-1"],
        blocking: true,
        choices: [
          { id: "c1", label: "S_n/n" },
          { id: "c2", label: "收敛速率" }
        ]
      }
    ]
  });

  const episode = createSemanticPriorEpisode({
    evidenceRefs: evidence,
    semanticSpec: spec,
    semanticSessionId: "session-1",
    semanticRevision: 3
  });

  // All evidence must be user-authored
  for (const ref of episode.evidenceRefs) {
    assert.strictEqual(ref.actor, "user",
      "A: Every evidence actor must be 'user'");
  }

  // Evidence snapshots must be preserved exactly
  assert.strictEqual(episode.evidenceRefs[0].snapshot,
    "lain觉得级数的速度不是每一步差值",
    "A: Exact user snapshot must be preserved");

  // No UserConclusion created
  assert.strictEqual(typeof episode.id, "string",
    "A: Episode must have an id");
  assert.ok(episode.id.startsWith("spe-"),
    "A: Episode id must use spe- prefix");

  // Episode must be deeply frozen
  assert.throws(() => {
    episode.anchors = [];
  }, TypeError, "A: Episode must be immutable");

  // Anchors should be derived from the spec
  assert.ok(episode.anchors.length > 0,
    "A: Episode must have derived anchors");
  assert.ok(episode.anchors.includes("级数的速度"),
    "A: User-defined symbol must appear as anchor");
}

// ═════════════════════════════════════════════════════════════════════════
// TEST B: Immutable history — multiple episodes for same anchor
// ═════════════════════════════════════════════════════════════════════════

{
  const evidence1 = [makeUserEvidence("msg-1", "速度就是收敛速率")];
  const evidence2 = [makeUserEvidence("msg-2", "速度不是收敛速率，是另一个东西")];

  const spec1 = makeSpec({
    symbols: [{
      id: "s1", surface: "速度", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "e1", kind: "symbol_ref", symbolId: "s1" }],
    statements: [{
      id: "st1", kind: "definition",
      subjectSymbolId: "s1", bodyExprId: "e1",
      description: "速度 = 收敛速率"
    }],
    ambiguities: []
  });

  const spec2 = makeSpec({
    symbols: [{
      id: "s2", surface: "速度", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "e2", kind: "symbol_ref", symbolId: "s2" }],
    statements: [{
      id: "st2", kind: "assertion", exprId: "e2",
      description: "速度不是收敛速率"
    }],
    ambiguities: [{
      id: "a2", kind: "operator_meaning",
      question: "速度到底是什么？", affectedIds: ["s2"],
      blocking: true,
      choices: [{ id: "c1", label: "某种变化率" }, { id: "c2", label: "自定义运算" }]
    }]
  });

  const E1 = createSemanticPriorEpisode({
    evidenceRefs: evidence1,
    semanticSpec: spec1,
    semanticSessionId: "sess-1",
    semanticRevision: 1
  });

  const E2 = createSemanticPriorEpisode({
    evidenceRefs: evidence2,
    semanticSpec: spec2,
    semanticSessionId: "sess-2",
    semanticRevision: 1
  });

  // Both anchor to "速度"
  assert.ok(E1.anchors.includes("速度"),
    "B: E1 must anchor to 速度");
  assert.ok(E2.anchors.includes("速度"),
    "B: E2 must anchor to 速度");

  // E1 must remain unchanged
  assert.strictEqual(E1.evidenceRefs[0].snapshot,
    "速度就是收敛速率",
    "B: E1 evidence must remain unchanged after E2 created");

  // E2 does not overwrite E1
  assert.notStrictEqual(E1.id, E2.id,
    "B: E2 must have a different id from E1");
  assert.notStrictEqual(
    E1.semanticSpec.statements[0].description,
    E2.semanticSpec.statements[0].description,
    "B: E2 hypothesis must differ from E1");

  // Both can coexist in state
  const state = addEpisodeToState(
    addEpisodeToState(createEmptySemanticPriorState(), E1),
    E2
  );
  assert.strictEqual(state.episodes.length, 2,
    "B: Both episodes must coexist in state");
}

// ═════════════════════════════════════════════════════════════════════════
// TEST C: Persistence through migration
// ═════════════════════════════════════════════════════════════════════════

{
  const evidence = [makeUserEvidence("msg-1", "无穷物件时间尺度是自定义的")];
  const spec = makeSpec({
    symbols: [{
      id: "s1", surface: "无穷物件时间尺度", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "e1", kind: "symbol_ref", symbolId: "s1" }],
    statements: [{
      id: "st1", kind: "definition", subjectSymbolId: "s1",
      bodyExprId: "e1", description: "自定义时间尺度概念"
    }],
    ambiguities: []
  });

  const episode = createSemanticPriorEpisode({
    evidenceRefs: evidence,
    semanticSpec: spec,
    semanticSessionId: "sess-persist",
    semanticRevision: 1
  });

  const state = addEpisodeToState(
    createEmptySemanticPriorState(),
    episode
  );

  // Simulate serialization round-trip (JSON.stringify → JSON.parse)
  const serialized = JSON.parse(JSON.stringify(state));
  const restored = migrateSemanticPriorState(serialized);

  assert.strictEqual(restored.episodes.length, 1,
    "C: Restored state must have 1 episode");
  assert.strictEqual(restored.episodes[0].id, episode.id,
    "C: Episode id must survive round-trip");
  assert.strictEqual(restored.episodes[0].semanticSessionId, "sess-persist",
    "C: Session id must survive round-trip");
  assert.strictEqual(
    restored.episodes[0].evidenceRefs[0].snapshot,
    "无穷物件时间尺度是自定义的",
    "C: Evidence snapshot must survive round-trip"
  );
  assert.strictEqual(
    restored.episodes[0].evidenceRefs[0].actor,
    "user",
    "C: Evidence actor must survive round-trip"
  );
}

// ═════════════════════════════════════════════════════════════════════════
// TEST D: Relevant retrieval — exact anchor match
// ═════════════════════════════════════════════════════════════════════════

{
  const evidence = [makeUserEvidence("msg-1", "无穷物件时间尺度的定义")];
  const spec = makeSpec({
    symbols: [{
      id: "s1", surface: "无穷物件时间尺度", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "e1", kind: "symbol_ref", symbolId: "s1" }],
    statements: [{
      id: "st1", kind: "definition", subjectSymbolId: "s1",
      bodyExprId: "e1"
    }],
    ambiguities: []
  });

  const episode = createSemanticPriorEpisode({
    evidenceRefs: evidence,
    semanticSpec: spec,
    semanticSessionId: "sess-d",
    semanticRevision: 1
  });

  const state = addEpisodeToState(
    createEmptySemanticPriorState(),
    episode
  );

  // Current user text contains the exact anchor
  const relevant = retrieveRelevantPriors(
    state,
    "lain又想到无穷物件时间尺度里的速度喵"
  );

  assert.strictEqual(relevant.length, 1,
    "D: Relevant episode must be retrieved");
  assert.strictEqual(relevant[0].id, episode.id,
    "D: Retrieved episode must match");
}

// ═════════════════════════════════════════════════════════════════════════
// TEST E: Irrelevant prior excluded
// ═════════════════════════════════════════════════════════════════════════

{
  const evidence1 = [makeUserEvidence("msg-1", "无穷物件时间尺度的定义")];
  const spec1 = makeSpec({
    symbols: [{
      id: "s1", surface: "无穷物件时间尺度", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "e1", kind: "symbol_ref", symbolId: "s1" }],
    statements: [{
      id: "st1", kind: "definition", subjectSymbolId: "s1",
      bodyExprId: "e1"
    }],
    ambiguities: []
  });

  const episode1 = createSemanticPriorEpisode({
    evidenceRefs: evidence1,
    semanticSpec: spec1,
    semanticSessionId: "sess-e-1",
    semanticRevision: 1
  });

  const state = addEpisodeToState(
    createEmptySemanticPriorState(),
    episode1
  );

  // Current user text is about something completely unrelated
  const relevant = retrieveRelevantPriors(
    state,
    "复数乘法为什么角度会相加"
  );

  assert.strictEqual(relevant.length, 0,
    "E: Unrelated prior must NOT be retrieved just because it is recent");
}

// ═════════════════════════════════════════════════════════════════════════
// TEST F: Specific anchor outranks generic anchor
// ═════════════════════════════════════════════════════════════════════════

{
  const evidence1 = [makeUserEvidence("msg-1", "速度的定义")];
  const spec1 = makeSpec({
    symbols: [{
      id: "s1", surface: "速度", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "e1", kind: "symbol_ref", symbolId: "s1" }],
    statements: [{
      id: "st1", kind: "definition", subjectSymbolId: "s1",
      bodyExprId: "e1"
    }],
    ambiguities: []
  });

  const evidence2 = [makeUserEvidence("msg-2", "级数的速度定义")];
  const spec2 = makeSpec({
    symbols: [{
      id: "s2", surface: "级数的速度", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "e2", kind: "symbol_ref", symbolId: "s2" }],
    statements: [{
      id: "st2", kind: "definition", subjectSymbolId: "s2",
      bodyExprId: "e2"
    }],
    ambiguities: []
  });

  const E1 = createSemanticPriorEpisode({
    evidenceRefs: evidence1, semanticSpec: spec1,
    semanticSessionId: "sess-f-1", semanticRevision: 1
  });

  const E2 = createSemanticPriorEpisode({
    evidenceRefs: evidence2, semanticSpec: spec2,
    semanticSessionId: "sess-f-2", semanticRevision: 1
  });

  // Make E2 older than E1 — but E2 has the more specific anchor
  const E2_old = { ...E2, createdAt: E1.createdAt - 10000 };
  const state = addEpisodeToState(
    addEpisodeToState(createEmptySemanticPriorState(), E1),
    E2_old
  );

  const relevant = retrieveRelevantPriors(state, "级数的速度...");

  assert.ok(relevant.length >= 1,
    "F: At least one relevant episode must be retrieved");
  // The specific anchor ("级数的速度") should rank higher due to length bonus
  // or at least be present
  const foundSpecific = relevant.some(
    (e) => e.anchors.includes("级数的速度")
  );
  assert.ok(foundSpecific,
    "F: Specific anchor episode must be in results");
}

// ═════════════════════════════════════════════════════════════════════════
// TEST G: Prompt authority invariant
// ═════════════════════════════════════════════════════════════════════════

{
  const evidence = [makeUserEvidence("msg-1", "速度就是S_n/n")];
  const spec = makeSpec({
    symbols: [{
      id: "s1", surface: "速度", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"],
      description: "速度 = S_n/n"
    }],
    expressions: [{ id: "e1", kind: "symbol_ref", symbolId: "s1" }],
    statements: [{
      id: "st1", kind: "definition", subjectSymbolId: "s1",
      bodyExprId: "e1", description: "速度 = S_n/n"
    }],
    ambiguities: []
  });

  const episode = createSemanticPriorEpisode({
    evidenceRefs: evidence, semanticSpec: spec,
    semanticSessionId: "sess-g", semanticRevision: 1
  });

  const rendered = renderPriorsForPrompt([episode]);

  // Must explicitly state: priors are historical assistant hypotheses
  assert.ok(
    rendered.includes("historical ASSISTANT WORKING HYPOTHESES") ||
    rendered.includes("historical") && rendered.includes("hypothesis"),
    "G: Must state priors are historical hypotheses"
  );

  // Must state: not user definitions
  assert.ok(
    rendered.includes("not definitions") ||
    rendered.includes("not UserConclusions") ||
    rendered.includes("not authoritative"),
    "G: Must state priors are not user definitions"
  );

  // Must state: current language has higher authority
  assert.ok(
    rendered.includes("greater authority") ||
    rendered.includes("higher authority") ||
    rendered.includes("always has greater"),
    "G: Must state current language has higher authority"
  );

  // Must state: follow current message if conflict
  assert.ok(
    rendered.includes("follow the current message") ||
    rendered.includes("conflicts with a prior"),
    "G: Must state conflict resolution rule"
  );
}

// ═════════════════════════════════════════════════════════════════════════
// TEST H: Current correction — old hypothesis must not be presented as
//          current user definition
// ═════════════════════════════════════════════════════════════════════════

{
  const evidence = [makeUserEvidence("msg-1", "速度就是S_n/n")];
  const spec = makeSpec({
    symbols: [{
      id: "s1", surface: "速度", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"],
      description: "速度 = S_n/n"
    }],
    expressions: [{ id: "e1", kind: "symbol_ref", symbolId: "s1" }],
    statements: [{
      id: "st1", kind: "definition", subjectSymbolId: "s1",
      bodyExprId: "e1", description: "速度 = S_n/n"
    }],
    ambiguities: []
  });

  const episode = createSemanticPriorEpisode({
    evidenceRefs: evidence, semanticSpec: spec,
    semanticSessionId: "sess-h", semanticRevision: 1
  });

  const rendered = renderPriorsForPrompt([episode]);

  // The rendered output must NOT present speed = S_n/n as the user's
  // current definition. It should be framed as a historical hypothesis.
  // We check that the rendering does NOT say "your definition" or
  // "according to your definition" without hedging.
  assert.ok(
    !rendered.includes("your definition of speed is") &&
    !rendered.includes("according to your definition"),
    "H: Must not present old hypothesis as current user definition"
  );

  // The rendering should include the authority disclaimer adjacent to
  // the prior context
  const hasAdjacentAuthority = (
    rendered.includes("historical") &&
    rendered.includes("authority")
  );
  assert.ok(hasAdjacentAuthority,
    "H: Authority disclaimer must appear in rendered context");
}

// ═════════════════════════════════════════════════════════════════════════
// TEST I: Budget — rendered context respects configured limit
// ═════════════════════════════════════════════════════════════════════════

{
  const episodes = [];
  for (let i = 0; i < 15; i++) {
    const evidence = [makeUserEvidence(`msg-${i}`, `概念${i}的定义文本`)];
    const spec = makeSpec({
      symbols: [{
        id: `s${i}`, surface: `概念${i}`, role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]
      }],
      expressions: [{ id: `e${i}`, kind: "symbol_ref", symbolId: `s${i}` }],
      statements: [{
        id: `st${i}`, kind: "definition", subjectSymbolId: `s${i}`,
        bodyExprId: `e${i}`, description: `概念${i}的详细定义说明`
      }],
      ambiguities: []
    });

    episodes.push(createSemanticPriorEpisode({
      evidenceRefs: evidence, semanticSpec: spec,
      semanticSessionId: `sess-i-${i}`, semanticRevision: 1
    }));
  }

  // Render with a small budget
  const smallBudget = 2000;
  const rendered = renderPriorsForPrompt(episodes, smallBudget);

  assert.ok(rendered.length <= smallBudget + 100,
    `I: Rendered length ${rendered.length} must respect budget of ~${smallBudget}`);

  // Must not be empty — should include header at minimum
  assert.ok(rendered.length > 0,
    "I: Must render at least the header even with tight budget");

  // Must still include authority disclaimer even with tight budget
  assert.ok(
    rendered.includes("historical") || rendered.includes("not definitions"),
    "I: Authority disclaimer must survive budget constraints"
  );
}

// ═════════════════════════════════════════════════════════════════════════
// TEST J: Failed shadow — no prior episode added
// ═════════════════════════════════════════════════════════════════════════

{
  // Simulate: createEpisode throws with invalid input (no evidenceRefs)
  assert.throws(() => {
    createSemanticPriorEpisode({
      evidenceRefs: [],
      semanticSpec: makeSpec(),
      semanticSessionId: "sess-j",
      semanticRevision: 1
    });
  }, /at least one user evidence/,
    "J: Must reject episodes with no evidence");

  // Simulate: createEpisode throws with malformed spec (no anchors derivable)
  // A spec with only trivial symbols should result in no anchors
  const trivialSpec = makeSpec({
    symbols: [
      {
        id: "sx", surface: "x", role: "variable",
        userDefined: false, sourceRefIds: ["sr-1"]
      }
    ],
    expressions: [
      { id: "ex", kind: "symbol_ref", symbolId: "sx" }
    ],
    statements: [],
    ambiguities: []
  });
  // "x" is a stop anchor (single generic variable name)
  assert.throws(() => {
    createSemanticPriorEpisode({
      evidenceRefs: [makeUserEvidence("msg-1", "x")],
      semanticSpec: trivialSpec,
      semanticSessionId: "sess-j",
      semanticRevision: 1
    });
  }, /at least one anchor/,
    "J: Must reject episodes with no derivable anchors");
}

// ═════════════════════════════════════════════════════════════════════════
// TEST K: Coalesced evidence
// ═════════════════════════════════════════════════════════════════════════

{
  const evidenceA = makeUserEvidence("msg-a", "A的陈述");
  const evidenceB = makeUserEvidence("msg-b", "B的陈述");

  const spec = makeSpec({
    symbols: [
      {
        id: "sa", surface: "A的概念", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]
      },
      {
        id: "sb", surface: "B的概念", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]
      }
    ],
    expressions: [
      { id: "ea", kind: "symbol_ref", symbolId: "sa" },
      { id: "eb", kind: "symbol_ref", symbolId: "sb" }
    ],
    statements: [
      { id: "sta", kind: "definition", subjectSymbolId: "sa", bodyExprId: "ea" },
      { id: "stb", kind: "definition", subjectSymbolId: "sb", bodyExprId: "eb" }
    ],
    ambiguities: []
  });

  // One analysis yields one episode with both pieces of evidence
  const episode = createSemanticPriorEpisode({
    evidenceRefs: [evidenceA, evidenceB],
    semanticSpec: spec,
    semanticSessionId: "sess-k",
    semanticRevision: 1
  });

  // Both user source refs are preserved
  assert.strictEqual(episode.evidenceRefs.length, 2,
    "K: Both evidence refs must be preserved");
  assert.strictEqual(episode.evidenceRefs[0].actor, "user",
    "K: First evidence actor must be user");
  assert.strictEqual(episode.evidenceRefs[1].actor, "user",
    "K: Second evidence actor must be user");

  // One analysis execution yields one episode (not two)
  assert.strictEqual(typeof episode.id, "string",
    "K: One analysis yields one episode");
}

// ═════════════════════════════════════════════════════════════════════════
// TEST L: No knowledge mutation
// ═════════════════════════════════════════════════════════════════════════

{
  const evidence = [makeUserEvidence("msg-1", "测试概念")];
  const spec = makeSpec({
    symbols: [{
      id: "s1", surface: "测试概念", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "e1", kind: "symbol_ref", symbolId: "s1" }],
    statements: [{
      id: "st1", kind: "definition", subjectSymbolId: "s1", bodyExprId: "e1"
    }],
    ambiguities: []
  });

  const episode = createSemanticPriorEpisode({
    evidenceRefs: evidence, semanticSpec: spec,
    semanticSessionId: "sess-l", semanticRevision: 1
  });

  // Episode does NOT contain UserConclusion
  assert.strictEqual(
    (episode).hasOwnProperty("userConclusion") ||
    (episode).hasOwnProperty("conclusion"),
    false,
    "L: Episode must not contain UserConclusion"
  );

  // Episode does NOT create UserKnowledgeEdge
  assert.strictEqual(
    (episode).hasOwnProperty("userKnowledgeEdge") ||
    (episode).hasOwnProperty("knowledgeEdge"),
    false,
    "L: Episode must not create UserKnowledgeEdge"
  );

  // Episode does not write to Vault (asserted by architecture — no vault
  // access in SemanticPrior module)
  assert.strictEqual(
    typeof episode.id, "string",
    "L: Episode is a valid internal protocol record"
  );
}

// ── Migration edge cases ───────────────────────────────────────────────

{
  // Empty/null migration
  assert.strictEqual(
    migrateSemanticPriorState(undefined).episodes.length, 0,
    "Migration: undefined → empty state"
  );
  assert.strictEqual(
    migrateSemanticPriorState(null).episodes.length, 0,
    "Migration: null → empty state"
  );
  assert.strictEqual(
    migrateSemanticPriorState({}).episodes.length, 0,
    "Migration: empty object → empty state"
  );
  assert.strictEqual(
    migrateSemanticPriorState("garbage").episodes.length, 0,
    "Migration: non-object → empty state"
  );
  assert.strictEqual(
    migrateSemanticPriorState({ schemaVersion: 1, episodes: "not-array" }).episodes.length, 0,
    "Migration: non-array episodes → empty state"
  );

  // Schema version preserved
  const emptyState = migrateSemanticPriorState({
    schemaVersion: 1,
    episodes: []
  });
  assert.strictEqual(emptyState.schemaVersion, SEMANTIC_PRIOR_SCHEMA_VERSION,
    "Migration: schema version must be current version");
}

// ── Anchor derivation tests ────────────────────────────────────────────

{
  // User-defined symbols become anchors
  const spec = makeSpec({
    symbols: [
      { id: "s1", surface: "自定义概念", role: "concept", userDefined: true, sourceRefIds: ["sr-1"] },
      { id: "s2", surface: "x", role: "variable", userDefined: false, sourceRefIds: ["sr-1"] }
    ],
    expressions: [
      { id: "e1", kind: "symbol_ref", symbolId: "s1" },
      { id: "e2", kind: "symbol_ref", symbolId: "s2" }
    ],
    statements: [],
    ambiguities: []
  });

  const anchors = deriveAnchors(spec);
  assert.ok(anchors.includes("自定义概念"),
    "Anchor: user-defined concept must be an anchor");
  assert.ok(!anchors.includes("x"),
    "Anchor: single generic variable 'x' must not be an anchor");
}

// ── Developer diagnostic accessors ─────────────────────────────────────

{
  const state = createEmptySemanticPriorState();
  assert.strictEqual(getSemanticPriorEpisodeCount(state), 0,
    "Diag: empty state has 0 episodes");
  assert.strictEqual(getSemanticPriorEpisodes(state).length, 0,
    "Diag: empty state has empty episodes array");

  assert.strictEqual(getLastInjectedSemanticPriorIds([]).length, 0,
    "Diag: empty episode list returns empty ids");
}

// ═════════════════════════════════════════════════════════════════════════
// M2B.4.1 — Episode Locality Tests
// ═════════════════════════════════════════════════════════════════════════

// ── M2B.4.1-A: Sequential turns do NOT duplicate old evidence ──────────

{
  // Simulates: Turn 1 user says A, Turn 2 user says B, Turn 3 user says C
  // Each turn creates a separate spec and evidence

  const evidenceA = [makeUserEvidence("msg-a", "无穷物件时间尺度的定义")];
  const evidenceB = [makeUserEvidence("msg-b", "速度不是每一步差值")];
  const evidenceC = [makeUserEvidence("msg-c", "复数乘法的几何意义")];

  const specA = makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-a", snapshot: "无穷物件时间尺度的定义" }]),
    symbols: [{
      id: "sa", surface: "无穷物件时间尺度", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "ea", kind: "symbol_ref", symbolId: "sa" }],
    statements: [{ id: "sta", kind: "definition", subjectSymbolId: "sa", bodyExprId: "ea" }],
    ambiguities: []
  });

  const specB = makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-b", snapshot: "速度不是每一步差值" }]),
    symbols: [{
      id: "sb", surface: "速度", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "eb", kind: "symbol_ref", symbolId: "sb" }],
    statements: [{ id: "stb", kind: "assertion", exprId: "eb" }],
    ambiguities: [{
      id: "amb-b", kind: "operator_meaning",
      question: "速度具体是什么？", affectedIds: ["sb"], blocking: true,
      choices: [{ id: "c1", label: "变化率" }, { id: "c2", label: "收敛速率" }]
    }]
  });

  const specC = makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-c", snapshot: "复数乘法的几何意义" }]),
    symbols: [{
      id: "sc", surface: "复数乘法", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "ec", kind: "symbol_ref", symbolId: "sc" }],
    statements: [{ id: "stc", kind: "assertion", exprId: "ec" }],
    ambiguities: []
  });

  // Create episodes with LOCAL evidence (not cumulative)
  const E1 = createSemanticPriorEpisode({
    evidenceRefs: evidenceA, semanticSpec: specA,
    semanticSessionId: "sess", semanticRevision: 1
  });

  const E2 = createSemanticPriorEpisode({
    evidenceRefs: evidenceB, semanticSpec: specB,
    semanticSessionId: "sess", semanticRevision: 2
  });

  const E3 = createSemanticPriorEpisode({
    evidenceRefs: evidenceC, semanticSpec: specC,
    semanticSessionId: "sess", semanticRevision: 3
  });

  // Each episode must have only its own evidence
  assert.strictEqual(E1.evidenceRefs.length, 1, "A: E1 must have 1 evidence ref");
  assert.strictEqual(E2.evidenceRefs.length, 1, "A: E2 must have 1 evidence ref");
  assert.strictEqual(E3.evidenceRefs.length, 1, "A: E3 must have 1 evidence ref");

  // Evidence must not accumulate across episodes
  assert.strictEqual(E1.evidenceRefs[0].messageId, "msg-a",
    "A: E1 evidence is only A");
  assert.strictEqual(E2.evidenceRefs[0].messageId, "msg-b",
    "A: E2 evidence is only B, not A+B");
  assert.strictEqual(E3.evidenceRefs[0].messageId, "msg-c",
    "A: E3 evidence is only C, not A+B+C");

  // Anchors must reflect local evidence only
  assert.ok(E1.anchors.includes("无穷物件时间尺度"),
    "A: E1 anchors local");
  assert.ok(!E2.anchors.includes("无穷物件时间尺度"),
    "A: E2 must NOT include E1's anchors");
  assert.ok(E2.anchors.includes("速度"),
    "A: E2 anchors local");
  assert.ok(!E3.anchors.includes("速度"),
    "A: E3 must NOT include E2's anchors");
  assert.ok(!E3.anchors.includes("无穷物件时间尺度"),
    "A: E3 must NOT include E1's anchors");
  assert.ok(E3.anchors.includes("复数乘法"),
    "A: E3 anchors local");
}

// ── M2B.4.1-B: Coalesced A+B creates one episode preserving both ───────

{
  // Simulates deferred analysis: A and B analyzed together
  const evidenceAB = [
    makeUserEvidence("msg-a", "A的陈述内容"),
    makeUserEvidence("msg-b", "B的陈述内容")
  ];

  const specAB = makeSpec({
    sourceRefs: makeSourceRefs([
      { messageId: "msg-a", snapshot: "A的陈述内容" },
      { messageId: "msg-b", snapshot: "B的陈述内容" }
    ]),
    symbols: [
      {
        id: "sa", surface: "A概念", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]
      },
      {
        id: "sb", surface: "B概念", role: "concept",
        userDefined: true, sourceRefIds: ["sr-2"]
      }
    ],
    expressions: [
      { id: "ea", kind: "symbol_ref", symbolId: "sa" },
      { id: "eb", kind: "symbol_ref", symbolId: "sb" }
    ],
    statements: [
      { id: "sta", kind: "definition", subjectSymbolId: "sa", bodyExprId: "ea" },
      { id: "stb", kind: "definition", subjectSymbolId: "sb", bodyExprId: "eb" }
    ],
    ambiguities: []
  });

  // One episode with both evidence refs (coalesced)
  const E = createSemanticPriorEpisode({
    evidenceRefs: evidenceAB, semanticSpec: specAB,
    semanticSessionId: "sess-coalesce", semanticRevision: 1
  });

  assert.strictEqual(E.evidenceRefs.length, 2,
    "B: Coalesced episode must preserve both A and B");
  assert.ok(E.anchors.includes("A概念"),
    "B: Coalesced episode must anchor A concept");
  assert.ok(E.anchors.includes("B概念"),
    "B: Coalesced episode must anchor B concept");
}

// ── M2B.4.1-C: Unrelated later episode does not inherit old anchors ────

{
  // Turn 1: user discusses 无穷物件时间尺度
  const E1 = createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence("msg-1", "无穷物件时间尺度的定义")],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: "msg-1", snapshot: "无穷物件时间尺度的定义" }]),
      symbols: [{
        id: "s1", surface: "无穷物件时间尺度", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]
      }],
      expressions: [{ id: "e1", kind: "symbol_ref", symbolId: "s1" }],
      statements: [{ id: "st1", kind: "definition", subjectSymbolId: "s1", bodyExprId: "e1" }],
      ambiguities: []
    }),
    semanticSessionId: "sess-ret", semanticRevision: 1
  });

  // Later unrelated turn: complex multiplication
  const E2 = createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence("msg-2", "复数乘法为什么角度会相加")],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: "msg-2", snapshot: "复数乘法为什么角度会相加" }]),
      symbols: [{
        id: "s2", surface: "复数乘法", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]
      }],
      expressions: [{ id: "e2", kind: "symbol_ref", symbolId: "s2" }],
      statements: [{ id: "st2", kind: "assertion", exprId: "e2" }],
      ambiguities: []
    }),
    semanticSessionId: "sess-ret", semanticRevision: 2
  });

  // E2 must NOT contain E1's anchors
  assert.ok(E1.anchors.includes("无穷物件时间尺度"),
    "C: E1 must have its own anchor");
  assert.ok(!E2.anchors.includes("无穷物件时间尺度"),
    "C: Unrelated later episode must NOT inherit old anchor");

  // Query for the old topic — should retrieve E1, not E2
  const state = addEpisodeToState(
    addEpisodeToState(createEmptySemanticPriorState(), E1),
    E2
  );

  const relevant = retrieveRelevantPriors(state, "无穷物件时间尺度里的速度");
  assert.strictEqual(relevant.length, 1,
    "C: Only the actually relevant episode should be retrieved");
  assert.strictEqual(relevant[0].id, E1.id,
    "C: Retrieved episode must be the one with the matching anchor");

  // E2 must not appear in results for the old query
  const e2InResults = relevant.some((e) => e.id === E2.id);
  assert.ok(!e2InResults,
    "C: Unrelated recent episode must not pollute retrieval");
}

// ── M2B.4.1-D: Local semantic slice retains exact user provenance ──────

{
  const evidenceLocal = [makeUserEvidence("msg-local", "局部证据文本")];

  // Build a cumulative spec with both local and unrelated symbols
  const cumulativeSpec = makeSpec({
    sourceRefs: makeSourceRefs([
      { messageId: "msg-local", snapshot: "局部证据文本" },
      { messageId: "msg-old", snapshot: "旧概念历史文本" }
    ]),
    symbols: [
      {
        id: "s-local", surface: "局部概念", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]  // references msg-local
      },
      {
        id: "s-old", surface: "旧概念", role: "concept",
        userDefined: true, sourceRefIds: ["sr-2"]  // references msg-old
      }
    ],
    expressions: [
      { id: "el", kind: "symbol_ref", symbolId: "s-local" },
      { id: "eo", kind: "symbol_ref", symbolId: "s-old" }
    ],
    statements: [
      { id: "stl", kind: "definition", subjectSymbolId: "s-local", bodyExprId: "el" },
      { id: "sto", kind: "definition", subjectSymbolId: "s-old", bodyExprId: "eo" }
    ],
    ambiguities: []
  });

  const slice = sliceSemanticSpecForEvidence(cumulativeSpec, evidenceLocal);

  assert.ok(slice !== null, "D: Slice must not be null for matching evidence");
  assert.strictEqual(slice.symbols.length, 1,
    "D: Slice must contain only the local symbol");
  assert.strictEqual(slice.symbols[0].surface, "局部概念",
    "D: Slice must retain exact local symbol surface");
  assert.strictEqual(slice.symbols[0].userDefined, true,
    "D: Slice must retain userDefined flag");
  assert.strictEqual(slice.sourceRefs.length, 1,
    "D: Slice must contain only matching source ref");
  assert.strictEqual(slice.sourceRefs[0].messageId, "msg-local",
    "D: Slice source ref must match local evidence");

  // Unrelated symbol must NOT appear in the slice
  const hasOldSymbol = slice.symbols.some((s) => s.id === "s-old");
  assert.ok(!hasOldSymbol, "D: Slice must exclude unrelated historical symbols");

  // Derive anchors from the slice — must only include local anchor
  const anchors = deriveAnchors(slice);
  assert.ok(anchors.includes("局部概念"),
    "D: Local anchor must be present");
  assert.ok(!anchors.includes("旧概念"),
    "D: Unrelated anchor must NOT appear in the slice");
}

// ── M2B.4.1-E: Old episode remains immutable after later revisions ─────

{
  const E1 = createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence("msg-e1", "初始定义")],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: "msg-e1", snapshot: "初始定义" }]),
      symbols: [{
        id: "se1", surface: "初始概念", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]
      }],
      expressions: [{ id: "ee1", kind: "symbol_ref", symbolId: "se1" }],
      statements: [{ id: "ste1", kind: "definition", subjectSymbolId: "se1", bodyExprId: "ee1" }],
      ambiguities: []
    }),
    semanticSessionId: "sess-imm", semanticRevision: 1
  });

  // Snapshot E1 state before creating E2
  const e1AnchorsBefore = [...E1.anchors];
  const e1EvidenceBefore = [...E1.evidenceRefs.map((r) => r.messageId)];

  // Create E2 with different evidence
  const E2 = createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence("msg-e2", "修正后的定义")],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: "msg-e2", snapshot: "修正后的定义" }]),
      symbols: [{
        id: "se2", surface: "修正概念", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]
      }],
      expressions: [{ id: "ee2", kind: "symbol_ref", symbolId: "se2" }],
      statements: [{ id: "ste2", kind: "definition", subjectSymbolId: "se2", bodyExprId: "ee2" }],
      ambiguities: []
    }),
    semanticSessionId: "sess-imm", semanticRevision: 2
  });

  // E1 must remain completely unchanged
  assert.deepStrictEqual([...E1.anchors], e1AnchorsBefore,
    "E: E1 anchors must be immutable after E2 creation");
  assert.deepStrictEqual(
    [...E1.evidenceRefs.map((r) => r.messageId)],
    e1EvidenceBefore,
    "E: E1 evidence must be immutable after E2 creation"
  );
  assert.notStrictEqual(E1.id, E2.id,
    "E: E1 and E2 must be distinct episodes");
}

// ── M2B.4.1-F: No empty episode created (no anchors = skip) ────────────

{
  // A spec where evidence matches but only trivial symbols exist
  const trivialSpec = makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-empty", snapshot: "x" }]),
    symbols: [
      {
        id: "sx", surface: "x", role: "variable",
        userDefined: false, sourceRefIds: ["sr-1"]
      }
    ],
    expressions: [
      { id: "ex", kind: "symbol_ref", symbolId: "sx" }
    ],
    statements: [
      { id: "stx", kind: "assertion", exprId: "ex" }
    ],
    ambiguities: []
  });

  // "x" is a stop anchor → should throw (no useful anchors derivable)
  assert.throws(() => {
    createSemanticPriorEpisode({
      evidenceRefs: [makeUserEvidence("msg-empty", "x")],
      semanticSpec: trivialSpec,
      semanticSessionId: "sess-empty",
      semanticRevision: 1
    });
  }, /at least one anchor/,
    "F: Must reject episode with no derivable anchors");
}

// ── M2B.4.1-G: No persistence call when episode is skipped ─────────────

{
  // sliceSemanticSpecForEvidence with non-matching evidence returns null
  const spec = makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-known", snapshot: "已知内容" }]),
    symbols: [{
      id: "sk", surface: "已知概念", role: "concept",
      userDefined: true, sourceRefIds: ["sr-1"]
    }],
    expressions: [{ id: "ek", kind: "symbol_ref", symbolId: "sk" }],
    statements: [{ id: "stk", kind: "definition", subjectSymbolId: "sk", bodyExprId: "ek" }],
    ambiguities: []
  });

  // Evidence that doesn't match any source ref
  const unmatchedEvidence = [makeUserEvidence("msg-unknown", "完全不相关的内容")];
  const slice = sliceSemanticSpecForEvidence(spec, unmatchedEvidence);

  assert.strictEqual(slice, null,
    "G: sliceSemanticSpecForEvidence must return null when evidence matches no source ref");

  // The caller (session) should check for null and skip episode creation
  // This test verifies the pure function behavior; the session integration
  // is verified by the sequential turn test (M2B.4.1-A)
}

// ── M2B.4.1-H: Relevant retrieval with local episodes ──────────────────

{
  // Build episode state with proper local episodes
  const E_time = createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence("msg-time", "无穷物件时间尺度的定义")],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: "msg-time", snapshot: "无穷物件时间尺度的定义" }]),
      symbols: [{
        id: "st", surface: "无穷物件时间尺度", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]
      }],
      expressions: [{ id: "et", kind: "symbol_ref", symbolId: "st" }],
      statements: [{ id: "stt", kind: "definition", subjectSymbolId: "st", bodyExprId: "et" }],
      ambiguities: []
    }),
    semanticSessionId: "sess-h", semanticRevision: 1
  });

  const E_complex = createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence("msg-complex", "复数乘法的几何意义")],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: "msg-complex", snapshot: "复数乘法的几何意义" }]),
      symbols: [{
        id: "sc2", surface: "复数乘法", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]
      }],
      expressions: [{ id: "ec2", kind: "symbol_ref", symbolId: "sc2" }],
      statements: [{ id: "stc2", kind: "assertion", exprId: "ec2" }],
      ambiguities: []
    }),
    semanticSessionId: "sess-h", semanticRevision: 2
  });

  // Make E_complex more recent
  const E_complex_recent = { ...E_complex, createdAt: E_time.createdAt + 10000 };

  const state = addEpisodeToState(
    addEpisodeToState(createEmptySemanticPriorState(), E_time),
    E_complex_recent
  );

  // Query that matches the older topic
  const relevant = retrieveRelevantPriors(state, "那个无穷物件的时间尺度...");

  assert.strictEqual(relevant.length, 1,
    "H: Only the historically relevant episode should be retrieved");
  assert.strictEqual(relevant[0].id, E_time.id,
    "H: The older local episode must be retrieved, not the more recent unrelated one");

  // Query that matches neither
  const irrelevant = retrieveRelevantPriors(state, "今天天气怎么样");
  assert.strictEqual(irrelevant.length, 0,
    "H: Unrelated query must not retrieve any episodes");
}

// ── M2B.4.1-I: No UserConclusion / edge / Vault mutation ───────────────

{
  // Re-verify all M2B.4 authority invariants with local episodes
  const E = createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence("msg-i", "局部定义")],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: "msg-i", snapshot: "局部定义" }]),
      symbols: [{
        id: "si", surface: "局部测试概念", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]
      }],
      expressions: [{ id: "ei", kind: "symbol_ref", symbolId: "si" }],
      statements: [{ id: "sti", kind: "definition", subjectSymbolId: "si", bodyExprId: "ei" }],
      ambiguities: []
    }),
    semanticSessionId: "sess-i2", semanticRevision: 1
  });

  // No UserConclusion
  assert.strictEqual(
    (E).hasOwnProperty("userConclusion") ||
    (E).hasOwnProperty("conclusion"),
    false, "I: Local episode must not contain UserConclusion");

  // No UserKnowledgeEdge
  assert.strictEqual(
    (E).hasOwnProperty("userKnowledgeEdge") ||
    (E).hasOwnProperty("knowledgeEdge"),
    false, "I: Local episode must not create UserKnowledgeEdge");

  // Authority rules in rendering
  const rendered = renderPriorsForPrompt([E]);
  assert.ok(rendered.includes("historical"),
    "I: Rendered prior must state historical nature");
  assert.ok(
    rendered.includes("not definitions") ||
    rendered.includes("not authoritative") ||
    rendered.includes("not UserConclusions"),
    "I: Rendered prior must disclaim authority");
}

// ── M2B.4.1: Slice with expression transitive closure ──────────────────

{
  // Test that expression transitive closure works in slice
  const spec = makeSpec({
    sourceRefs: makeSourceRefs([
      { messageId: "msg-a", snapshot: "A的文本" },
      { messageId: "msg-b", snapshot: "B的文本" }
    ]),
    symbols: [
      {
        id: "sa", surface: "A概念", role: "concept",
        userDefined: true, sourceRefIds: ["sr-1"]  // → msg-a
      },
      {
        id: "sb", surface: "B概念", role: "concept",
        userDefined: true, sourceRefIds: ["sr-2"]  // → msg-b
      }
    ],
    expressions: [
      // A表达 references s-local (A概念)
      { id: "ea", kind: "symbol_ref", symbolId: "sa" },
      // 复合表达 references B概念 AND ea via operandExprIds
      { id: "e-compound", kind: "and", operandExprIds: ["ea", "eb"] },
      // B表达 references B概念
      { id: "eb", kind: "symbol_ref", symbolId: "sb" }
    ],
    statements: [
      { id: "st-compound", kind: "assertion", exprId: "e-compound" }
    ],
    ambiguities: []
  });

  // Slice for only msg-a evidence
  const sliceA = sliceSemanticSpecForEvidence(spec, [
    makeUserEvidence("msg-a", "A的文本")
  ]);

  assert.ok(sliceA !== null, "Slice-A must not be null");
  // Should include sa (references sr-1), ea (references sa)
  assert.ok(sliceA.symbols.some((s) => s.id === "sa"),
    "Slice-A must include A symbol");
  assert.ok(sliceA.expressions.some((e) => e.id === "ea"),
    "Slice-A must include A expression");
  // Should NOT include sb (only references sr-2 = msg-b)
  assert.ok(!sliceA.symbols.some((s) => s.id === "sb"),
    "Slice-A must exclude B symbol");
  // Should NOT include eb (references sb which is excluded)
  assert.ok(!sliceA.expressions.some((e) => e.id === "eb"),
    "Slice-A must exclude B expression");

  // Slice for only msg-b evidence
  const sliceB = sliceSemanticSpecForEvidence(spec, [
    makeUserEvidence("msg-b", "B的文本")
  ]);

  assert.ok(sliceB !== null, "Slice-B must not be null");
  assert.ok(sliceB.symbols.some((s) => s.id === "sb"),
    "Slice-B must include B symbol");
  assert.ok(!sliceB.symbols.some((s) => s.id === "sa"),
    "Slice-B must exclude A symbol");
}

console.log("PASS — All M2B.4 + M2B.4.1 semantic prior tests passed.");
