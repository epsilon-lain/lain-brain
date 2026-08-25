import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { createPersonalSemanticIR } from './src/PersonalSemanticIR';",
      "export { createConceptIndex } from './src/BrainGrowthIndex';",
      "export {",
      "  BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION,",
      "  addBrainFormalization,",
      "  serializeBrainFormalizationMemory,",
      "  deserializeBrainFormalizationMemory,",
      "  getMemoryByRecordId,",
      "  getMemoryByIRId,",
      "  listConceptBindingsForRecord,",
      "  listFormalizationsReferencingConcept,",
      "  compareBrainFormalizationConcepts,",
      "  deriveSemanticStaleness,",
      "  updateBrainFormalizationLeanStatus",
      "} from './src/BrainFormalizationMemory';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "brain-formalization-memory-entry.ts",
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
  createPersonalSemanticIR,
  createConceptIndex,
  BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION,
  addBrainFormalization,
  serializeBrainFormalizationMemory,
  deserializeBrainFormalizationMemory,
  getMemoryByRecordId,
  getMemoryByIRId,
  listConceptBindingsForRecord,
  listFormalizationsReferencingConcept,
  compareBrainFormalizationConcepts,
  deriveSemanticStaleness,
  updateBrainFormalizationLeanStatus
} = module.exports;

function makeIR(overrides = {}) {
  return createPersonalSemanticIR({
    source: {
      messageId: "msg-1",
      snapshot: "Let T be a normal operator."
    },
    originalExpression: "Let T be a normal operator.",
    speechAct: "theorem_claim",
    authority: "ai_interpreted",
    canonicalStatement: "Every normal operator has an orthonormal eigenbasis.",
    quantifiers: "For every normal operator T",
    conclusion: "T has an orthonormal basis of eigenvectors.",
    conceptBindings: [
      {
        id: "bind-normal",
        surfacePhrase: "normal operator",
        status: "resolved",
        conceptId: "concept-normal-operator",
        conceptRevision: 3,
        resolvedTitle: "Normal Operator",
        resolutionMethod: "exact_title",
        personalDefinition: "A bounded operator commuting with its adjoint.",
        standardDefinition: "An operator T with T*T = TT*.",
        definitionConflict: true
      }
    ],
    objects: [
      { id: "obj-T", name: "T", domain: "operator", boundConceptId: "bind-normal" }
    ],
    claims: [
      {
        id: "claim-1",
        kind: "theorem",
        statement: "Every normal operator has an orthonormal eigenbasis.",
        quantifiers: "For every normal operator T",
        sourceQuantifiers: "For every normal operator T",
        authority: "ai_interpreted"
      }
    ],
    assumptions: [
      {
        id: "asmp-1",
        text: "T acts on a finite-dimensional space.",
        kind: "implicit",
        addedByAI: true
      }
    ],
    relations: [],
    proofSteps: [],
    unresolvedItems: [],
    ambiguities: [],
    resolvedAmbiguities: [],
    missingConditions: [],
    removedAssumptions: [],
    semanticChanges: [
      {
        category: "added_assumption",
        description: "Assumed finite-dimensionality.",
        relatedAssumptionIds: ["asmp-1"]
      }
    ],
    originatingConceptRevisions: [
      {
        conceptId: "concept-normal-operator",
        revision: 3,
        title: "Normal Operator",
        matchedBy: "exact_title"
      }
    ],
    ...overrides
  });
}

const evaluation = {
  resolvedConceptCount: 1,
  ambiguousConceptCount: 0,
  unresolvedConceptCount: 0,
  explicitAssumptionCount: 0,
  addedImplicitAssumptionCount: 1,
  semanticDiffCategories: ["assumption_added"],
  edited: false,
  formalizationCreated: true,
  leanTypecheckResult: "not_checked",
  leanProofResult: "unverified"
};

function addRecord(memory, recordId = "record-1", ir = makeIR()) {
  return addBrainFormalization(memory, {
    ir,
    recordId,
    claimId: "claim-1",
    sourceMessageId: "msg-1",
    acceptedAt: "2026-08-16T00:00:00.000Z",
    edited: false,
    evaluation
  });
}

// ── T01: add + round-trip preserves lineage ────────────────────────────
const empty = { schemaVersion: BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION, records: {} };
const added = addRecord(empty);
assert.equal(added.created, true);
assert.equal(added.record.irId, added.record.ir.id);
assert.equal(added.record.recordId, "record-1");
assert.equal(added.record.conceptBindings[0].conceptId, "concept-normal-operator");
assert.equal(added.record.conceptBindings[0].conceptRevision, 3);

const serialized = serializeBrainFormalizationMemory(added.memory);
const reloaded = deserializeBrainFormalizationMemory(
  JSON.parse(JSON.stringify(serialized))
);
assert.equal(reloaded.diagnostics.length, 0);
const reloadedRecord = getMemoryByRecordId(reloaded.memory, "record-1");
assert.equal(reloadedRecord.irId, added.record.irId);
assert.equal(reloadedRecord.conceptBindings[0].conceptRevision, 3);
assert.equal(reloadedRecord.ir.canonicalStatement, added.record.ir.canonicalStatement);
console.log("T01 PASS: round-trip preserves lineage");

// ── T02: bidirectional query + reverse lookup ──────────────────────────
assert.equal(
  getMemoryByIRId(added.memory, added.record.irId).recordId,
  "record-1"
);
assert.equal(
  Array.from(listConceptBindingsForRecord(added.memory, "record-1")).length,
  1
);
assert.equal(
  Array.from(
    listFormalizationsReferencingConcept(added.memory, "concept-normal-operator")
  ).length,
  1
);
console.log("T02 PASS: query and reverse lookup");

// ── T03: duplicate accept is idempotent ────────────────────────────────
const replay = addRecord(added.memory);
assert.equal(replay.created, false);
assert.equal(Object.keys(added.memory.records).length, 1);
console.log("T03 PASS: idempotent accept");

// ── T04: concept evolution keeps history stable ────────────────────────
const currentConcept = {
  id: "concept-normal-operator",
  title: "Normal Operator (revised)",
  aliases: [],
  revision: 4,
  userDefinition: {
    text: "A bounded operator whose adjoint commutes with its square."
  },
  standardDefinitions: [],
  relationships: []
};
const freshness = compareBrainFormalizationConcepts(
  added.record,
  createConceptIndex([currentConcept])
);
assert.equal(freshness[0].status, "definition_changed");
assert.equal(freshness[0].historicalRevision, 3);
assert.equal(freshness[0].currentRevision, 4);
assert.equal(deriveSemanticStaleness(freshness), "changed");
assert.equal(added.record.conceptBindings[0].conceptRevision, 3);
console.log("T04 PASS: concept evolution keeps history stable");

// ── T05: rename with same revision is not stale ────────────────────────
const renamed = {
  id: "concept-normal-operator",
  title: "Renamed Operator",
  aliases: [],
  revision: 3,
  userDefinition: {
    text: "A bounded operator commuting with its adjoint."
  },
  standardDefinitions: [],
  relationships: []
};
const renamedFreshness = compareBrainFormalizationConcepts(
  added.record,
  createConceptIndex([renamed])
);
assert.equal(renamedFreshness[0].status, "unchanged");
assert.equal(deriveSemanticStaleness(renamedFreshness), "current");
console.log("T05 PASS: rename with stable identity is not stale");

// ── T06: missing concept is reported, history retained ─────────────────
const missingFreshness = compareBrainFormalizationConcepts(
  added.record,
  createConceptIndex([])
);
assert.equal(missingFreshness[0].status, "missing");
assert.equal(deriveSemanticStaleness(missingFreshness), "unavailable");
assert.ok(getMemoryByRecordId(added.memory, "record-1"));
console.log("T06 PASS: missing concept reported");

// ── T07: Lean status updates independently, IR untouched ───────────────
const beforeIR = added.record.ir.canonicalStatement;
const leanUpdated = updateBrainFormalizationLeanStatus(
  added.memory,
  "record-1",
  { statementStatus: "statement_typechecked", proofStatus: "unverified" }
);
assert.equal(leanUpdated.updated, true);
assert.equal(leanUpdated.record.lean.statementStatus, "statement_typechecked");
assert.equal(leanUpdated.record.lean.proofStatus, "unverified");
assert.equal(leanUpdated.record.ir.canonicalStatement, beforeIR);
console.log("T07 PASS: Lean status update does not rewrite IR");

// ── T08: partial/corrupt data returns diagnostics ──────────────────────
const badIR = deserializeBrainFormalizationMemory({
  schemaVersion: 1,
  records: {
    "bfm-record-bad": {
      memoryId: "bfm-record-bad",
      schemaVersion: 1,
      irId: "ir-bad",
      recordId: "record-bad",
      claimId: "claim-bad",
      sourceMessageId: "msg-bad",
      sourceSnapshot: "bad",
      acceptedAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      reviewDecision: "accepted",
      conceptBindings: [],
      semanticDiffCategories: [],
      editedBeforeAcceptance: false,
      ir: { schemaVersion: 999 },
      evaluation: {},
      lean: {}
    }
  }
});
assert.equal(badIR.diagnostics.length, 1);
assert.equal(Object.keys(badIR.memory.records).length, 0);

const futureSchema = deserializeBrainFormalizationMemory({ schemaVersion: 999 });
assert.equal(futureSchema.diagnostics.length, 1);
assert.equal(Object.keys(futureSchema.memory.records).length, 0);
console.log("T08 PASS: partial/corrupt data diagnostics");

// ── T09: privacy / data minimization ───────────────────────────────────
const serializedText = JSON.stringify(serializeBrainFormalizationMemory(added.memory));
assert.doesNotMatch(serializedText, /sk-/);
assert.doesNotMatch(serializedText, /api[_-]?key/i);
assert.doesNotMatch(serializedText, /unrelated personal note/i);
assert.doesNotMatch(serializedText, /deepseek raw response/i);
console.log("T09 PASS: privacy/data minimization");

console.log("brain-formalization-memory.test.mjs PASS");

