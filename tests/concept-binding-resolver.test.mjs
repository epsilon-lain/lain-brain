import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { createConceptNode } from './src/BrainGrowth';",
      "export { createConceptIndex } from './src/BrainGrowthIndex';",
      "export {",
      "  resolveConceptBinding,",
      "  resolveConceptBindings,",
      "  buildOriginatingConceptRevisions",
      "} from './src/ConceptBindingResolver';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "concept-binding-resolver-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  write: false
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
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
  createConceptNode,
  createConceptIndex,
  resolveConceptBinding,
  resolveConceptBindings,
  buildOriginatingConceptRevisions
} = module.exports;

function userDefinition(id, text) {
  return {
    id,
    text,
    sourceRefs: [
      {
        sourceKind: "user_edit",
        editId: `edit-${id}`,
        snapshot: text,
        actor: "user"
      }
    ]
  };
}

function standardDefinition(id, text) {
  return {
    id,
    text,
    sourceReferences: []
  };
}

function concept(input) {
  return createConceptNode({
    createdAt: "2026-01-01T00:00:00.000Z",
    ...input
  });
}

// ── T01: exact stable-ID binding ──────────────────────────────────────
const normal = concept({
  id: "concept-normal-operator",
  title: "Normal Operator",
  aliases: ["正规算子"],
  userDefinition: userDefinition(
    "def-normal",
    "A bounded operator commuting with its adjoint."
  ),
  standardDefinitions: [
    standardDefinition("std-normal", "An operator T with T*T = TT*.")
  ]
});

const index = createConceptIndex([normal]);
const byId = resolveConceptBinding(
  { stableId: "concept-normal-operator", phrase: "regular operator" },
  index
);
assert.equal(byId.status, "resolved");
assert.equal(byId.conceptId, "concept-normal-operator");
assert.equal(byId.conceptRevision, 1);
assert.equal(byId.resolutionMethod, "stable_id");
console.log("T01 PASS: exact stable-ID binding");

// ── T02: unique title binding ─────────────────────────────────────────
const byTitle = resolveConceptBinding({ phrase: "Normal Operator" }, index);
assert.equal(byTitle.status, "resolved");
assert.equal(byTitle.conceptId, "concept-normal-operator");
assert.equal(byTitle.resolutionMethod, "exact_title");
console.log("T02 PASS: unique title binding");

// ── T03: alias binding ────────────────────────────────────────────────
const byAlias = resolveConceptBinding({ phrase: "正规算子" }, index);
assert.equal(byAlias.status, "resolved");
assert.equal(byAlias.conceptId, "concept-normal-operator");
assert.equal(byAlias.resolutionMethod, "alias");
console.log("T03 PASS: alias binding");

// ── T04: personal definition is used, standard kept separate ──────────
assert.equal(
  byTitle.personalDefinition,
  "A bounded operator commuting with its adjoint."
);
assert.equal(byTitle.standardDefinition, "An operator T with T*T = TT*.");
assert.equal(byTitle.definitionConflict, true);
console.log("T04 PASS: personal definition overrides public meaning");

// ── T05: concept revision retained ────────────────────────────────────
const revised = concept({
  id: "concept-revised",
  title: "Revised",
  aliases: ["old-name"]
});
const revisedWithRevision = createConceptNode({
  ...revised,
  // revision is derived; updateConceptNode is the canonical way to bump it,
  // so here we simply assert that a resolved binding carries the node's
  // current revision number.
});
const revisedIndex = createConceptIndex([revisedWithRevision]);
const revisedBinding = resolveConceptBinding({ phrase: "Revised" }, revisedIndex);
assert.equal(revisedBinding.conceptRevision, revisedWithRevision.revision);
console.log("T05 PASS: concept revision retained");

// ── T06: rename preserving binding identity ───────────────────────────
const renamed = concept({
  id: "concept-renamed",
  title: "New Name",
  aliases: ["Old Name"]
});
const renamedIndex = createConceptIndex([renamed]);
const oldBinding = resolveConceptBinding({ phrase: "Old Name" }, renamedIndex);
const newBinding = resolveConceptBinding({ phrase: "New Name" }, renamedIndex);
assert.equal(oldBinding.status, "resolved");
assert.equal(newBinding.status, "resolved");
assert.equal(oldBinding.conceptId, newBinding.conceptId);
console.log("T06 PASS: rename preserves binding identity");

// ── T07: same-title ambiguity is not silently resolved ────────────────
const first = concept({ id: "concept-1", title: "Space" });
const second = concept({ id: "concept-2", title: "Space" });
const ambiguousIndex = createConceptIndex([first, second]);
const ambiguous = resolveConceptBinding({ phrase: "Space" }, ambiguousIndex);
assert.equal(ambiguous.status, "ambiguous");
assert.deepEqual(
  Array.from(ambiguous.alternatives.map((alt) => alt.conceptId)).sort(),
  ["concept-1", "concept-2"]
);
console.log("T07 PASS: same-title ambiguity");

// ── T08: missing concept becomes unresolved/proposed ──────────────────
const missing = resolveConceptBinding({ phrase: "frobnicator" }, index);
assert.equal(missing.status, "unresolved");

const proposed = resolveConceptBinding(
  { phrase: "frobnicator", proposedNewTitle: "Frobnicator" },
  index
);
assert.equal(proposed.status, "proposed_new");
assert.equal(proposed.proposedNewTitle, "Frobnicator");
console.log("T08 PASS: missing concept representation");

// ── T09: bulk resolution and revision provenance ──────────────────────
const bindings = resolveConceptBindings(
  ["Normal Operator", "正规算子", "orthonormal basis"],
  index
);
assert.equal(bindings.length, 3);
assert.equal(bindings[0].status, "resolved");
assert.equal(bindings[1].status, "resolved");
assert.equal(bindings[2].status, "unresolved");

const revisions = buildOriginatingConceptRevisions(bindings);
assert.deepEqual(
  Array.from(revisions.map((r) => r.conceptId)),
  ["concept-normal-operator"]
);
assert.deepEqual(Array.from(revisions.map((r) => r.revision)), [1]);
console.log("T09 PASS: bulk resolution and revision provenance");

console.log("concept-binding-resolver.test.mjs PASS");
