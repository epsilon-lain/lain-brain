import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { createPersonalSemanticIR } from './src/PersonalSemanticIR';",
      "export {",
      "  BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION,",
      "  addBrainFormalization,",
      "  serializeBrainFormalizationMemory,",
      "  deserializeBrainFormalizationMemory,",
      "  synchronizeBrainFormalizationStatus,",
      "  getMemoryByRecordId",
      "} from './src/BrainFormalizationMemory';",
      "export { parsePersonalSemanticIRResponse } from './src/BrainAwareFormalizationAnalyzer';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "brain-formalization-status-sync-entry.ts",
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
  BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION,
  addBrainFormalization,
  serializeBrainFormalizationMemory,
  deserializeBrainFormalizationMemory,
  synchronizeBrainFormalizationStatus,
  getMemoryByRecordId,
  parsePersonalSemanticIRResponse
} = module.exports;

function makeIR() {
  return createPersonalSemanticIR({
    source: {
      messageId: "msg-1",
      snapshot: "Every normal operator has an orthonormal eigenbasis."
    },
    originalExpression: "Every normal operator has an orthonormal eigenbasis.",
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
        resolutionMethod: "exact_title"
      }
    ],
    objects: [],
    claims: [
      {
        id: "claim-1",
        kind: "theorem",
        statement: "Every normal operator has an orthonormal eigenbasis.",
        authority: "ai_interpreted"
      }
    ],
    assumptions: [],
    relations: [],
    proofSteps: [],
    unresolvedItems: [],
    ambiguities: [],
    resolvedAmbiguities: [],
    missingConditions: [],
    removedAssumptions: [],
    semanticChanges: [],
    originatingConceptRevisions: [
      {
        conceptId: "concept-normal-operator",
        revision: 3,
        title: "Normal Operator",
        matchedBy: "exact_title"
      }
    ]
  });
}

const evaluation = {
  resolvedConceptCount: 1,
  ambiguousConceptCount: 0,
  unresolvedConceptCount: 0,
  explicitAssumptionCount: 0,
  addedImplicitAssumptionCount: 0,
  semanticDiffCategories: [],
  edited: false,
  formalizationCreated: true,
  leanTypecheckResult: "not_checked",
  leanProofResult: "unverified"
};

function addRecord(memory, ir = makeIR()) {
  return addBrainFormalization(memory, {
    ir,
    recordId: "record-1",
    claimId: "claim-1",
    sourceMessageId: "msg-1",
    acceptedAt: "2026-08-16T00:00:00.000Z",
    edited: false,
    evaluation
  });
}

const empty = { schemaVersion: BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION, records: {} };
const added = addRecord(empty);
const beforeIR = added.record.ir;

// ── T01: statement typecheck mirrors without proof ─────────────────────
const typechecked = synchronizeBrainFormalizationStatus(
  added.memory,
  "record-1",
  "statement_typechecked"
);
assert.equal(typechecked.updated, true);
assert.equal(typechecked.record.lean.statementStatus, "statement_typechecked");
assert.equal(typechecked.record.lean.proofStatus, "unverified");
assert.equal(typechecked.record.evaluation.leanTypecheckResult, "statement_typechecked");
assert.equal(typechecked.record.evaluation.leanProofResult, "unverified");
assert.equal(typechecked.record.ir, beforeIR);
console.log("T01 PASS: typecheck mirrors without proof");

// ── T02: proof_verified mirrors with distinct proof status ─────────────
const verified = synchronizeBrainFormalizationStatus(
  typechecked.memory,
  "record-1",
  "proof_verified"
);
assert.equal(verified.updated, true);
assert.equal(verified.record.lean.statementStatus, "statement_typechecked");
assert.equal(verified.record.lean.proofStatus, "proof_verified");
assert.equal(verified.record.evaluation.leanProofResult, "proof_verified");
assert.equal(verified.record.ir, beforeIR);
console.log("T02 PASS: proof_verified mirrors distinctly");

// ── T03: semantic acceptance is not verification ──────────────────────
const accepted = addRecord(empty);
assert.equal(accepted.record.lean.statementStatus, "not_checked");
assert.equal(accepted.record.lean.proofStatus, "unverified");
assert.equal(accepted.record.evaluation.leanTypecheckResult, "not_checked");
assert.equal(accepted.record.evaluation.leanProofResult, "unverified");
console.log("T03 PASS: semantic acceptance is not verification");

// ── T04: typecheck is not proof ────────────────────────────────────────
assert.notEqual(typechecked.record.lean.proofStatus, "proof_verified");
console.log("T04 PASS: typecheck is not proof");

// ── T05: idempotent status synchronization ─────────────────────────────
const replay = synchronizeBrainFormalizationStatus(
  verified.memory,
  "record-1",
  "proof_verified"
);
assert.equal(replay.updated, false);
assert.equal(replay.record.lean.proofStatus, "proof_verified");
console.log("T05 PASS: idempotent synchronization");

// ── T06: transient error does not erase historical proof ───────────────
const errored = synchronizeBrainFormalizationStatus(
  verified.memory,
  "record-1",
  "error"
);
assert.equal(errored.record.lean.statementStatus, "error");
assert.equal(errored.record.lean.proofStatus, "proof_verified");
console.log("T06 PASS: error preserves historical proof");

// ── T07: deliberate not_checked reset mirrors authoritative reset ──────
const reset = synchronizeBrainFormalizationStatus(
  verified.memory,
  "record-1",
  "not_checked"
);
assert.equal(reset.record.lean.statementStatus, "not_checked");
assert.equal(reset.record.lean.proofStatus, "unverified");
console.log("T07 PASS: not_checked reset mirrors authoritative reset");

// ── T08: reload preserves verification lineage ─────────────────────────
const serialized = serializeBrainFormalizationMemory(verified.memory);
const reloaded = deserializeBrainFormalizationMemory(
  JSON.parse(JSON.stringify(serialized))
);
const reloadedRecord = getMemoryByRecordId(reloaded.memory, "record-1");
assert.equal(reloadedRecord.lean.statementStatus, "statement_typechecked");
assert.equal(reloadedRecord.lean.proofStatus, "proof_verified");
assert.equal(reloadedRecord.ir.id, beforeIR.id);
assert.equal(reloadedRecord.conceptBindings[0].conceptRevision, 3);
console.log("T08 PASS: reload preserves verification lineage");

// ── T09: model output cannot contain verification authority ────────────
const modelAttempt = parsePersonalSemanticIRResponse({
  speechAct: "theorem_claim",
  canonicalStatement: "Every A is P.",
  quantifiers: "For every A",
  conclusion: "A has P.",
  proof_verified: true,
  verificationStatus: "proof_verified",
  leanAccepted: true,
  conceptBindings: [],
  objects: [],
  claims: [{ kind: "theorem", statement: "Every A is P." }],
  assumptions: [],
  relations: [],
  proofSteps: [],
  ambiguities: [],
  resolvedAmbiguities: [],
  missingConditions: [],
  removedAssumptions: [],
  semanticChanges: []
});
assert.equal("proof_verified" in modelAttempt, false);
assert.equal("verificationStatus" in modelAttempt, false);
console.log("T09 PASS: model cannot verify");

console.log("brain-formalization-status-sync.test.mjs PASS");

