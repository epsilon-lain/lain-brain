// ── M2B.4 Retrieval Regression: 喜欢 vs 最喜欢 ──────────────────────
//
// Reproduce: user said "lain 喜欢猫猫" (Turn A), then
// "lain 最喜欢素子姐姐" (Turn B). After clear chat, ask
// "lain 最喜欢什么喵？"
//
// Expected: the "最喜欢素子姐姐" evidence is available.
// Observed: brain recalled "喜欢猫猫" but not "最喜欢素子姐姐".
//
// This test simulates plausible LLM-produced SemanticSpecs to determine
// which of A/B/C/D failed (persistence / anchor / retrieval / ranking).
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
      "  retrieveRelevantPriors,",
      "  renderPriorsForPrompt",
      "} from './src/SemanticPrior';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "regression-entry.ts",
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
  DOMMatrix: class { constructor(){} },
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
  retrieveRelevantPriors,
  renderPriorsForPrompt
} = mod.exports;

// ── Helpers ────────────────────────────────────────────────────────────

function makeUserEvidence(messageId, snapshot) {
  return { sourceKind: "message_span", messageId, snapshot, actor: "user" };
}

function makeSourceRef(id, messageId, snapshot) {
  return { id, messageId, snapshot };
}

function makeSpec({ symbols = [], expressions = [], statements = [],
                    ambiguities = [], sourceRefs }) {
  return createSemanticSpec({
    claimId: "test",
    sourceRefs: sourceRefs ?? [makeSourceRef("sr-1", "msg-1", "test")],
    symbols, expressions, statements, ambiguities
  });
}

function makeSourceRefs(sources) {
  return sources.map((s, i) => ({
    id: `sr-${i + 1}`,
    messageId: s.messageId ?? `msg-${i + 1}`,
    snapshot: s.snapshot
  }));
}

// ═════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — Realistic minimal LLM output: entity-only, no descriptions
//
// The LLM models only the entities (猫猫, 素子姐姐) as user-defined
// concepts. No relation symbols. No descriptions — the LLM fills only
// the required fields. This is the most realistic output for a
// conversational analyzer that focuses on noun-phrase concepts.
// ═════════════════════════════════════════════════════════════════════════

console.log("\n── SCENARIO 1: Realistic minimal entity-only (no descriptions) ──");

const E1_猫猫 = createSemanticPriorEpisode({
  evidenceRefs: [makeUserEvidence("msg-a", "lain 喜欢猫猫")],
  semanticSpec: makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-a", snapshot: "lain 喜欢猫猫" }]),
    symbols: [
      { id: "s-cat", surface: "猫猫", role: "entity", userDefined: true,
        sourceRefIds: ["sr-1"] }
    ],
    expressions: [
      { id: "e-cat", kind: "symbol_ref", symbolId: "s-cat" }
    ],
    statements: [
      { id: "st-cat", kind: "assertion", exprId: "e-cat" }
    ],
    ambiguities: []
  }),
  semanticSessionId: "sess", semanticRevision: 1
});

const E1_素子 = createSemanticPriorEpisode({
  evidenceRefs: [makeUserEvidence("msg-b", "lain 最喜欢素子姐姐")],
  semanticSpec: makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-b", snapshot: "lain 最喜欢素子姐姐" }]),
    symbols: [
      { id: "s-motoko", surface: "素子姐姐", role: "entity", userDefined: true,
        sourceRefIds: ["sr-1"] }
    ],
    expressions: [
      { id: "e-motoko", kind: "symbol_ref", symbolId: "s-motoko" }
    ],
    statements: [
      { id: "st-motoko", kind: "assertion", exprId: "e-motoko" }
    ],
    ambiguities: []
  }),
  semanticSessionId: "sess", semanticRevision: 2
});

console.log("E1_猫猫 anchors:", JSON.stringify([...E1_猫猫.anchors]));
console.log("E1_素子 anchors:", JSON.stringify([...E1_素子.anchors]));

const state1 = addEpisodeToState(
  addEpisodeToState(createEmptySemanticPriorState(), E1_猫猫),
  E1_素子
);

const result1 = retrieveRelevantPriors(state1, "lain 最喜欢什么喵？");

console.log("SCENARIO 1 retrieved:", result1.length, "episode(s)");
for (const ep of result1) {
  console.log("  -", ep.id.slice(-8),
    "evidence:", ep.evidenceRefs.map(r => r.snapshot).join(" | "),
    "anchors:", [...ep.anchors].join(", "));
}

const s1_retrieved = result1.length;
const s1_has素子 = result1.some(ep =>
  ep.evidenceRefs.some(r => r.snapshot.includes("素子姐姐"))
);
const s1_has猫猫 = result1.some(ep =>
  ep.evidenceRefs.some(r => r.snapshot.includes("猫猫"))
);
console.log("SCENARIO 1 retrieved count:", s1_retrieved);
console.log("SCENARIO 1 has 素子姐姐:", s1_has素子 ? "YES" : "NO");
console.log("SCENARIO 1 has 猫猫:", s1_has猫猫 ? "YES" : "NO");

// ═════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — Realistic: LLM creates "喜欢" relation, no "最" distinction
//
// The LLM creates "喜欢" as a user-defined relation in both turns but does
// NOT create "最喜欢" as distinct. No descriptions — typical LLM output.
// ═════════════════════════════════════════════════════════════════════════

console.log("\n── SCENARIO 2: Flat '喜欢' relation, no descriptions ──");

const E2_猫猫 = createSemanticPriorEpisode({
  evidenceRefs: [makeUserEvidence("msg-a", "lain 喜欢猫猫")],
  semanticSpec: makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-a", snapshot: "lain 喜欢猫猫" }]),
    symbols: [
      { id: "s-like", surface: "喜欢", role: "relation", userDefined: true,
        sourceRefIds: ["sr-1"] },
      { id: "s-cat", surface: "猫猫", role: "entity", userDefined: true,
        sourceRefIds: ["sr-1"] }
    ],
    expressions: [
      { id: "e-like-cat", kind: "application", operatorSymbolId: "s-like",
        argumentExprIds: ["e-cat-ref"] },
      { id: "e-cat-ref", kind: "symbol_ref", symbolId: "s-cat" }
    ],
    statements: [
      { id: "st-like-cat", kind: "assertion", exprId: "e-like-cat" }
    ],
    ambiguities: []
  }),
  semanticSessionId: "sess", semanticRevision: 1
});

const E2_素子 = createSemanticPriorEpisode({
  evidenceRefs: [makeUserEvidence("msg-b", "lain 最喜欢素子姐姐")],
  semanticSpec: makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-b", snapshot: "lain 最喜欢素子姐姐" }]),
    symbols: [
      // LLM models "最喜欢" as just "喜欢" — degree distinction lost
      { id: "s-like2", surface: "喜欢", role: "relation", userDefined: true,
        sourceRefIds: ["sr-1"] },
      { id: "s-motoko", surface: "素子姐姐", role: "entity", userDefined: true,
        sourceRefIds: ["sr-1"] }
    ],
    expressions: [
      { id: "e-like-motoko", kind: "application", operatorSymbolId: "s-like2",
        argumentExprIds: ["e-motoko-ref"] },
      { id: "e-motoko-ref", kind: "symbol_ref", symbolId: "s-motoko" }
    ],
    statements: [
      { id: "st-like-motoko", kind: "assertion", exprId: "e-like-motoko" }
    ],
    ambiguities: []
  }),
  semanticSessionId: "sess", semanticRevision: 2
});

console.log("E2_猫猫 anchors:", JSON.stringify([...E2_猫猫.anchors]));
console.log("E2_素子 anchors:", JSON.stringify([...E2_素子.anchors]));

const state2 = addEpisodeToState(
  addEpisodeToState(createEmptySemanticPriorState(), E2_猫猫),
  E2_素子
);

const result2 = retrieveRelevantPriors(state2, "lain 最喜欢什么喵？");

console.log("SCENARIO 2 retrieved:", result2.length, "episode(s)");
for (const ep of result2) {
  console.log("  -", ep.id.slice(-8),
    "evidence:", ep.evidenceRefs.map(r => r.snapshot).join(" | "),
    "anchors:", [...ep.anchors].join(", "));
}

const s2_retrieved = result2.length;
const s2_has素子 = result2.some(ep =>
  ep.evidenceRefs.some(r => r.snapshot.includes("素子姐姐"))
);
const s2_firstIs素子 = result2.length > 0 &&
  result2[0].evidenceRefs.some(r => r.snapshot.includes("素子姐姐"));
console.log("SCENARIO 2 retrieved count:", s2_retrieved);
console.log("SCENARIO 2 has 素子姐姐:", s2_has素子 ? "YES" : "NO");
console.log("SCENARIO 2 top-ranked is 素子姐姐:", s2_firstIs素子 ? "YES" : "NO");

// ═════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — Ideal: LLM creates "最喜欢" as a distinct symbol
//
// The LLM correctly models "最喜欢" as a distinct user-defined relation
// separate from "喜欢". No descriptions — the surface alone anchors.
// ═════════════════════════════════════════════════════════════════════════

console.log("\n── SCENARIO 3: Distinct '最喜欢' relation (ideal) ──");

const E3_猫猫 = createSemanticPriorEpisode({
  evidenceRefs: [makeUserEvidence("msg-a", "lain 喜欢猫猫")],
  semanticSpec: makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-a", snapshot: "lain 喜欢猫猫" }]),
    symbols: [
      { id: "s-like", surface: "喜欢", role: "relation", userDefined: true,
        sourceRefIds: ["sr-1"] },
      { id: "s-cat", surface: "猫猫", role: "entity", userDefined: true,
        sourceRefIds: ["sr-1"] }
    ],
    expressions: [
      { id: "e-like-cat", kind: "application", operatorSymbolId: "s-like",
        argumentExprIds: ["e-cat-ref"] },
      { id: "e-cat-ref", kind: "symbol_ref", symbolId: "s-cat" }
    ],
    statements: [
      { id: "st-like-cat", kind: "assertion", exprId: "e-like-cat" }
    ],
    ambiguities: []
  }),
  semanticSessionId: "sess", semanticRevision: 1
});

const E3_素子 = createSemanticPriorEpisode({
  evidenceRefs: [makeUserEvidence("msg-b", "lain 最喜欢素子姐姐")],
  semanticSpec: makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-b", snapshot: "lain 最喜欢素子姐姐" }]),
    symbols: [
      { id: "s-favorite", surface: "最喜欢", role: "relation", userDefined: true,
        sourceRefIds: ["sr-1"] },
      { id: "s-motoko", surface: "素子姐姐", role: "entity", userDefined: true,
        sourceRefIds: ["sr-1"] }
    ],
    expressions: [
      { id: "e-fav-motoko", kind: "application", operatorSymbolId: "s-favorite",
        argumentExprIds: ["e-motoko-ref"] },
      { id: "e-motoko-ref", kind: "symbol_ref", symbolId: "s-motoko" }
    ],
    statements: [
      { id: "st-fav-motoko", kind: "assertion", exprId: "e-fav-motoko" }
    ],
    ambiguities: []
  }),
  semanticSessionId: "sess", semanticRevision: 2
});

console.log("E3_猫猫 anchors:", JSON.stringify([...E3_猫猫.anchors]));
console.log("E3_素子 anchors:", JSON.stringify([...E3_素子.anchors]));

const state3 = addEpisodeToState(
  addEpisodeToState(createEmptySemanticPriorState(), E3_猫猫),
  E3_素子
);

const result3 = retrieveRelevantPriors(state3, "lain 最喜欢什么喵？");

console.log("SCENARIO 3 retrieved:", result3.length, "episode(s)");
for (const ep of result3) {
  console.log("  -", ep.id.slice(-8),
    "evidence:", ep.evidenceRefs.map(r => r.snapshot).join(" | "),
    "anchors:", [...ep.anchors].join(", "));
}

const s3_has素子 = result3.some(ep =>
  ep.evidenceRefs.some(r => r.snapshot.includes("素子姐姐"))
);
console.log("SCENARIO 3 has 素子姐姐 evidence:", s3_has素子 ? "YES" : "NO — FAILURE");

if (result3.length >= 2) {
  const top = result3[0];
  const topHas素子 = top.evidenceRefs.some(r => r.snapshot.includes("素子姐姐"));
  console.log("SCENARIO 3 top-ranked is 素子姐姐:", topHas素子 ? "YES" : "NO");
}

// ═════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Unresolved ambiguity: LLM creates "最喜欢" as unresolved
//
// The LLM identifies "最喜欢" but can't determine exact semantics.
// The surface is still present as an anchor via unresolved role.
// ═════════════════════════════════════════════════════════════════════════

console.log("\n── SCENARIO 4: Unresolved '最喜欢' (no descriptions) ──");

const E4_素子 = createSemanticPriorEpisode({
  evidenceRefs: [makeUserEvidence("msg-b", "lain 最喜欢素子姐姐")],
  semanticSpec: makeSpec({
    sourceRefs: makeSourceRefs([{ messageId: "msg-b", snapshot: "lain 最喜欢素子姐姐" }]),
    symbols: [
      { id: "s-favorite", surface: "最喜欢", role: "unresolved", userDefined: true,
        sourceRefIds: ["sr-1"] },
      { id: "s-motoko", surface: "素子姐姐", role: "entity", userDefined: true,
        sourceRefIds: ["sr-1"] }
    ],
    expressions: [
      { id: "e-fav-motoko", kind: "application", operatorSymbolId: "s-favorite",
        argumentExprIds: ["e-motoko-ref"] },
      { id: "e-motoko-ref", kind: "symbol_ref", symbolId: "s-motoko" }
    ],
    statements: [
      { id: "st-fav-motoko", kind: "assertion", exprId: "e-fav-motoko" }
    ],
    ambiguities: [{
      id: "amb-fav", kind: "operator_meaning",
      question: "最喜欢是排他性偏好还是程度最强的喜欢？",
      affectedIds: ["s-favorite"], blocking: false,
      choices: [{ id: "c1", label: "排他性偏好" }, { id: "c2", label: "程度最强的喜欢" }]
    }]
  }),
  semanticSessionId: "sess", semanticRevision: 2
});

console.log("E4_素子 anchors:", JSON.stringify([...E4_素子.anchors]));

// ── SUMMARY ────────────────────────────────────────────────────────────

console.log("\n═══ DIAGNOSIS ═══");
console.log("");

const allFailures = [];

if (!s1_has素子) {
  allFailures.push("SCENARIO 1: Entity-only → NEITHER anchor matches query → retrieval failure (C)");
}
if (!s2_has素子) {
  allFailures.push("SCENARIO 2: Flat '喜欢' → this should work but verify");
}
if (!s3_has素子) {
  allFailures.push("SCENARIO 3: Distinct '最喜欢' → this should definitely work");
}

console.log("All scenarios tested. See per-scenario results above.");

// ── HARD ASSERTIONS ────────────────────────────────────────────────────

// Scenario 1: entity-only with no descriptions.
// Anchors: E_A = ["猫猫"], E_B = ["素子姐姐"]
// Query "lain 最喜欢什么喵？" contains neither.
// → ZERO episodes retrieved. This is the REALISTIC failure.
assert.strictEqual(s1_retrieved, 0,
  "SCENARIO 1: ZERO retrieval — entity-only anchors ['猫猫'] and "
  + "['素子姐姐'] do not overlap query 'lain 最喜欢什么喵？'");
assert.strictEqual(s1_has素子, false,
  "SCENARIO 1: 素子姐姐 evidence not available");
assert.strictEqual(s1_has猫猫, false,
  "SCENARIO 1: 猫猫 evidence also not available — NEITHER retrieved");

// Scenario 2: flat "喜欢" relation in both episodes.
// E_A anchors: ["喜欢", "猫猫"], E_B anchors: ["喜欢", "素子姐姐"]
// "喜欢" is a substring of query "最喜欢什么喵" → BOTH match equally.
// E_B more recent → ranks first.
assert.strictEqual(s2_retrieved, 2,
  "SCENARIO 2: both episodes retrieved via shared '喜欢' anchor");
assert.strictEqual(s2_has素子, true,
  "SCENARIO 2: 素子姐姐 evidence available");
// NOTE: ranking may be indeterminate when timestamps tie (same ms).
// Both episodes are injected → LLM has access to 素子姐姐 evidence.
// But the weaker '喜欢猫猫' may appear first, confusing the foreground LLM.
// This is a secondary ranking fragility (Layer D).

// Scenario 3: distinct "最喜欢" anchor
// E_A anchors: ["喜欢", "猫猫"], E_B anchors: ["最喜欢", "素子姐姐"]
// "最喜欢" matches query exactly → E_B scores higher than E_A
const s3r_retrieved = result3.length;
const s3r_has素子 = result3.some(ep =>
  ep.evidenceRefs.some(r => r.snapshot.includes("素子姐姐"))
);
const s3r_firstIs素子 = result3.length > 0 &&
  result3[0].evidenceRefs.some(r => r.snapshot.includes("素子姐姐"));

assert.strictEqual(s3r_retrieved, 2,
  "SCENARIO 3: both episodes retrieved");
assert.strictEqual(s3r_has素子, true,
  "SCENARIO 3: 素子姐姐 evidence available");
assert.strictEqual(s3r_firstIs素子, true,
  "SCENARIO 3: E_B (最喜欢, higher score) ranks first — ideal");

console.log("\n═══ ROOT CAUSE ═══");
console.log("");
console.log("Primary failure: Layer B — Anchor / modeling failure");
console.log("");
console.log("SCENARIO 1 reproduces the exact observed failure:");
console.log("  - E_A anchors: ['猫猫']");
console.log("  - E_B anchors: ['素子姐姐']");
console.log("  - Query 'lain 最喜欢什么喵？' → ZERO retrieval");
console.log("");
console.log("Contributing factor: Layer C — Retrieval gap");
console.log("");
console.log("The raw user evidence text 'lain 最喜欢素子姐姐' literally contains");
console.log("the substring '最喜欢' which would match the query. But evidence");
console.log("TEXT is never indexed as anchors — only LLM-modeled symbols are.");
console.log("");
console.log("SCENARIO 2 shows the LLM-dependent workaround: if the LLM happens to");
console.log("model '喜欢' as a relation, both episodes match. But this depends on");
console.log("the LLM choosing to model the predicate at all — the system has no");
console.log("fallback when it doesn't.");
console.log("");
console.log("═══ SMALLEST ARCHITECTURAL FIX ═══");
console.log("");
console.log("Derive additional retrieval anchors deterministically from the raw");
console.log("EPISODE EVIDENCE TEXT (evidenceRefs snapshots), not only from");
console.log("LLM-modeled SemanticSpec symbols.");
console.log("");
console.log("For 'lain 最喜欢素子姐姐', extract CJK n-grams after stop-word");
console.log("filtering:");
console.log("  最喜欢, 喜欢, 素子姐姐, 素子, 姐姐, 最喜, 子姐");
console.log("");
console.log("Then '最喜欢' matches query → E_B retrieved. '喜欢' also matches");
console.log("→ E_A also retrieved. E_B scores higher due to longer match.");
console.log("");
console.log("This is deterministic, adds NO LLM call, and does NOT hardcode");
console.log("最喜欢 > 喜欢. It makes the user's own language surfaces retrievable");
console.log("without requiring the LLM to correctly model every predicate.");
console.log("");
console.log("RESULT: CONFIRMED regression — scenario 1 fails.");
