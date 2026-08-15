import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/BrainGrowth";
      export * from "./src/BrainGrowthIndex";
      export * from "./src/SemanticDelta";
      export * from "./src/SemanticPropagation";
      export * from "./src/SemanticDeltaState";
      export * from "./src/BrainDiagnostics";
    `,
    resolveDir: process.cwd(),
    sourcefile: "semantic-delta-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  write: false,
  metafile: true
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console,
  Object,
  Map,
  Set,
  JSON,
  Math
});
const api = module.exports;
const at = (minute) =>
  `2026-08-15T05:${String(minute).padStart(2, "0")}:00.000Z`;
const userDefinition = (id, text) => ({
  id,
  text,
  sourceRefs: [{
    sourceKind: "user_edit",
    editId: `edit-${id}`,
    snapshot: text,
    actor: "user"
  }]
});
const oldA = api.createConceptNode({
  id: "concept-a",
  title: "A",
  userDefinition: userDefinition("a-v1", "A means X."),
  createdAt: at(0)
});
const newA = api.updateConceptNode(oldA, {
  title: "A revised",
  userDefinition: userDefinition("a-v2", "A means Y."),
  userDefinitionMode: "explicit_user_redefinition"
}, { changedAt: at(1), reason: "Explicit user redefinition" });

const proposed = api.proposePrincipalSemanticDelta({
  previous: oldA,
  next: newA,
  proposedAt: at(1),
  originRef: "maintenance:A",
  reason: "User explicitly changed A",
  proposalConfidence: 0.99
});
assert.equal(proposed.kind, "proposed");
assert.equal(proposed.delta.authority, "proposed");
assert.equal(proposed.delta.kind, "personal_definition_redefined");
assert.equal(proposed.delta.next.definition.text, "A means Y.");
assert.equal(proposed.delta.id, api.proposePrincipalSemanticDelta({
  previous: oldA,
  next: newA,
  proposedAt: at(9),
  originRef: "maintenance:A",
  reason: "Different explanation does not change stable identity"
}).delta.id);

const invalid = api.confirmSemanticDelta(proposed.delta, {
  kind: "explicit_semantic_delta_confirmation",
  confirmedAt: "",
  confirmation: {
    kind: "maintenance_confirmation",
    confirmationId: "",
    interactionRef: "",
    userEvidence: []
  }
});
assert.equal(invalid.kind, "invalid_confirmation");

const confirmed = api.confirmSemanticDelta(proposed.delta, {
  kind: "explicit_semantic_delta_confirmation",
  confirmedAt: at(2),
  confirmation: {
    kind: "maintenance_confirmation",
    confirmationId: "confirmation-a",
    interactionRef: "maintenance:A",
    userEvidence: newA.userDefinition.sourceRefs
  }
});
assert.equal(confirmed.kind, "confirmed");
assert.equal(confirmed.delta.authority, "user_confirmed");
assert.equal(confirmed.delta.confirmation.userEvidence[0].snapshot,
  "A means Y.");
assert.equal(confirmed.delta.authorization.includes(
  "invalidate_derived_interpretations"
), true);

const dependentB = api.createConceptNode({
  id: "concept-b",
  title: "B",
  userDefinition: userDefinition("b-v1", "B personally depends on A."),
  generatedInterpretations: [{
    id: "generated-b",
    text: "AI-derived explanation based on A revision 1.",
    sourceReferences: ["concept:concept-a@revision:1"],
    derivedStatus: "current",
    dependencies: [{ conceptId: "concept-a", conceptRevision: 1 }]
  }],
  relationships: [{
    id: "b-depends-a",
    relation: "depends_on",
    targetConceptId: "concept-a",
    targetLabel: "Old A label",
    sourceReferences: []
  }],
  createdAt: at(0)
});
const dependentC = api.createConceptNode({
  id: "concept-c",
  title: "C",
  relationships: [{
    id: "c-depends-b",
    relation: "related_to",
    targetConceptId: "concept-b",
    targetLabel: "B",
    sourceReferences: []
  }],
  createdAt: at(0)
});
const sourceForPlan = {
  ...newA,
  relationships: [{
    id: "a-related-c",
    relation: "related_to",
    targetConceptId: "concept-c",
    targetLabel: "C",
    sourceReferences: []
  }]
};
const unrelated = api.createConceptNode({
  id: "concept-unrelated",
  title: "A revised",
  createdAt: at(0)
});
const unresolved = api.createConceptNode({
  id: "concept-unresolved",
  title: "Unresolved",
  unresolvedItems: [{
    id: "possible-a",
    kind: "relationship",
    text: "This may target A.",
    alternatives: ["A revised", "concept-other"],
    status: "open",
    sourceReferences: []
  }],
  createdAt: at(0)
});
const index = api.createConceptIndex([
  sourceForPlan,
  dependentB,
  dependentC,
  unrelated,
  unresolved
]);
const plan = api.planSemanticPropagation(confirmed.delta, index, {
  maxDepth: 3,
  maxConcepts: 10
});
const planAgain = api.planSemanticPropagation(confirmed.delta, index, {
  maxDepth: 3,
  maxConcepts: 10
});
assert.equal(JSON.stringify(plan), JSON.stringify(planAgain));
assert.equal(plan.affected.some((item) => item.conceptId === "concept-b"), true);
assert.equal(plan.affected.some((item) => item.conceptId === "concept-c"), true);
assert.equal(plan.affected.some((item) => item.conceptId === "concept-unrelated"), false);
assert.equal(plan.affected.some((item) => item.conceptId === "concept-unresolved"), true);
assert.equal(plan.visitedConceptIds.length <= 5, true);
assert.equal(new Set(plan.visitedConceptIds).size, plan.visitedConceptIds.length);
assert.equal(plan.pendingDecisions.some((item) =>
  item.reason.includes("personal definition")
), true);
assert.equal(plan.pendingDecisions.some((item) =>
  item.reason.includes("unresolved relationship")
), true);

const applied = api.applySemanticPropagationPlan(
  confirmed.delta,
  plan,
  index.concepts,
  at(3)
);
const updatedB = applied.revisions.find((item) => item.conceptId === "concept-b");
assert.ok(updatedB);
assert.equal(updatedB.concept.userDefinition.text,
  dependentB.userDefinition.text);
assert.equal(updatedB.concept.relationships[0].targetConceptId, "concept-a");
assert.equal(updatedB.concept.relationships[0].targetLabel, "A revised");
assert.equal(updatedB.concept.generatedInterpretations[0].derivedStatus, "stale");
assert.equal(updatedB.concept.generatedInterpretations[0].staleBecauseDeltaId,
  confirmed.delta.id);
assert.equal(updatedB.concept.generatedInterpretations[0]
  .dependencies[0].conceptRevision, newA.revision);
assert.equal(updatedB.concept.history.at(-1).reason.includes(confirmed.delta.id), true);

// Authorization removal blocks all automatic modification and user meaning stays intact.
const deniedDelta = { ...confirmed.delta, authorization: [] };
const denied = api.applySemanticPropagationPlan(deniedDelta, plan, index.concepts, at(3));
assert.equal(denied.revisions.length, 0);
assert.equal(dependentB.revision, 1);
assert.equal(dependentB.userDefinition.text, "B personally depends on A.");

// Replaying against already mechanically updated state produces no new revision.
const replayConcepts = index.concepts.map((concept) =>
  concept.id === updatedB.conceptId ? updatedB.concept : concept
);
const replayPlan = api.planSemanticPropagation(
  confirmed.delta,
  api.createConceptIndex(replayConcepts),
  { maxDepth: 3, maxConcepts: 10 }
);
const replay = api.applySemanticPropagationPlan(
  confirmed.delta,
  replayPlan,
  replayConcepts,
  at(4)
);
assert.equal(replay.revisions.length, 0);

// Durable state deduplicates deltas/jobs and recovers interrupted work as queued.
let state = api.createEmptySemanticDeltaState();
state = api.recordConfirmedDelta(state, confirmed.delta,
  "Lain Brain/Notes/A.md");
const once = state;
state = api.recordConfirmedDelta(state, confirmed.delta,
  "Lain Brain/Notes/A.md");
assert.equal(state, once);
assert.equal(state.deltas.length, 1);
assert.equal(state.jobs.length, 1);
state = api.updateSemanticPropagationJob(state, confirmed.delta.id, "planning");
const reloaded = api.migrateSemanticDeltaState(JSON.parse(JSON.stringify(state)));
assert.equal(reloaded.jobs[0].status, "queued");
assert.equal(reloaded.deltas[0].id, confirmed.delta.id);

let awaiting = api.createEmptySemanticDeltaState();
awaiting = api.recordConfirmedDelta(
  awaiting,
  confirmed.delta,
  "Lain Brain/Notes/A.md"
);
const decisionOnlyUpdate = api.replaceSemanticPendingDecisions(awaiting, []);
assert.equal(decisionOnlyUpdate.jobs[0].status, "awaiting_origin_write");
const awaitingReload = api.migrateSemanticDeltaState(
  JSON.parse(JSON.stringify(awaiting))
);
assert.equal(awaitingReload.jobs[0].status, "queued");
assert.equal(api.migrateSemanticDeltaState({ schemaVersion: 99 }).deltas.length, 0);
assert.equal(api.migrateSemanticDeltaState("malformed").jobs.length, 0);
assert.equal(api.migrateSemanticDeltaState({
  schemaVersion: 1,
  deltas: [{ id: "incomplete" }],
  jobs: [],
  pendingDecisions: [],
  reports: []
}).deltas.length, 0);

const unknownDeltaHistory = api.updateConceptNode(dependentC, {
  aliases: ["C alias"]
}, {
  changedAt: at(5),
  reason: "SemanticDelta semantic-delta:missing caused derived maintenance"
});
const incompleteDiagnostics = api.diagnoseBrain(
  [unknownDeltaHistory],
  [],
  awaiting
);
assert.equal(incompleteDiagnostics.issues.some((item) =>
  item.code === "orphan_semantic_delta"
), true);
assert.equal(incompleteDiagnostics.issues.some((item) =>
  item.code === "incomplete_propagation"
), true);
assert.equal(incompleteDiagnostics.issues.some((item) =>
  item.code === "unknown_delta_revision_reference"
), true);
const failedState = api.updateSemanticPropagationJob(
  awaiting,
  confirmed.delta.id,
  "failed",
  "simulated failure"
);
assert.equal(api.diagnoseBrain([sourceForPlan], [], failedState).issues.some(
  (item) => item.code === "failed_propagation"
), true);

const pending = applied.pendingDecisions[0];
assert.ok(pending);
assert.equal(api.listPendingSemanticDecisions([pending]).length, 1);
assert.equal(api.resolvePendingSemanticDecision(
  [pending], pending.id, "dismissed"
)[0].status, "dismissed");

const inputs = Object.keys(built.metafile.inputs);
assert.equal(inputs.some((path) => path.includes("obsidian")), false);
assert.equal(inputs.some((path) => path.includes("LainBrainSession")), false);

console.log(JSON.stringify({
  proposedIsNonAuthoritative: true,
  explicitConfirmationRequired: true,
  stableDeltaId: confirmed.delta.id,
  deterministicAffectedOrder: plan.affected.map((item) => item.conceptId),
  cyclesTerminated: true,
  safeDerivedRevisionCount: applied.revisions.length,
  downstreamUserMeaningUntouched: true,
  pendingDecisionCount: applied.pendingDecisions.length,
  replayRevisions: replay.revisions.length,
  duplicateJobs: 0,
  interruptedJobRecoveredAs: reloaded.jobs[0].status,
  awaitingOriginRecoveredAs: awaitingReload.jobs[0].status,
  diagnosticCodesCovered: [
    "orphan_semantic_delta",
    "incomplete_propagation",
    "failed_propagation",
    "unknown_delta_revision_reference"
  ],
  result: "PASS"
}, null, 2));
