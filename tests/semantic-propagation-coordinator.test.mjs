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
      export * from "./src/BrainGrowthPersistence";
      export * from "./src/SemanticDelta";
      export * from "./src/SemanticDeltaState";
      export * from "./src/SemanticPropagation";
      export * from "./src/SemanticPropagationCoordinator";
    `,
    resolveDir: process.cwd(),
    sourcefile: "semantic-propagation-coordinator-entry.ts",
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
        contents: `exports.normalizePath = (value) =>
          value.replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");`
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
  Object,
  Map,
  Set,
  JSON,
  Math,
  encodeURIComponent,
  decodeURIComponent
});
const api = module.exports;
const at = (minute) =>
  `2026-08-15T06:${String(minute).padStart(2, "0")}:00.000Z`;
const definition = (id, text) => ({
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
  userDefinition: definition("a-1", "A means X."),
  createdAt: at(0)
});
const newA = api.updateConceptNode(oldA, {
  title: "A revised",
  userDefinition: definition("a-2", "A means Y."),
  userDefinitionMode: "explicit_user_redefinition"
}, { changedAt: at(1), reason: "Explicit change" });
const b = api.createConceptNode({
  id: "concept-b",
  title: "B",
  userDefinition: definition("b-1", "B remains the user's own meaning."),
  generatedInterpretations: [{
    id: "b-ai",
    text: "Derived from A revision 1.",
    sourceReferences: ["concept:concept-a@revision:1"],
    dependencies: [{ conceptId: "concept-a", conceptRevision: 1 }]
  }],
  relationships: [{
    id: "b-a",
    relation: "depends_on",
    targetConceptId: "concept-a",
    targetLabel: "A",
    sourceReferences: []
  }],
  createdAt: at(0)
});
const proposal = api.proposePrincipalSemanticDelta({
  previous: oldA,
  next: newA,
  proposedAt: at(1),
  originRef: "Lain Brain/Notes/A.md",
  reason: "Confirmed maintenance definition"
});
const confirmation = api.confirmSemanticDelta(proposal.delta, {
  kind: "explicit_semantic_delta_confirmation",
  confirmedAt: at(2),
  confirmation: {
    kind: "maintenance_confirmation",
    confirmationId: "confirm-a",
    interactionRef: "Lain Brain/Notes/A.md",
    userEvidence: newA.userDefinition.sourceRefs
  }
});
const delta = confirmation.delta;
const origin = (id) => ({
  candidateId: `candidate-${id}`,
  candidateRevision: 1,
  approvedAt: at(0)
});
const makeVault = (modifyBehavior) => {
  const files = new Map([
    ["Lain Brain/Notes/A.md", { path: "Lain Brain/Notes/A.md" }],
    ["Lain Brain/Notes/B.md", { path: "Lain Brain/Notes/B.md" }]
  ]);
  const store = new Map([
    ["Lain Brain/Notes/A.md", api.serializeConceptNodeIntoMarkdown(
      "# A revised", newA, origin("a")
    )],
    ["Lain Brain/Notes/B.md", api.serializeConceptNodeIntoMarkdown(
      "# B", b, origin("b")
    )]
  ]);
  let writes = 0;
  const app = {
    vault: {
      getMarkdownFiles: () => [...files.values()],
      getFileByPath: (path) => files.get(path) ?? null,
      cachedRead: async (file) => store.get(file.path),
      modify: async (file, markdown) => {
        writes += 1;
        if (modifyBehavior !== undefined) {
          await modifyBehavior(file, markdown, store);
        } else {
          store.set(file.path, markdown);
        }
      }
    }
  };
  return { app, store, get writes() { return writes; } };
};

const vault = makeVault();
let savedState;
let saveCount = 0;
const coordinator = new api.SemanticPropagationCoordinator(
  vault.app,
  undefined,
  async (state) => {
    saveCount += 1;
    savedState = JSON.parse(JSON.stringify(state));
  },
  { maxDepth: 2, maxConcepts: 10, maxWritesPerJob: 5 }
);
assert.equal(await coordinator.recordConfirmedDelta(
  delta, "Lain Brain/Notes/A.md"
), true);
await coordinator.markOriginCommittedAndEnqueue(delta.id);
await coordinator.waitForIdle();
assert.equal(vault.writes, 1);
assert.ok(saveCount >= 4);
const reloadedB = api.deserializeConceptNodeFromMarkdown(
  vault.store.get("Lain Brain/Notes/B.md")
).conceptNode;
assert.equal(reloadedB.revision, 2);
assert.equal(reloadedB.userDefinition.text, b.userDefinition.text);
assert.equal(reloadedB.relationships[0].targetLabel, "A revised");
assert.equal(reloadedB.generatedInterpretations[0].derivedStatus, "stale");
assert.equal(reloadedB.generatedInterpretations[0].staleBecauseDeltaId, delta.id);
const completed = coordinator.getState();
assert.equal(completed.deltas.length, 1);
assert.equal(completed.jobs[0].status, "completed_with_pending_decisions");
assert.equal(completed.reports[0].appliedRevisions.length, 1);
assert.equal(completed.reports[0].appliedRevisions[0].conceptId, "concept-b");
assert.equal(completed.pendingDecisions.length, 1);

// Duplicate enqueue and reload replay are idempotent.
assert.equal(await coordinator.recordConfirmedDelta(
  delta, "Lain Brain/Notes/A.md"
), true);
await coordinator.markOriginCommittedAndEnqueue(delta.id);
await coordinator.waitForIdle();
assert.equal(vault.writes, 1);
const restarted = new api.SemanticPropagationCoordinator(
  vault.app,
  savedState,
  async (state) => { savedState = JSON.parse(JSON.stringify(state)); }
);
restarted.resumeIncompleteJobs();
await restarted.waitForIdle();
assert.equal(vault.writes, 1);

// A persisted interrupted planning job resumes, sees existing derived state,
// and creates no duplicate concept revision.
let interrupted = api.createEmptySemanticDeltaState();
interrupted = api.recordConfirmedDelta(
  interrupted,
  delta,
  "Lain Brain/Notes/A.md"
);
interrupted = api.updateSemanticPropagationJob(
  interrupted,
  delta.id,
  "planning"
);
const recovering = new api.SemanticPropagationCoordinator(
  vault.app,
  JSON.parse(JSON.stringify(interrupted)),
  async () => {}
);
recovering.resumeIncompleteJobs();
await recovering.waitForIdle();
assert.equal(vault.writes, 1);
assert.equal(recovering.getState().jobs[0].status,
  "completed_with_pending_decisions");

// A crash after the origin write but before the queue-state save leaves the
// durable job awaiting_origin_write. Reload conservatively retries it; the
// coordinator first verifies the exact committed origin revision.
const awaitingVault = makeVault();
let awaitingState = api.createEmptySemanticDeltaState();
awaitingState = api.recordConfirmedDelta(
  awaitingState,
  delta,
  "Lain Brain/Notes/A.md"
);
const awaitingRecovery = new api.SemanticPropagationCoordinator(
  awaitingVault.app,
  JSON.parse(JSON.stringify(awaitingState)),
  async () => {}
);
assert.equal(awaitingRecovery.getState().jobs[0].status, "queued");
awaitingRecovery.resumeIncompleteJobs();
await awaitingRecovery.waitForIdle();
assert.equal(awaitingVault.writes, 1);
assert.equal(awaitingRecovery.getState().jobs[0].status,
  "completed_with_pending_decisions");

// A Vault write failure is recorded and preserves the prior file.
const failing = makeVault(async () => {
  throw new Error("simulated write failure");
});
const beforeFailure = failing.store.get("Lain Brain/Notes/B.md");
const failureCoordinator = new api.SemanticPropagationCoordinator(
  failing.app,
  undefined,
  async () => {}
);
await failureCoordinator.recordConfirmedDelta(delta, "Lain Brain/Notes/A.md");
await failureCoordinator.markOriginCommittedAndEnqueue(delta.id);
await failureCoordinator.waitForIdle();
assert.equal(failing.store.get("Lain Brain/Notes/B.md"), beforeFailure);
assert.equal(failureCoordinator.getState().jobs[0].status, "failed");
assert.equal(failureCoordinator.getState().reports[0].failures.length, 1);

// Stale state appearing after planning is preserved and converted to a pending decision.
const staleVault = makeVault();
let bReads = 0;
const originalRead = staleVault.app.vault.cachedRead;
staleVault.app.vault.cachedRead = async (file) => {
  const markdown = await originalRead(file);
  if (file.path !== "Lain Brain/Notes/B.md") {
    return markdown;
  }
  bReads += 1;
  if (bReads === 2) {
    const current = api.deserializeConceptNodeFromMarkdown(markdown);
    const newer = api.updateConceptNode(current.conceptNode, {
      aliases: ["newer-user-edit"]
    }, { changedAt: at(4), reason: "Concurrent user update" });
    const newerMarkdown = api.serializeConceptNodeIntoMarkdown(
      markdown,
      newer,
      current.origin
    );
    staleVault.store.set(file.path, newerMarkdown);
    return newerMarkdown;
  }
  return markdown;
};
const staleCoordinator = new api.SemanticPropagationCoordinator(
  staleVault.app,
  undefined,
  async () => {}
);
await staleCoordinator.recordConfirmedDelta(delta, "Lain Brain/Notes/A.md");
await staleCoordinator.markOriginCommittedAndEnqueue(delta.id);
await staleCoordinator.waitForIdle();
assert.equal(staleVault.writes, 0);
assert.equal(staleCoordinator.getState().pendingDecisions.some((decision) =>
  decision.reason.includes("changed before propagation")
), true);

// Structural graph edges do not all become propagation dependencies.
const nonDependencyConcepts = ["analogous_to", "explicitly_distinct_from"]
  .map((relation, index) => api.createConceptNode({
    id: `non-dependency-${index}`,
    title: `Non dependency ${index}`,
    userDefinition: definition(`non-dependency-definition-${index}`, "Preserve this personal meaning."),
    relationships: [{
      id: `non-dependency-edge-${index}`,
      relation,
      targetConceptId: oldA.id,
      targetLabel: oldA.title,
      sourceReferences: ["confirmed-structural-fixture"]
    }],
    createdAt: at(0)
  }));
const nonDependencyPlan = api.planSemanticPropagation(
  delta,
  api.createConceptIndex([newA, ...nonDependencyConcepts])
);
assert.equal(nonDependencyPlan.affected.length, 2);
assert.equal(nonDependencyPlan.affected.every((item) =>
  item.automaticOperations.every((operation) =>
    operation.kind === "refresh_relationship_label"
  ) && item.pendingDecisionIds.length === 0
), true);
assert.equal(nonDependencyPlan.pendingDecisions.length, 0);
assert.deepEqual(
  JSON.parse(JSON.stringify(nonDependencyPlan.visitedConceptIds)),
  [newA.id]
);
assert.deepEqual(
  JSON.parse(JSON.stringify(nonDependencyConcepts.map((item) => item.userDefinition.text))),
  ["Preserve this personal meaning.", "Preserve this personal meaning."]
);

// A confirmed structural delta triggers one deterministic review record after
// the origin write boundary, without mutating either concept.
const conflictB = api.createConceptNode({
  id: "conflict-b",
  title: "Conflict B",
  createdAt: at(0)
});
const conflictOldA = api.createConceptNode({
  id: "conflict-a",
  title: "Conflict A",
  relationships: [{
    id: "conflict-equivalence",
    relation: "equivalent_to",
    targetConceptId: conflictB.id,
    targetLabel: conflictB.title,
    sourceReferences: ["explicit-fixture"]
  }],
  createdAt: at(0)
});
const conflictNewA = api.addConceptRelationship(conflictOldA, {
  id: "conflict-distinction",
  relation: "explicitly_distinct_from",
  targetConceptId: conflictB.id,
  targetLabel: conflictB.title,
  sourceReferences: ["explicit-confirmation"]
}, { changedAt: at(7), reason: "Explicit distinction" });
const conflictProposal = api.proposePrincipalSemanticDelta({
  previous: conflictOldA,
  next: conflictNewA,
  proposedAt: at(7),
  originRef: "Lain Brain/Notes/Conflict A.md",
  reason: "Explicit distinction"
});
const conflictConfirmation = api.confirmSemanticDelta(conflictProposal.delta, {
  kind: "explicit_semantic_delta_confirmation",
  confirmedAt: at(7),
  confirmation: {
    kind: "maintenance_confirmation",
    confirmationId: "conflict-confirmation",
    interactionRef: "conflict-test",
    userEvidence: []
  }
});
const conflictFiles = new Map([
  ["Lain Brain/Notes/Conflict A.md", { path: "Lain Brain/Notes/Conflict A.md" }],
  ["Lain Brain/Notes/Conflict B.md", { path: "Lain Brain/Notes/Conflict B.md" }]
]);
const conflictStore = new Map([
  ["Lain Brain/Notes/Conflict A.md", api.serializeConceptNodeIntoMarkdown(
    "# Conflict A", conflictNewA, origin("conflict-a")
  )],
  ["Lain Brain/Notes/Conflict B.md", api.serializeConceptNodeIntoMarkdown(
    "# Conflict B", conflictB, origin("conflict-b")
  )]
]);
const conflictApp = { vault: {
  getMarkdownFiles: () => [...conflictFiles.values()],
  getFileByPath: (path) => conflictFiles.get(path) ?? null,
  cachedRead: async (file) => conflictStore.get(file.path),
  modify: async () => { throw new Error("No concept write expected"); }
} };
const conflictCoordinator = new api.SemanticPropagationCoordinator(
  conflictApp, undefined, async () => {}
);
await conflictCoordinator.recordConfirmedDelta(
  conflictConfirmation.delta, "Lain Brain/Notes/Conflict A.md"
);
await conflictCoordinator.markOriginCommittedAndEnqueue(
  conflictConfirmation.delta.id
);
await conflictCoordinator.waitForIdle();
assert.equal(conflictCoordinator.getState().structuralConflicts.length, 1);
assert.equal(conflictCoordinator.getState().structuralConflicts[0].status, "open");
assert.equal(conflictCoordinator.getState().pendingDecisions.filter((item) =>
  item.kind === "structural_conflict").length, 1);
await conflictCoordinator.dismissStructuralConflict(
  conflictCoordinator.getState().structuralConflicts[0].id,
  at(8),
  "maintenance:conflict-a"
);
assert.equal(conflictCoordinator.getState().structuralConflicts[0].status,
  "dismissed");
assert.equal(conflictCoordinator.getState().pendingDecisions.find((item) =>
  item.kind === "structural_conflict").status, "dismissed");

let diagnosticSaveFailures = 0;
const failOpenCoordinator = new api.SemanticPropagationCoordinator(
  conflictApp,
  undefined,
  async (state) => {
    if (state.structuralConflicts.length > 0) {
      diagnosticSaveFailures += 1;
      throw new Error("diagnostic persistence unavailable");
    }
  }
);
await failOpenCoordinator.recordConfirmedDelta(
  conflictConfirmation.delta, "Lain Brain/Notes/Conflict A.md"
);
await failOpenCoordinator.markOriginCommittedAndEnqueue(
  conflictConfirmation.delta.id
);
await failOpenCoordinator.waitForIdle();
assert.equal(diagnosticSaveFailures, 1);
assert.equal(failOpenCoordinator.getState().jobs[0].status, "completed");

console.log(JSON.stringify({
  backgroundWrites: vault.writes,
  boundedAutomaticFields: ["relationship_label", "derived_interpretation_status"],
  downstreamUserMeaningPreserved: true,
  pendingDecisionsPersisted: completed.pendingDecisions.length,
  duplicateReplayWrites: 0,
  interruptedRecoveryWrites: 0,
  awaitingOriginRecoveryWrites: awaitingVault.writes,
  failureRecorded: true,
  staleUnsafeWrites: staleVault.writes,
  nonDependencyRelationsIgnored: ["analogous_to", "explicitly_distinct_from"],
  structuralConflictsPersisted: 1,
  structuralConflictPendingDecisions: 1,
  structuralConflictDismissed: true,
  diagnosticPersistenceFailOpen: true,
  result: "PASS"
}, null, 2));
