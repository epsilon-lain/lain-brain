import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/BrainGrowth";
      export * from "./src/SemanticDelta";
      export * from "./src/SemanticPropagation";
      export * from "./src/SemanticDeltaState";
      export * from "./src/StructuralConflict";
      export * from "./src/BrainDiagnostics";
    `,
    resolveDir: process.cwd(),
    sourcefile: "structural-conflict-entry.ts",
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
  module, exports: module.exports, require, console, Object, Map, Set, JSON, Math
});
const api = module.exports;
assert.deepEqual(JSON.parse(JSON.stringify(
  api.STRUCTURAL_CONFLICT_RULES.map((rule) => rule.id)
)), [
  "DISTINCTION_VS_EQUIVALENCE",
  "REMOVED_RELATIONSHIP_STILL_ACTIVE",
  "DUPLICATE_DISTINCTION"
]);
const at = (n) => `2026-08-15T06:${String(n).padStart(2, "0")}:00.000Z`;
const relation = (id, type, target) => ({
  id,
  relation: type,
  targetConceptId: target,
  targetLabel: target.toUpperCase(),
  sourceReferences: [`source:${id}`]
});
const concept = (id, relationships = []) => api.createConceptNode({
  id: `concept-${id}`,
  title: id.toUpperCase(),
  relationships,
  createdAt: at(0)
});
const confirmRelationshipDelta = (previous, next, minute = 1) => {
  const proposal = api.proposePrincipalSemanticDelta({
    previous,
    next,
    proposedAt: at(minute),
    originRef: `test:${previous.id}:${minute}`,
    reason: "Explicit structural test change"
  });
  assert.equal(proposal.kind, "proposed");
  const confirmation = api.confirmSemanticDelta(proposal.delta, {
    kind: "explicit_semantic_delta_confirmation",
    confirmedAt: at(minute),
    confirmation: {
      kind: "maintenance_confirmation",
      confirmationId: `confirmation-${minute}`,
      interactionRef: `test:${minute}`,
      userEvidence: []
    }
  });
  assert.equal(confirmation.kind, "confirmed");
  return confirmation.delta;
};

assert.deepEqual(
  { ...api.classifyRelationshipForDiagnostics("depends_on") },
  { category: "dependency", symmetry: "directional" }
);
assert.equal(api.classifyRelationshipForDiagnostics("derived_from").symmetry,
  "directional");
assert.equal(api.classifyRelationshipForDiagnostics("example_of").symmetry,
  "directional");
assert.equal(api.classifyRelationshipForDiagnostics("part_of").symmetry,
  "directional");
assert.equal(api.classifyRelationshipForDiagnostics("analogous_to").category,
  "analogy");
assert.equal(api.classifyRelationshipForDiagnostics("related_to").category,
  "association");
assert.equal(api.classifyRelationshipForDiagnostics("explicitly_distinct_from").symmetry,
  "symmetric");

const b = concept("b");
const analogyA = concept("analogy-a", [
  relation("analogy", "analogous_to", b.id),
  relation("analogy-distinct", "explicitly_distinct_from", b.id)
]);
const analogyBefore = JSON.stringify([analogyA, b]);
const analogyReport = api.detectStructuralConflicts({
  concepts: [analogyA, b],
  detectedAt: at(1)
});
assert.equal(analogyReport.conflicts.some((item) =>
  item.category === "hard_conflict"), false);
assert.equal(JSON.stringify([analogyA, b]), analogyBefore);

const oldA = concept("a", [relation("equiv", "equivalent_to", b.id)]);
const nextA = api.addConceptRelationship(oldA,
  relation("distinct", "explicitly_distinct_from", b.id), {
    changedAt: at(2), reason: "Explicitly distinguish A and B"
  });
const delta = confirmRelationshipDelta(oldA, nextA, 2);
const stateBefore = JSON.stringify([nextA, b, delta]);
const hardReport = api.detectStructuralConflicts({
  concepts: [nextA, b],
  confirmedDeltas: [delta],
  detectedAt: delta.confirmedAt,
  affectedConceptIds: [nextA.id, b.id]
});
assert.equal(hardReport.conflicts.length, 1);
const hard = hardReport.conflicts[0];
assert.equal(hard.ruleId, "DISTINCTION_VS_EQUIVALENCE");
assert.equal(hard.category, "hard_conflict");
assert.equal(hard.severity, "conflict");
assert.deepEqual([...hard.affectedConceptIds], [nextA.id, b.id].sort());
assert.deepEqual([...hard.provenance.originatingSemanticDeltaIds], [delta.id]);
assert.equal(JSON.stringify([nextA, b, delta]), stateBefore);

const firstReconcile = api.reconcileStructuralConflicts({
  existing: [], report: hardReport, recordedAt: at(2), interactionRef: delta.id
});
const replayReconcile = api.reconcileStructuralConflicts({
  existing: firstReconcile, report: hardReport, recordedAt: at(2),
  interactionRef: delta.id
});
assert.equal(replayReconcile.length, 1);
assert.equal(replayReconcile[0].id, hard.id);
let decisions = api.reconcileStructuralConflictPendingDecisions(
  replayReconcile, []
);
decisions = api.reconcileStructuralConflictPendingDecisions(
  replayReconcile, decisions
);
assert.equal(decisions.length, 1);
assert.equal(decisions[0].kind, "structural_conflict");
assert.equal(decisions[0].structuralConflictId, hard.id);

const dismissed = api.dismissStructuralConflict(replayReconcile, hard.id, {
  dismissedAt: at(3), interactionRef: "maintenance:a"
});
assert.equal(dismissed[0].status, "dismissed");
const dismissedReplay = api.reconcileStructuralConflicts({
  existing: dismissed, report: hardReport, recordedAt: at(3),
  interactionRef: delta.id
});
assert.equal(dismissedReplay.length, 1);
assert.equal(dismissedReplay[0].status, "dismissed");
const dismissedDecisions = api.reconcileStructuralConflictPendingDecisions(
  dismissedReplay, decisions
);
assert.equal(dismissedDecisions[0].status, "dismissed");

const newEvidenceA = api.addConceptRelationship(nextA,
  relation("same-as", "same_as", b.id), {
    changedAt: at(4), reason: "Materially new equivalence evidence"
  });
const newEvidenceDelta = confirmRelationshipDelta(nextA, newEvidenceA, 4);
const newEvidenceReport = api.detectStructuralConflicts({
  concepts: [newEvidenceA, b],
  confirmedDeltas: [delta, newEvidenceDelta],
  detectedAt: at(4),
  affectedConceptIds: [nextA.id, b.id]
});
const afterNewEvidence = api.reconcileStructuralConflicts({
  existing: dismissedReplay,
  report: newEvidenceReport,
  recordedAt: at(4),
  interactionRef: newEvidenceDelta.id
});
assert.equal(afterNewEvidence.some((item) => item.status === "dismissed"), true);
assert.equal(afterNewEvidence.some((item) => item.status === "open"), true);

const resolvedA = api.removeConceptRelationship(newEvidenceA, "equiv", {
  changedAt: at(5), reason: "Explicit maintenance removal"
});
const fullyResolvedA = api.removeConceptRelationship(resolvedA, "same-as", {
  changedAt: at(6), reason: "Explicit maintenance removal"
});
const emptyReport = api.detectStructuralConflicts({
  concepts: [fullyResolvedA, b], detectedAt: at(6),
  affectedConceptIds: [fullyResolvedA.id, b.id]
});
const superseded = api.reconcileStructuralConflicts({
  existing: afterNewEvidence, report: emptyReport, recordedAt: at(6),
  interactionRef: "maintenance:explicit-removal"
});
assert.equal(superseded.some((item) => item.status === "open"), false);
assert.equal(superseded.some((item) => item.status === "superseded"), true);

const reverseEquivalenceB = concept("reverse-b", [
  relation("reverse-equivalence", "equivalent_to", "concept-reverse-a")
]);
const reverseA = concept("reverse-a", [
  relation("reverse-distinct", "explicitly_distinct_from", reverseEquivalenceB.id)
]);
const symmetryReport = api.detectStructuralConflicts({
  concepts: [reverseA, reverseEquivalenceB], detectedAt: at(7)
});
assert.equal(symmetryReport.conflicts.filter((item) =>
  item.ruleId === "DISTINCTION_VS_EQUIVALENCE").length, 1);

const duplicateA = {
  ...reverseA,
  relationships: [
    ...reverseA.relationships,
    relation("reverse-distinct-copy", "explicitly_distinct_from",
      reverseEquivalenceB.id)
  ]
};
const duplicateReport = api.detectStructuralConflicts({
  concepts: [duplicateA, reverseEquivalenceB], detectedAt: at(8)
});
assert.equal(duplicateReport.conflicts.filter((item) =>
  item.ruleId === "DUPLICATE_DISTINCTION").length, 1);

const removalOld = concept("removal", [
  relation("dependency", "depends_on", b.id)
]);
const removalNext = api.removeConceptRelationship(removalOld, "dependency", {
  changedAt: at(9), reason: "Confirmed removal"
});
const removalDelta = confirmRelationshipDelta(removalOld, removalNext, 9);
const staleRemovalReport = api.detectStructuralConflicts({
  concepts: [removalOld, b], confirmedDeltas: [removalDelta],
  detectedAt: at(9), affectedConceptIds: [removalOld.id]
});
assert.equal(staleRemovalReport.conflicts.some((item) =>
  item.ruleId === "REMOVED_RELATIONSHIP_STILL_ACTIVE"), true);

let persisted = api.createEmptySemanticDeltaState();
persisted = api.recordConfirmedDelta(persisted, delta, "A.md");
persisted = api.replaceStructuralConflictState(
  persisted, firstReconcile, decisions
);
const reloaded = api.migrateSemanticDeltaState(
  JSON.parse(JSON.stringify(persisted))
);
assert.equal(reloaded.structuralConflicts.length, 1);
assert.equal(reloaded.pendingDecisions.length, 1);
const legacyState = { ...JSON.parse(JSON.stringify(persisted)) };
delete legacyState.structuralConflicts;
assert.equal(api.migrateSemanticDeltaState(legacyState).structuralConflicts.length, 0);

const diagnostics = api.diagnoseBrain([nextA, b], [], reloaded);
assert.equal(diagnostics.issues.some((item) =>
  item.code === "structural_conflict"), true);

console.log(JSON.stringify({
  relationTaxonomy: {
    distinction: "symmetric",
    analogy: "non-equivalence",
    dependencies: "directional"
  },
  analogyHardConflicts: 0,
  hardConflictId: hard.id,
  replayConflictCount: replayReconcile.length,
  replayPendingDecisionCount: decisions.length,
  dismissalPreserved: dismissedReplay[0].status === "dismissed",
  newEvidenceCreatesOpenConflict: afterNewEvidence.some((item) =>
    item.status === "open"),
  explicitRemovalSupersedes: superseded.some((item) =>
    item.status === "superseded"),
  symmetricConflictCount: symmetryReport.conflicts.length,
  duplicateDistinctionDetected: true,
  staleRemovalDetected: true,
  detectorConceptMutations: 0,
  result: "PASS"
}, null, 2));
