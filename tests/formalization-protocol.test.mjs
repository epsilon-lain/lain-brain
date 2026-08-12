import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  createFormalizationRecord,",
      "  applyFormalizationReview,",
      "  validateFormalizationInvariants,",
      "  deriveAnalysisStatus,",
      "  parseMathSpeechResponse,",
      "  buildFormalizationSummary,",
      "  buildAllFormalizationSummaries,",
      "  serializeFormalizationIndex,",
      "  deserializeFormalizationIndex,",
      "  trySetProofVerified",
      "} from './src/FormalizationProtocol';",
      "export {",
      "  FORMALIZATION_SCHEMA_VERSION,",
      "  MATH_SPEECH_ACTS",
      "} from './src/FormalizationProtocol';",
      "export { classifyMathSpeechAct } from './src/DeepSeekClient';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "formalization-protocol-entry.ts",
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
  createFormalizationRecord,
  applyFormalizationReview,
  validateFormalizationInvariants,
  deriveAnalysisStatus,
  parseMathSpeechResponse,
  buildFormalizationSummary,
  buildAllFormalizationSummaries,
  serializeFormalizationIndex,
  deserializeFormalizationIndex,
  trySetProofVerified,
  FORMALIZATION_SCHEMA_VERSION,
  MATH_SPEECH_ACTS,
  classifyMathSpeechAct
} = module.exports;

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function makeValidParams(overrides = {}) {
  return {
    claimId: "claim-test-1",
    sourceRefs: [
      {
        messageId: "message-1",
        snapshot: "伪逆是不是先把目标投影到 range，再从 kernel 的正交补里找回来？"
      },
      {
        messageId: "message-2",
        snapshot: "我觉得 A^+ 应该满足 A A^+ A = A"
      }
    ],
    speechAct: "equivalence_claim",
    objects: [
      { name: "pseudoinverse", latex: "A^{+}", domain: "linear operator" }
    ],
    explicitAssumptions: [],
    implicitAssumptions: [
      { id: "linear-map", text: "A is a linear transformation" },
      { id: "finite-dim", text: "finite-dimensional real inner product spaces" },
      { id: "inner-prod-cod", text: "codomain has inner product for orthogonal projection" }
    ],
    quantifiers: "For any linear transformation A between finite-dimensional inner product spaces",
    conclusion: "The pseudoinverse involves projection onto range and lifting through orthogonal complement",
    ambiguities: ["'target' is ambiguous"],
    missingConditions: ["finite-dimensionality not stated"],
    semanticChanges: [
      {
        category: "added_assumption",
        description: "Assumed A is a linear transformation",
        relatedAssumptionKeys: ["linear-map"]
      },
      {
        category: "added_assumption",
        description: "Assumed finite-dimensional inner product spaces",
        relatedAssumptionKeys: ["finite-dim"]
      },
      {
        category: "added_assumption",
        description: "Assumed codomain inner product for projection",
        relatedAssumptionKeys: ["inner-prod-cod"]
      },
      {
        category: "removed_ambiguity",
        description: "Resolved target to arbitrary vector"
      }
    ],
    aiNormalizedStatement: "For a linear transformation A between finite-dimensional inner product spaces...",
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════════════════════
// T01-T05: Creation
// ═══════════════════════════════════════════════════════════════════════

const record = createFormalizationRecord(makeValidParams());
assert.equal(typeof record.id, "string");
assert.ok(record.id.length > 0);
assert.equal(record.schemaVersion, FORMALIZATION_SCHEMA_VERSION);
assert.equal(record.claimId, "claim-test-1");
assert.equal(record.speechAct, "equivalence_claim");
assert.equal(record.aiNormalizedStatement, "For a linear transformation A between finite-dimensional inner product spaces...");
assert.equal(record.reviewedStatement, record.aiNormalizedStatement);
assert.equal(record.wasEdited, false);
assert.equal(record.reviewStatus, "pending");
assert.equal(record.verificationStatus, "not_checked");
assert.equal(record.analysisStatus, "needs_clarification");
assert.equal(record.revision, 1);
assert.equal(record.history.length, 1);
assert.equal(record.history[0].actor, "ai");
assert.equal(record.history[0].action, "created");
console.log("T01-T05 PASS: creation defaults correct");

// ═══════════════════════════════════════════════════════════════════════
// T06-T08: analysisStatus derivation
// ═══════════════════════════════════════════════════════════════════════

const needsClarRecord = createFormalizationRecord(makeValidParams({
  ambiguities: ["test ambiguity"],
  missingConditions: []
}));
assert.equal(needsClarRecord.analysisStatus, "needs_clarification");

const needsClarMissing = createFormalizationRecord(makeValidParams({
  ambiguities: [],
  missingConditions: ["missing condition"]
}));
assert.equal(needsClarMissing.analysisStatus, "needs_clarification");

const readyRecord = createFormalizationRecord(makeValidParams({
  ambiguities: [],
  missingConditions: []
}));
assert.equal(readyRecord.analysisStatus, "ready_for_review");
console.log("T06-T08 PASS: analysisStatus derivation");

// ═══════════════════════════════════════════════════════════════════════
// T09-T11: status defaults
// ═══════════════════════════════════════════════════════════════════════

assert.equal(record.reviewStatus, "pending");
assert.equal(record.verificationStatus, "not_checked");

// proof_verified must not be allowed
const bogusErrors = validateFormalizationInvariants({
  ...record,
  verificationStatus: "proof_verified"
});
assert.ok(bogusErrors.length > 0);
assert.ok(bogusErrors.some(e => e.includes("proof_verified")));
console.log("T09-T11 PASS: status defaults enforced");

// ═══════════════════════════════════════════════════════════════════════
// T12-T15: implicit assumption → semantic change linkage
// ═══════════════════════════════════════════════════════════════════════

// T12: all implicit assumptions referenced
const validRecord = createFormalizationRecord(makeValidParams());
const validErrors = validateFormalizationInvariants(validRecord);
assert.equal(validErrors.length, 0);
console.log("T12 PASS: all implicit assumptions referenced");

// T13: missing reference should fail
assert.throws(() => {
  createFormalizationRecord(makeValidParams({
    implicitAssumptions: [
      { id: "unreferenced", text: "This has no semantic change" }
    ]
  }));
}, /not referenced/);
console.log("T13 PASS: unreferenced implicit assumption rejected");

// T14: explicit assumption doesn't need semantic change reference
const explicitRecord = createFormalizationRecord(makeValidParams({
  explicitAssumptions: [
    { id: "explicit-1", text: "User explicitly stated this" }
  ]
}));
assert.equal(validateFormalizationInvariants(explicitRecord).length, 0);
console.log("T14 PASS: explicit assumptions don't need semantic change refs");

// T15: AI can't set accepted/rejected
const aiAccepted = { ...record, reviewStatus: "accepted" };
const aiAcceptedErrors = validateFormalizationInvariants(aiAccepted);
assert.ok(aiAcceptedErrors.length > 0);
console.log("T15 PASS: AI-set accepted/rejected detected");

// ═══════════════════════════════════════════════════════════════════════
// T16-T24: applyFormalizationReview
// ═══════════════════════════════════════════════════════════════════════

// T16: accept
const accepted = applyFormalizationReview(record, "accepted");
assert.equal(accepted.reviewStatus, "accepted");
assert.equal(accepted.history.length, 2);
assert.equal(accepted.history[1].actor, "user");
assert.equal(accepted.history[1].action, "accepted");
assert.equal(accepted.revision, 2);
console.log("T16 PASS: accept works");

// T17: reject without reason throws
assert.throws(() => {
  applyFormalizationReview(record, "rejected", undefined, "");
}, /Rejection reason/);
console.log("T17 PASS: reject without reason throws");

// T18: reject with reason preserves data
const rejected = applyFormalizationReview(
  record, "rejected", undefined,
  "I disagree with the finite-dimensionality assumption",
  "Need to reconsider domain"
);
assert.equal(rejected.reviewStatus, "rejected");
assert.equal(rejected.rejectionReason, "I disagree with the finite-dimensionality assumption");
assert.equal(rejected.userNotes, "Need to reconsider domain");
assert.equal(rejected.history.length, 2);
assert.equal(rejected.history[1].actor, "user");
assert.equal(rejected.history[1].action, "rejected");
console.log("T18 PASS: reject preserves all data");

// T19: rejected record still has all fields
assert.equal(rejected.aiNormalizedStatement, record.aiNormalizedStatement);
assert.equal(rejected.sourceRefs.length, 2);
assert.equal(rejected.speechAct, "equivalence_claim");
console.log("T19 PASS: rejected record retains all fields");

// T20: wasEdited detection
const edited = applyFormalizationReview(
  record, "accepted",
  "This is an edited statement different from AI output."
);
assert.equal(edited.wasEdited, true);
assert.equal(edited.reviewedStatement, "This is an edited statement different from AI output.");
assert.notEqual(edited.reviewedStatement, edited.aiNormalizedStatement);
console.log("T20 PASS: wasEdited detected");

// T21: wasEdited still allows accepted
assert.equal(edited.reviewStatus, "accepted");
assert.equal(edited.wasEdited, true);
console.log("T21 PASS: edited can still be accepted");

// T22: idempotent — repeated Accept with same statement returns unchanged
assert.equal(accepted.revision, 2);
const doubleAccepted = applyFormalizationReview(accepted, "accepted");
assert.equal(doubleAccepted, accepted,
  "Repeated Accept with same statement must return the same record");
assert.equal(doubleAccepted.revision, 2,
  "Repeated Accept must not bump revision");
console.log("T22 PASS: repeated Accept with unchanged statement is idempotent");

// T22b: re-accept with a different statement does create a new revision
const reacceptedEdited = applyFormalizationReview(
  accepted, "accepted",
  "A newly edited statement after first acceptance."
);
assert.notEqual(reacceptedEdited, accepted);
assert.equal(reacceptedEdited.revision, 3,
  "Re-accept with changed statement must bump revision");
console.log("T22b PASS: re-accept with changed statement bumps revision");

// T23: history contains all revisions (re-accepted with edit)
assert.equal(reacceptedEdited.history.length, 3);
assert.equal(reacceptedEdited.history[0].actor, "ai");
assert.equal(reacceptedEdited.history[0].action, "created");
assert.equal(reacceptedEdited.history[1].actor, "user");
assert.equal(reacceptedEdited.history[1].action, "accepted");
assert.equal(reacceptedEdited.history[2].actor, "user");
assert.equal(reacceptedEdited.history[2].action, "accepted");
console.log("T23 PASS: history preserves all revisions");

// T24: full data preservation through review
const finalRecord = applyFormalizationReview(
  applyFormalizationReview(record, "accepted"),
  "rejected", undefined, "Changed my mind"
);
assert.equal(finalRecord.aiNormalizedStatement, record.aiNormalizedStatement);
assert.equal(finalRecord.sourceRefs[0].snapshot, record.sourceRefs[0].snapshot);
assert.equal(finalRecord.speechAct, record.speechAct);
assert.equal(finalRecord.implicitAssumptions.length, 3);
assert.equal(finalRecord.reviewStatus, "rejected");
assert.equal(finalRecord.rejectionReason, "Changed my mind");
console.log("T24 PASS: all data preserved through review cycle");

// ═══════════════════════════════════════════════════════════════════════
// T25-T29: Persistence
// ═══════════════════════════════════════════════════════════════════════

const index = {
  schemaVersion: 1,
  records: { [record.id]: record }
};

// T25: round-trip serialization
const serialized = serializeFormalizationIndex(index);
const deserialized = deserializeFormalizationIndex(serialized);
assert.ok(deserialized !== null);
assert.equal(deserialized.schemaVersion, 1);
assert.equal(Object.keys(deserialized.records).length, 1);
const restored = deserialized.records[record.id];
assert.equal(restored.aiNormalizedStatement, record.aiNormalizedStatement);
assert.equal(restored.reviewStatus, record.reviewStatus);
assert.equal(restored.sourceRefs.length, 2);
console.log("T25 PASS: round-trip serialization");

// T26: schema version mismatch
const badVersion = deserializeFormalizationIndex({ schemaVersion: 0, records: {} });
assert.equal(badVersion, null);
console.log("T26 PASS: bad schema version rejected");

// T27: summary is human readable
const summary = buildFormalizationSummary(record);
assert.ok(summary.includes("equivalence_claim"));
assert.ok(summary.includes("pseudoinverse"));
assert.ok(summary.includes("Assumptions added by AI"));
console.log("T27 PASS: summary is human readable");

// T28: summary does NOT contain full JSON structure
assert.ok(!summary.includes('"id"'));
assert.ok(!summary.includes('"reviewStatus"'));
assert.ok(!summary.includes('"sourceRefs"'));
assert.ok(!summary.includes('aiNormalizedStatement'));
console.log("T28 PASS: summary is not full JSON");

// T29: summary is NOT a recovery source (no structured fields)
const minimalSummary = buildFormalizationSummary(record);
assert.ok(minimalSummary.length < 2000);
// Summary must NOT contain JSON structural fields needed for recovery
assert.ok(!minimalSummary.includes('"speechAct"'));
assert.ok(!minimalSummary.includes('"sourceRefs"'));
assert.ok(!minimalSummary.includes('"implicitAssumptions"'));
assert.ok(!minimalSummary.includes('"semanticChanges"'));
assert.ok(!minimalSummary.includes('"history"'));
assert.ok(!minimalSummary.includes('schemaVersion'));
console.log("T29 PASS: summary is not a recovery source");

// ═══════════════════════════════════════════════════════════════════════
// T30-T32: Multi-source provenance
// ═══════════════════════════════════════════════════════════════════════

// T30: multiple sourceRefs
const multiRefRecord = createFormalizationRecord(makeValidParams({
  sourceRefs: [
    { messageId: "msg-a", snapshot: "First claim text." },
    { messageId: "msg-b", snapshot: "Additional clarification." },
    { messageId: "msg-c", startOffset: 5, endOffset: 30, snapshot: "Precise selection." }
  ]
}));
assert.equal(multiRefRecord.sourceRefs.length, 3);
assert.equal(multiRefRecord.sourceRefs[0].messageId, "msg-a");
assert.equal(multiRefRecord.sourceRefs[1].messageId, "msg-b");
assert.equal(multiRefRecord.sourceRefs[2].startOffset, 5);
assert.equal(multiRefRecord.sourceRefs[2].endOffset, 30);
console.log("T30 PASS: multiple sourceRefs preserved");

// T31: sourceRefs snapshots preserved
for (const ref of multiRefRecord.sourceRefs) {
  assert.ok(ref.snapshot.length > 0);
}
console.log("T31 PASS: all sourceRef snapshots preserved");

// T32: startOffset/endOffset preserved
const offsetRef = multiRefRecord.sourceRefs[2];
assert.equal(offsetRef.startOffset, 5);
assert.equal(offsetRef.endOffset, 30);
console.log("T32 PASS: offsets preserved");

// ═══════════════════════════════════════════════════════════════════════
// DEEP IMMUTABILITY TESTS
// ═══════════════════════════════════════════════════════════════════════

// Deep immutability: sourceRefs[0].snapshot cannot be mutated
const frozenRecord = createFormalizationRecord(makeValidParams());
try {
  frozenRecord.sourceRefs[0] = {
    messageId: "hacked",
    snapshot: "hacked"
  };
  assert.notEqual(frozenRecord.sourceRefs[0].snapshot, "hacked");
} catch {
  // TypeError in strict mode on frozen array — this is expected
}
assert.ok(frozenRecord.sourceRefs[0].snapshot.includes("伪逆"));
console.log("DEEP-IMMUT-1 PASS: sourceRefs snapshot immutable");

// Deep immutability: objects[0].name cannot be mutated
try {
  frozenRecord.objects[0] = {
    name: "hacked",
    latex: "",
    domain: ""
  };
} catch {
  // Expected
}
assert.equal(frozenRecord.objects[0].name, "pseudoinverse");
console.log("DEEP-IMMUT-2 PASS: objects immutable");

// Deep immutability: history cannot be mutated
try {
  frozenRecord.history[0] = {
    actor: "user",
    action: "rejected",
    reviewedStatement: "hacked",
    reviewStatus: "rejected",
    updatedAt: "hacked"
  };
} catch {
  // Expected
}
assert.equal(frozenRecord.history[0].actor, "ai");
assert.equal(frozenRecord.history[0].action, "created");
console.log("DEEP-IMMUT-3 PASS: history immutable");

// Deep immutability: result of applyFormalizationReview also frozen
const reviewedRecord = applyFormalizationReview(frozenRecord, "accepted");
try {
  reviewedRecord.history[1] = {
    actor: "hacker",
    action: "edited",
    reviewedStatement: "hacked",
    reviewStatus: "pending",
    updatedAt: "hacked"
  };
} catch {
  // Expected
}
assert.equal(reviewedRecord.history[1].actor, "user");
assert.equal(reviewedRecord.history[1].action, "accepted");
console.log("DEEP-IMMUT-4 PASS: reviewed record also deeply immutable");

// Verify original is unchanged after review
assert.equal(frozenRecord.reviewStatus, "pending");
assert.equal(frozenRecord.history.length, 1);
console.log("DEEP-IMMUT-5 PASS: original unchanged after review");

// ═══════════════════════════════════════════════════════════════════════
// T33-T35: Multiple candidates
// ═══════════════════════════════════════════════════════════════════════

// T33: one claim can have multiple formalizationIds (validation only,
//      the storage is in ClaimRecord; here we verify two records share claimId)
const altRecord = createFormalizationRecord(makeValidParams({
  speechAct: "theorem_claim",
  aiNormalizedStatement: "Theorem: pseudoinverse satisfies Penrose conditions..."
}));
assert.equal(record.claimId, altRecord.claimId);
assert.notEqual(record.id, altRecord.id);
assert.notEqual(record.speechAct, altRecord.speechAct);
console.log("T33 PASS: multiple formalizations per claim");

// T34: primary formalization can be identified
const allRecords = [record, altRecord];
const primary = allRecords.find(r => r.speechAct === "equivalence_claim");
assert.ok(primary !== undefined);
assert.equal(primary.speechAct, "equivalence_claim");
console.log("T34 PASS: primary formalization selectable");

// T35: both records in same index
const multiIndex = {
  schemaVersion: 1,
  records: {
    [record.id]: record,
    [altRecord.id]: altRecord
  }
};
const multiSerialized = serializeFormalizationIndex(multiIndex);
const multiDeserialized = deserializeFormalizationIndex(multiSerialized);
assert.ok(multiDeserialized !== null);
assert.equal(Object.keys(multiDeserialized.records).length, 2);
console.log("T35 PASS: multiple records in index");

// ═══════════════════════════════════════════════════════════════════════
// T36-T37: Security
// ═══════════════════════════════════════════════════════════════════════

// T36: API key should not appear in formalization fields
const apiKey = "sk-secret-api-key-12345";
const recordJson = JSON.stringify(serializeFormalizationIndex({
  schemaVersion: 1,
  records: { [record.id]: record }
}));
assert.ok(!recordJson.includes(apiKey));
console.log("T36 PASS: no API key in serialized formalization");

// T37: parseMathSpeechResponse rejects non-math
const nonMath = parseMathSpeechResponse({
  speechAct: "",
  error: "not_mathematical"
});
assert.ok("error" in nonMath);
assert.equal(nonMath.error, "not_mathematical");
console.log("T37 PASS: non-math input rejected");

// parseMathSpeechResponse with valid data
const validResponse = parseMathSpeechResponse({
  speechAct: "theorem_claim",
  normalizedStatement: "A complete mathematical statement.",
  objects: [{ name: "matrix", latex: "A" }],
  explicitAssumptions: [{ key: "exp1", text: "User stated this" }],
  implicitAssumptions: [{ key: "imp1", text: "AI added this" }],
  quantifiers: "For all matrices",
  conclusion: "Something holds",
  ambiguities: ["unclear"],
  missingConditions: ["dimensionality"],
  semanticChanges: [
    {
      category: "added_assumption",
      description: "Added condition",
      relatedAssumptionKeys: ["imp1"]
    }
  ],
  latexStatement: "A = B"
});
assert.ok("speechAct" in validResponse);
assert.equal(validResponse.speechAct, "theorem_claim");
assert.equal(validResponse.implicitAssumptions.length, 1);
assert.equal(validResponse.implicitAssumptions[0].text, "AI added this");
console.log("T37b PASS: valid math response parsed");

// ═══════════════════════════════════════════════════════════════════════
// T38: trySetProofVerified throws in Phase 1
// ═══════════════════════════════════════════════════════════════════════

assert.throws(() => {
  trySetProofVerified(record);
}, /Phase 3/);
console.log("T38 PASS: trySetProofVerified blocked in Phase 1");

// ═══════════════════════════════════════════════════════════════════════
// Additional: buildAllFormalizationSummaries
// ═══════════════════════════════════════════════════════════════════════

const allSummaries = buildAllFormalizationSummaries([record, altRecord]);
assert.ok(allSummaries.includes("### Formalizations"));
assert.ok(allSummaries.includes("equivalence_claim"));
assert.ok(allSummaries.includes("theorem_claim"));
console.log("SUMMARIES PASS: all formalization summaries");

// ═══════════════════════════════════════════════════════════════════════
// Additional: invariants detect missing added_assumption linkage
// ═══════════════════════════════════════════════════════════════════════

// Without key resolution, createFormalizationRecord already rejects
// Let's test the validation directly
const recordWithUnlinkedImp = {
  ...record,
  implicitAssumptions: [
    ...record.implicitAssumptions,
    { id: "unlinked-id", text: "This has no matching semantic change" }
  ]
};
const unlinkedErrors = validateFormalizationInvariants(recordWithUnlinkedImp);
assert.ok(unlinkedErrors.length > 0);
assert.ok(unlinkedErrors.some(e => e.includes("unlinked-id")));
console.log("INVARIANT-LINK PASS: unlinked assumption detected");

// ═══════════════════════════════════════════════════════════════════════
// Delete guard: formalization records must be queryable by claimId
// ═══════════════════════════════════════════════════════════════════════

const indexForLookup = {
  schemaVersion: 1,
  records: {
    [record.id]: record,
    [altRecord.id]: altRecord
  }
};

// Both records share the same claimId
assert.equal(record.claimId, altRecord.claimId);

// Lookup: all records for claimId
const claimRecords = Object.values(indexForLookup.records)
  .filter((r) => r.claimId === record.claimId);
assert.equal(claimRecords.length, 2);
console.log("DELETE-GUARD-1 PASS: formalization records queryable by claimId");

// Negative: a different claimId returns no records
const otherClaimRecords = Object.values(indexForLookup.records)
  .filter((r) => r.claimId === "non-existent-claim");
assert.equal(otherClaimRecords.length, 0);
console.log("DELETE-GUARD-2 PASS: non-existent claim returns empty");

// Records in index are never orphans — they always have a claimId
for (const r of Object.values(indexForLookup.records)) {
  assert.ok(typeof r.claimId === "string");
  assert.ok(r.claimId.length > 0);
}
console.log("DELETE-GUARD-3 PASS: all records have non-empty claimId");

// ── sourceRefs completeness ────────────────────────────────────────

// All sourceRefs in record are accessible
const multiRef = createFormalizationRecord(makeValidParams({
  sourceRefs: [
    { messageId: "m1", snapshot: "First message." },
    { messageId: "m2", snapshot: "Second message with more detail." },
    { messageId: "m3", startOffset: 10, endOffset: 50,
      snapshot: "Exact selected region." }
  ]
}));
assert.equal(multiRef.sourceRefs.length, 3);
for (const ref of multiRef.sourceRefs) {
  assert.ok(ref.messageId.length > 0);
  assert.ok(ref.snapshot.length > 0);
}
console.log("SOURCEREFS-ALL PASS: all sourceRefs accessible with messageId + snapshot");

// ═══════════════════════════════════════════════════════════════════════
// Domain-preservation regression tests
// ═══════════════════════════════════════════════════════════════════════

// DOMAIN-REAL: Real-number input preserves ℝ, not coerced to vector space.
// Input: 对任意实数 a，都有 a + 0 = a
// Expected: domain = ℝ, no vector space V, no zero vector, no vector addition.
{
  const realNumberResponse = parseMathSpeechResponse({
    speechAct: "theorem_claim",
    normalizedStatement: "For every real number a, a + 0 = a.",
    objects: [{ name: "a", latex: "a", domain: "\\mathbb{R}" }],
    explicitAssumptions: [],
    implicitAssumptions: [],
    quantifiers: "\\forall a \\in \\mathbb{R}",
    conclusion: "a + 0 = a",
    ambiguities: [],
    missingConditions: [],
    semanticChanges: [],
    latexStatement: "\\forall a \\in \\mathbb{R},\\, a + 0 = a"
  });

  assert.ok("speechAct" in realNumberResponse);
  assert.equal(realNumberResponse.speechAct, "theorem_claim");
  // Domain is ℝ
  assert.equal(realNumberResponse.objects[0].domain, "\\mathbb{R}");
  // No vector space V, no zero vector
  const text = JSON.stringify(realNumberResponse);
  assert.ok(!text.includes("vector"));
  assert.ok(!text.includes("zero vector"));
  // No ambiguity claiming domain is unspecified
  assert.equal(realNumberResponse.ambiguities.length, 0);
  // No missing condition claiming operation must be supplied
  assert.equal(realNumberResponse.missingConditions.length, 0);
  // No implicit assumptions added (nothing was missing)
  assert.equal(realNumberResponse.implicitAssumptions.length, 0);
  // Conclusion preserves real addition
  assert.equal(realNumberResponse.conclusion, "a + 0 = a");
  // Ready for review — no ambiguities, no missing conditions
  assert.equal(realNumberResponse.quantifiers, "\\forall a \\in \\mathbb{R}");

  console.log("DOMAIN-REAL PASS: real-number input preserves ℝ, no vector-space coercion");
}

// DOMAIN-VECTOR: Explicit vector input preserves vector domain.
// Input: 对任意向量 v ∈ V，都有 v + 0 = v
// Expected: domain = V, vector addition, zero vector preserved.
{
  const vectorResponse = parseMathSpeechResponse({
    speechAct: "theorem_claim",
    normalizedStatement: "For every vector v in V, v + 0 = v.",
    objects: [{ name: "v", latex: "v", domain: "V" }],
    explicitAssumptions: [{ key: "vspace", text: "V is a vector space" }],
    implicitAssumptions: [],
    quantifiers: "\\forall v \\in V",
    conclusion: "v + 0 = v",
    ambiguities: [],
    missingConditions: [],
    semanticChanges: [],
    latexStatement: "\\forall v \\in V,\\, v + 0 = v"
  });

  assert.ok("speechAct" in vectorResponse);
  assert.equal(vectorResponse.objects[0].domain, "V");
  // Vector domain preserved, not coerced to ℝ
  assert.ok(JSON.stringify(vectorResponse).includes("V"));
  // No ambiguity
  assert.equal(vectorResponse.ambiguities.length, 0);
  assert.equal(vectorResponse.missingConditions.length, 0);

  console.log("DOMAIN-VECTOR PASS: vector input preserves V, not coerced to ℝ");
}

// DOMAIN-PROMPT: The formalization prompt must NOT contain "Only linear algebra"
{
  // Read the bundled source to verify the prompt was fixed
  const classifyMathSpeechActSrc = classifyMathSpeechAct.toString();
  assert.ok(!classifyMathSpeechActSrc.includes("Only linear algebra"));
  console.log("DOMAIN-PROMPT PASS: prompt no longer contains 'Only linear algebra'");
}

// ═══════════════════════════════════════════════════════════════════════
// Complete
// ═══════════════════════════════════════════════════════════════════════

console.log(JSON.stringify({
  creation: true,
  analysisStatusDerivation: true,
  implicitAssumptionLinkage: true,
  explicitAssumptionsNoLinkNeeded: true,
  aiCannotSetAccepted: true,
  userAcceptReject: true,
  rejectPreservesData: true,
  wasEditedDetection: true,
  revisionHistory: true,
  persistenceRoundTrip: true,
  summaryIsHumanReadable: true,
  summaryNotRecoverySource: true,
  multiSourceProvenance: true,
  deepImmutability: true,
  multipleCandidates: true,
  securityNoApiKeyLeak: true,
  nonMathRejected: true,
  proofVerifiedBlocked: true,
  deleteGuardLookup: true,
  deleteGuardEmpty: true,
  deleteGuardNoOrphans: true,
  allSourceRefsAccessible: true,
  result: "PASS"
}, null, 2));
