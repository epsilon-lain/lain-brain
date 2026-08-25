// ── M2B.5 Semantic Retrieval Seeding Tests ────────────────────────────
//
// Covers the M2B.5 smallest coherent slice:
//   10a evidence-text lexical anchors
//   10b SemanticRetrievalQuery type + minimal construction
//   10c structural seed generation from the current SemanticSpec
//   10d cross-episode symbol alignment index
//   10e structure-aware retrieval adjoined to the flat lexical baseline
//
// All checks are deterministic and offline. No provider requests.
// ────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  createSemanticSpec",
      "} from './src/SemanticSpec';",
      "",
      "export {",
      "  createSemanticPriorEpisode,",
      "  createEmptySemanticPriorState,",
      "  addEpisodeToState,",
      "  deriveAnchors,",
      "  deriveEvidenceTextAnchors,",
      "  retrieveRelevantPriors,",
      "  retrieveRelevantPriorsStructured,",
      "  buildEpisodeSymbolIndex,",
      "  renderPriorsForPrompt",
      "} from './src/SemanticPrior';",
      "",
      "export {",
      "  buildSemanticRetrievalQuery,",
      "  deriveLexicalSeedSurfaces,",
      "  createEmptySemanticRetrievalQuery",
      "} from './src/SemanticRetrievalQuery';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "retrieval-seeding-entry.ts",
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

const mod = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  DOMMatrix: class { constructor() {} },
  module: mod,
  exports: mod.exports,
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
  deriveEvidenceTextAnchors,
  retrieveRelevantPriors,
  retrieveRelevantPriorsStructured,
  buildEpisodeSymbolIndex,
  renderPriorsForPrompt,
  buildSemanticRetrievalQuery,
  deriveLexicalSeedSurfaces,
  createEmptySemanticRetrievalQuery
} = mod.exports;

// ── Helpers ────────────────────────────────────────────────────────────

function makeUserEvidence(messageId, snapshot) {
  return { sourceKind: "message_span", messageId, snapshot, actor: "user" };
}

function makeSourceRefs(sources) {
  return sources.map((s, i) => ({
    id: `sr-${i + 1}`,
    messageId: s.messageId ?? `msg-${i + 1}`,
    snapshot: s.snapshot
  }));
}

function makeSpec({ symbols = [], expressions = [], statements = [],
                    ambiguities = [], sourceRefs }) {
  return createSemanticSpec({
    claimId: "test",
    sourceRefs: sourceRefs ?? [{ id: "sr-1", messageId: "msg-1", snapshot: "test" }],
    symbols, expressions, statements, ambiguities
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST A — 10a: evidence-text anchors fix entity-only zero retrieval
// ═════════════════════════════════════════════════════════════════════

{
  const evidence = [makeUserEvidence("msg-b", "lain 最喜欢素子姐姐")];
  const spec = makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-b", snapshot: "lain 最喜欢素子姐姐" }]),
    symbols: [
      { id: "s-motoko", surface: "素子姐姐", role: "entity", userDefined: true,
        sourceRefIds: ["sr-1"] }
    ],
    expressions: [{ id: "e-motoko", kind: "symbol_ref", symbolId: "s-motoko" }],
    statements: [{ id: "st-motoko", kind: "assertion", exprId: "e-motoko" }],
    ambiguities: []
  });

  // Spec-only anchors keep the historical behavior
  const specOnlyAnchors = deriveAnchors(spec);
  assert.ok(specOnlyAnchors.includes("素子姐姐"),
    "A: user-defined entity remains a spec anchor");
  assert.ok(!specOnlyAnchors.includes("最喜欢"),
    "A: spec-only derivation does not invent evidence surfaces");

  // Evidence anchors are deterministic user-language surfaces
  const evidenceAnchors = deriveEvidenceTextAnchors(evidence);
  assert.ok(evidenceAnchors.includes("最喜欢"),
    "A: evidence trigram 最喜欢 must be an anchor");
  assert.ok(evidenceAnchors.includes("喜欢"),
    "A: evidence bigram 喜欢 must be an anchor");
  assert.ok(evidenceAnchors.includes("素子姐姐"),
    "A: evidence run 素子姐姐 must be an anchor");
  assert.ok(evidenceAnchors.includes("lain"),
    "A: alphabetic surface lain must be an anchor");
  assert.ok(!evidenceAnchors.includes("什么"),
    "A: generic interrogatives are not anchored (not in this evidence anyway)");

  const episode = createSemanticPriorEpisode({
    evidenceRefs: evidence, semanticSpec: spec,
    semanticSessionId: "sess-a", semanticRevision: 1
  });
  assert.ok(episode.anchors.includes("最喜欢"),
    "A: episode anchors merge evidence surfaces");

  const state = addEpisodeToState(createEmptySemanticPriorState(), episode);
  const result = retrieveRelevantPriors(state, "lain 最喜欢什么喵？");
  assert.strictEqual(result.length, 1,
    "A: entity-only episode is retrievable via evidence anchors");
  assert.strictEqual(result[0].id, episode.id);
}

// ═════════════════════════════════════════════════════════════════════
// TEST B — 10b Channel 1: lexical seed surfaces
// ═════════════════════════════════════════════════════════════════════

{
  const seeds = deriveLexicalSeedSurfaces("lain 最喜欢什么喵？");
  assert.ok(seeds.includes("最喜欢"), "B: trigram seed present");
  assert.ok(seeds.includes("喜欢"), "B: bigram seed present");
  assert.ok(seeds.includes("lain"), "B: alphabetic seed present");
  assert.ok(!seeds.includes("什么"), "B: stop surface filtered");
  assert.ok(!seeds.includes("喵"), "B: single-char runs never seed");

  assert.deepStrictEqual(deriveLexicalSeedSurfaces("lain 最喜欢什么喵？"), seeds,
    "B: seed derivation is deterministic");
  assert.ok(Object.isFrozen(seeds), "B: seeds are frozen");

  const emptyQuery = createEmptySemanticRetrievalQuery();
  assert.strictEqual(emptyQuery.seedSurfaces.length, 0);
  assert.strictEqual(emptyQuery.subjectRefs.length, 0);
  assert.strictEqual(emptyQuery.relationRefs.length, 0);
  assert.strictEqual(emptyQuery.openSlots.length, 0);
  assert.strictEqual(emptyQuery.temporalIntent, "unspecified");
  assert.strictEqual(emptyQuery.retrievalIntent, "understand_context");
}

// ═════════════════════════════════════════════════════════════════════
// TEST C — 10c: structural seed generation from a SemanticSpec
// ═════════════════════════════════════════════════════════════════════

{
  const spec = makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-q", snapshot: "lain 最喜欢什么喵？" }]),
    symbols: [
      { id: "s-lain", surface: "lain", role: "entity", userDefined: false,
        sourceRefIds: ["sr-1"] },
      { id: "s-fav", surface: "最喜欢", role: "relation", userDefined: true,
        sourceRefIds: ["sr-1"] },
      { id: "s-what", surface: "什么", role: "variable",
        description: "待求的偏好对象", sourceRefIds: ["sr-1"] }
    ],
    expressions: [],
    statements: [],
    ambiguities: [
      { id: "amb-1", kind: "definition_scope", question: "最喜欢的定义是什么？",
        affectedIds: ["s-fav"], blocking: true },
      { id: "amb-2", kind: "other", question: "无关的疑问",
        affectedIds: ["s-lain"], blocking: false }
    ]
  });

  const query = buildSemanticRetrievalQuery({
    utteranceText: "lain 最喜欢什么喵？",
    semanticSpec: spec
  });

  assert.ok(query.seedSurfaces.includes("最喜欢"), "C: lexical channel populated");
  assert.deepStrictEqual(
    Array.from(query.subjectRefs.map((r) => r.surface)),
    ["lain"],
    "C: entity becomes subjectRef"
  );
  assert.strictEqual(query.subjectRefs[0].roleHint, "entity");
  assert.deepStrictEqual(
    Array.from(query.relationRefs.map((r) => [r.surface, r.kind])),
    [["最喜欢", "user_relation"]],
    "C: userDefined relation becomes user_relation ref"
  );
  assert.ok(query.openSlots.some((s) => s.role === "object"),
    "C: variable symbol seeds an object slot");
  assert.ok(query.openSlots.some((s) => s.role === "definition"),
    "C: blocking definition_scope ambiguity seeds a definition slot");
  assert.ok(!query.openSlots.some((s) => s.constraint === "无关的疑问"),
    "C: non-blocking ambiguities do not seed slots");
  assert.strictEqual(query.retrievalIntent, "fill_slot",
    "C: open slots mark fill_slot intent");
  assert.strictEqual(query.temporalIntent, "unspecified");
  assert.ok(Object.isFrozen(query), "C: query is deeply frozen");

  const minimal = buildSemanticRetrievalQuery({ utteranceText: "lain 最喜欢什么喵？" });
  assert.strictEqual(minimal.subjectRefs.length, 0,
    "C: without a spec structural fields stay empty");
  assert.strictEqual(minimal.retrievalIntent, "understand_context");
  assert.ok(minimal.seedSurfaces.length > 0,
    "C: lexical seeds exist even without a spec");
}

// ═════════════════════════════════════════════════════════════════════
// TEST D — 10d: cross-episode symbol alignment index
// ═════════════════════════════════════════════════════════════════════

{
  const mkEpisode = (id, surface, evidenceText) => createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence(id, evidenceText)],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: id, snapshot: evidenceText }]),
      symbols: [
        { id: "s1", surface, role: "relation", userDefined: true,
          sourceRefIds: ["sr-1"] }
      ],
      expressions: [],
      statements: [],
      ambiguities: []
    }),
    semanticSessionId: "sess-d", semanticRevision: 1
  });

  // Pin createdAt explicitly: wall-clock millisecond ties would
  // otherwise make the id tiebreak nondeterministic under the
  // sandboxed randomUUID stub.
  const e1 = { ...mkEpisode("msg-d1", "最喜欢", "甲乙丙丁"), createdAt: 1000 };
  const e2 = { ...mkEpisode("msg-d2", "最喜欢", "戊己庚辛"), createdAt: 2000 };
  const e3 = { ...mkEpisode("msg-d3", "Lain", "壬癸甲乙"), createdAt: 3000 };

  const index = buildEpisodeSymbolIndex([e1, e2, e3]);
  assert.strictEqual(index.get("最喜欢").length, 2,
    "D: shared surface maps to all episodes containing it");
  assert.deepStrictEqual(
    Array.from(index.get("最喜欢").map((entry) => entry.episode.id)),
    [e1.id, e2.id],
    "D: index entries are deterministic"
  );
  assert.ok(index.get("lain") !== undefined,
    "D: surfaces are normalized case-insensitively");
  assert.strictEqual(index.get("lain")[0].userDefined, true);
  assert.strictEqual(index.get("不存在"), undefined,
    "D: unknown surfaces map to nothing");
}

// ═════════════════════════════════════════════════════════════════════
// TEST E — 10e: intersection ranking and userDefined weighting
// ═════════════════════════════════════════════════════════════════════

{
  // Neutral surfaces: no lexical overlap between query text and evidence.
  const mkEpisodeWithSymbols = (msgId, evidenceText, symbols) =>
    createSemanticPriorEpisode({
      evidenceRefs: [makeUserEvidence(msgId, evidenceText)],
      semanticSpec: makeSpec({
        sourceRefs: makeSourceRefs([{ messageId: msgId, snapshot: evidenceText }]),
        symbols,
        expressions: [],
        statements: [],
        ambiguities: []
      }),
      semanticSessionId: "sess-e", semanticRevision: 1
    });

  const eBoth = mkEpisodeWithSymbols("msg-e1", "甲乙丙丁", [
    { id: "s-lain", surface: "lain", role: "entity", userDefined: true,
      sourceRefIds: ["sr-1"] },
    { id: "s-fav", surface: "最喜欢", role: "relation", userDefined: true,
      sourceRefIds: ["sr-1"] }
  ]);
  const eSubjectOnly = mkEpisodeWithSymbols("msg-e2", "戊己庚辛", [
    { id: "s-lain", surface: "lain", role: "entity", userDefined: false,
      sourceRefIds: ["sr-1"] }
  ]);
  const eRelationOnly = mkEpisodeWithSymbols("msg-e3", "壬癸甲乙", [
    { id: "s-fav", surface: "最喜欢", role: "relation", userDefined: false,
      sourceRefIds: ["sr-1"] }
  ]);

  // Make tie-breaks explicit: the intersection episode is the OLDEST.
  const eBothOld = { ...eBoth, createdAt: eSubjectOnly.createdAt - 5000 };
  const eRelationNew = { ...eRelationOnly, createdAt: eSubjectOnly.createdAt + 5000 };

  const state = [eBothOld, eSubjectOnly, eRelationNew].reduce(
    addEpisodeToState, createEmptySemanticPriorState()
  );

  const querySpec = makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-q", snapshot: "子丑寅卯" }]),
    symbols: [
      { id: "q-lain", surface: "lain", role: "entity", sourceRefIds: ["sr-1"] },
      { id: "q-fav", surface: "最喜欢", role: "relation", userDefined: true,
        sourceRefIds: ["sr-1"] }
    ],
    expressions: [],
    statements: [],
    ambiguities: []
  });
  const query = buildSemanticRetrievalQuery({
    utteranceText: "子丑寅卯",
    semanticSpec: querySpec
  });

  const result = retrieveRelevantPriorsStructured(state, "子丑寅卯", query);
  assert.strictEqual(result.length, 3, "E: all structurally related episodes surface");
  assert.strictEqual(result[0].id, eBoth.id,
    "E: subject+relation intersection outranks single matches even when older");
  assert.deepStrictEqual(result.map((e) => e.id),
    retrieveRelevantPriorsStructured(state, "子丑寅卯", query).map((e) => e.id),
    "E: ranking is deterministic");

  // userDefined weighting: same relation surface, only userDefined differs.
  const eUD = mkEpisodeWithSymbols("msg-e4", "天干地支", [
    { id: "s-fav", surface: "最喜欢", role: "relation", userDefined: true,
      sourceRefIds: ["sr-1"] }
  ]);
  // ePlain is created after eUD, so it is NEWER: recency alone would
  // favor it. Its evidence text is disjoint from the query, so lexical
  // and seed channels stay neutral and the userDefined bonus must
  // overcome recency on its own.
  const ePlain = mkEpisodeWithSymbols("msg-e5", "寅午戌亥", [
    { id: "s-fav", surface: "最喜欢", role: "relation", userDefined: false,
      sourceRefIds: ["sr-1"] }
  ]);
  const state2 = [eUD, ePlain].reduce(
    addEpisodeToState, createEmptySemanticPriorState()
  );
  const relationQuery = buildSemanticRetrievalQuery({
    utteranceText: "子丑寅卯",
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: "msg-q2", snapshot: "子丑寅卯" }]),
      symbols: [
        { id: "q-fav", surface: "最喜欢", role: "relation", userDefined: true,
          sourceRefIds: ["sr-1"] }
      ],
      expressions: [],
      statements: [],
      ambiguities: []
    })
  });
  const result2 = retrieveRelevantPriorsStructured(state2, "子丑寅卯", relationQuery);
  assert.strictEqual(result2.length, 2);
  assert.strictEqual(result2[0].id, eUD.id,
    "E: userDefined relation symbol outranks identical non-userDefined one");
}

// ═════════════════════════════════════════════════════════════════════
// TEST F — fail-safe: empty query degrades to the flat lexical result
// ═════════════════════════════════════════════════════════════════════

{
  const mk = (msgId, snapshot, surface) => createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence(msgId, snapshot)],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: msgId, snapshot }]),
      symbols: [
        { id: "s1", surface, role: "entity", userDefined: true,
          sourceRefIds: ["sr-1"] }
      ],
      expressions: [],
      statements: [],
      ambiguities: []
    }),
    semanticSessionId: "sess-f", semanticRevision: 1
  });

  const state = [
    mk("msg-f1", "lain 喜欢猫猫", "猫猫"),
    mk("msg-f2", "lain 最喜欢素子姐姐", "素子姐姐")
  ].reduce(addEpisodeToState, createEmptySemanticPriorState());

  const text = "lain 最喜欢什么喵？";
  const flat = retrieveRelevantPriors(state, text);
  const structured = retrieveRelevantPriorsStructured(
    state, text, createEmptySemanticRetrievalQuery()
  );
  assert.deepStrictEqual(structured.map((e) => e.id), flat.map((e) => e.id),
    "F: empty query reproduces the flat retrieval exactly");
  assert.ok(flat.length >= 1, "F: evidence anchors make episodes retrievable");
}

// ═════════════════════════════════════════════════════════════════════
// TEST G — B1 end-to-end: relation-slot retrieval with a distractor
// ═════════════════════════════════════════════════════════════════════

{
  // History: favorite(lain, 素子姐姐) persisted with an entity-only spec
  // (the realistic minimal LLM output from the M2B.4 regression).
  const eFavorite = createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence("msg-hist", "lain 最喜欢素子姐姐")],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: "msg-hist", snapshot: "lain 最喜欢素子姐姐" }]),
      symbols: [
        { id: "s-lain", surface: "lain", role: "entity", userDefined: true,
          sourceRefIds: ["sr-1"] },
        { id: "s-motoko", surface: "素子姐姐", role: "entity", userDefined: true,
          sourceRefIds: ["sr-1"] }
      ],
      expressions: [],
      statements: [],
      ambiguities: []
    }),
    semanticSessionId: "sess-g", semanticRevision: 1
  });

  // Recent unrelated distractor (B9): newer, no structural overlap.
  const eDistractor = createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence("msg-distract", "今天天气不错出去走走")],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: "msg-distract", snapshot: "今天天气不错出去走走" }]),
      symbols: [
        { id: "s-weather", surface: "天气", role: "concept", userDefined: false,
          sourceRefIds: ["sr-1"] }
      ],
      expressions: [],
      statements: [],
      ambiguities: []
    }),
    semanticSessionId: "sess-g", semanticRevision: 2
  });

  const eDistractorNew = { ...eDistractor, createdAt: eFavorite.createdAt + 9999 };
  const state = [eFavorite, eDistractorNew].reduce(
    addEpisodeToState, createEmptySemanticPriorState()
  );

  // Current shadow spec: lain + user-defined 最喜欢 + an open variable slot.
  const currentSpec = makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-now", snapshot: "lain 最喜欢什么喵？" }]),
    symbols: [
      { id: "q-lain", surface: "lain", role: "entity", userDefined: true,
        sourceRefIds: ["sr-1"] },
      { id: "q-fav", surface: "最喜欢", role: "relation", userDefined: true,
        sourceRefIds: ["sr-1"] },
      { id: "q-what", surface: "什么", role: "variable", sourceRefIds: ["sr-1"] }
    ],
    expressions: [],
    statements: [],
    ambiguities: []
  });

  const query = buildSemanticRetrievalQuery({
    utteranceText: "lain 最喜欢什么喵？",
    semanticSpec: currentSpec
  });
  const result = retrieveRelevantPriorsStructured(state, "lain 最喜欢什么喵？", query);

  assert.ok(result.length >= 1, "G: retrieval is non-empty");
  assert.strictEqual(result[0].id, eFavorite.id,
    "G: the slot-filling episode outranks the newer distractor");
  assert.ok(result[0].evidenceRefs.some((r) => r.snapshot.includes("素子姐姐")),
    "G: the answer surface 素子姐姐 is available to the foreground");
  assert.strictEqual(query.retrievalIntent, "fill_slot");
}

// ═════════════════════════════════════════════════════════════════════
// TEST H — authority and immutability invariants
// ═════════════════════════════════════════════════════════════════════

{
  const state = createEmptySemanticPriorState();
  assert.strictEqual(
    retrieveRelevantPriorsStructured(state, "lain 最喜欢什么喵？",
      createEmptySemanticRetrievalQuery()).length,
    0, "H: empty state retrieves nothing");

  const episode = createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence("msg-h", "lain 喜欢猫猫")],
    semanticSpec: makeSpec({
      sourceRefs: makeSourceRefs([{ messageId: "msg-h", snapshot: "lain 喜欢猫猫" }]),
      symbols: [
        { id: "s-cat", surface: "猫猫", role: "entity", userDefined: true,
          sourceRefIds: ["sr-1"] }
      ],
      expressions: [],
      statements: [],
      ambiguities: []
    }),
    semanticSessionId: "sess-h", semanticRevision: 1
  });
  const state1 = addEpisodeToState(state, episode);

  assert.strictEqual(
    retrieveRelevantPriorsStructured(state1, "", createEmptySemanticRetrievalQuery()).length,
    0, "H: blank utterance retrieves nothing");

  const result = retrieveRelevantPriorsStructured(
    state1, "猫猫", createEmptySemanticRetrievalQuery()
  );
  assert.strictEqual(result.length, 1);
  assert.ok(Object.isFrozen(result), "H: retrieval result is frozen");
  assert.ok(Object.isFrozen(result[0]), "H: episodes remain deeply frozen");
  assert.strictEqual(state1.episodes.length, 1,
    "H: retrieval never mutates prior state");

  // Episode creation guard: evidence anchors can rescue an otherwise
  // anchor-free spec, but truly empty evidence still throws.
  const trivialSpec = makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-t", snapshot: "x" }]),
    symbols: [
      { id: "sx", surface: "x", role: "variable", userDefined: false,
        sourceRefIds: ["sr-1"] }
    ],
    expressions: [{ id: "ex", kind: "symbol_ref", symbolId: "sx" }],
    statements: [],
    ambiguities: []
  });
  const rescued = createSemanticPriorEpisode({
    evidenceRefs: [makeUserEvidence("msg-t", "素子姐姐在散步")],
    semanticSpec: trivialSpec,
    semanticSessionId: "sess-h2", semanticRevision: 1
  });
  assert.ok(rescued.anchors.length > 0,
    "H: user evidence text can anchor an otherwise anchor-free spec");
  assert.throws(() => {
    createSemanticPriorEpisode({
      evidenceRefs: [makeUserEvidence("msg-t2", "x")],
      semanticSpec: trivialSpec,
      semanticSessionId: "sess-h3", semanticRevision: 1
    });
  }, /at least one anchor/,
    "H: truly empty evidence still yields no episode");

  // Rendering path still carries the authority disclaimer.
  const rendered = renderPriorsForPrompt([rescued]);
  assert.ok(rendered.includes("not authoritative"),
    "H: rendered priors keep the authority disclaimer");
}

console.log("semantic-retrieval-seeding.test.mjs PASS");
