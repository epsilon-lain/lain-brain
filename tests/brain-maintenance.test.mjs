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
      export * from "./src/BrainMaintenance";
      export * from "./src/BrainDiagnostics";
    `,
    resolveDir: process.cwd(),
    sourcefile: "brain-maintenance-entry.ts",
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
  encodeURIComponent,
  decodeURIComponent
});
const {
  addConceptRelationship,
  applyReviewedConceptUpdate,
  createConceptIndex,
  createConceptNode,
  deserializeConceptNodeFromMarkdown,
  diagnoseBrain,
  inspectConceptMarkdown,
  lookupConcept,
  lookupConceptByAlias,
  lookupConceptByExactTitle,
  lookupConceptById,
  lookupConceptByNormalizedTitle,
  preparePersistedConceptRestore,
  preparePersistedConceptUpdate,
  removeConceptRelationship,
  serializeConceptNodeIntoMarkdown,
  updateConceptNode
} = module.exports;

const at = (minute) =>
  `2026-08-15T01:${String(minute).padStart(2, "0")}:00.000Z`;
const definition = (id, text) => ({
  id,
  text,
  sourceRefs: [{
    sourceKind: "message_span",
    messageId: `message-${id}`,
    snapshot: text,
    actor: "user"
  }]
});
const approval = (minute) => ({
  kind: "confirmed_concept_update",
  approvedAt: at(minute)
});
const change = (minute, reason) => ({ changedAt: at(minute), reason });

let freedom = createConceptNode({
  id: "concept-freedom",
  title: "Freedom",
  aliases: ["liberty"],
  userDefinition: definition(
    "freedom-v1",
    "Freedom is the space in which I can choose my own commitments."
  ),
  generatedInterpretations: [{
    id: "generated-freedom",
    text: "A reviewed AI interpretation.",
    sourceReferences: ["candidate:freedom"]
  }],
  createdAt: at(0)
});
const freedomOther = createConceptNode({
  id: "concept-freedom-other",
  title: "Freedom",
  aliases: ["autonomy"],
  userDefinition: definition(
    "freedom-other",
    "Freedom here names a different personal concept."
  ),
  createdAt: at(0)
});
const changeNode = createConceptNode({
  id: "concept-change",
  title: "Change",
  aliases: ["transformation"],
  userDefinition: definition("change", "Change is a difference across states."),
  createdAt: at(0)
});

// Deterministic lookup never hides multiple candidates.
const index = createConceptIndex([freedom, freedomOther, changeNode]);
assert.equal(lookupConceptById(index, "concept-change").kind, "unique_match");
assert.equal(lookupConceptByExactTitle(index, "Freedom").kind, "ambiguous_matches");
assert.equal(
  lookupConceptByNormalizedTitle(index, "  FREEDOM ").kind,
  "ambiguous_matches"
);
assert.equal(lookupConceptByAlias(index, "LIBERTY").kind, "unique_match");
assert.equal(lookupConcept(index, "transformation").match.concept.id, "concept-change");
assert.equal(lookupConcept(index, "unknown concept").kind, "not_found");
assert.equal(index.concepts.length, 3);

// A reviewed update uses the immutable v0 operation and preserves authority.
const updateResult = applyReviewedConceptUpdate(index, {
  approval: approval(1),
  conceptId: freedom.id,
  expectedRevision: 1,
  update: {
    aliases: ["self-direction"],
    standardDefinitions: [{
      id: "external-freedom",
      text: "An external source defines freedom differently.",
      sourceReferences: ["book:freedom"]
    }]
  },
  change: change(1, "Attach reviewed alias and external meaning")
});
assert.equal(updateResult.kind, "updated");
assert.equal(updateResult.concept.id, freedom.id);
assert.equal(updateResult.concept.revision, 2);
assert.equal(updateResult.concept.history[0].revision, 1);
assert.equal(updateResult.concept.userDefinition.text, freedom.userDefinition.text);
assert.equal(updateResult.concept.standardDefinitions.length, 1);
assert.equal(updateResult.concept.aliases.includes("self-direction"), true);

const noChange = applyReviewedConceptUpdate(
  createConceptIndex([updateResult.concept]),
  {
    approval: approval(2),
    conceptId: freedom.id,
    expectedRevision: 2,
    update: { aliases: ["self-direction"] },
    change: change(2, "Duplicate reviewed alias")
  }
);
assert.equal(noChange.kind, "no_change");
assert.equal(noChange.concept.revision, 2);
assert.equal(noChange.concept.history.length, 1);

const stale = applyReviewedConceptUpdate(createConceptIndex([updateResult.concept]), {
  approval: approval(3),
  conceptId: freedom.id,
  expectedRevision: 1,
  update: { aliases: ["stale"] },
  change: change(3, "Stale update")
});
assert.equal(stale.kind, "failed");
assert.equal(stale.code, "stale_revision");

const ambiguousId = applyReviewedConceptUpdate(
  createConceptIndex([freedom, freedom]),
  {
    approval: approval(3),
    conceptId: freedom.id,
    expectedRevision: 1,
    update: { aliases: ["unsafe"] },
    change: change(3, "Ambiguous target")
  }
);
assert.equal(ambiguousId.kind, "failed");
assert.equal(ambiguousId.code, "ambiguous_target");

// Conflicting user meaning is preserved; replacement requires explicit mode.
const conflict = applyReviewedConceptUpdate(createConceptIndex([freedom]), {
  approval: approval(4),
  conceptId: freedom.id,
  expectedRevision: 1,
  update: {
    userDefinition: definition(
      "freedom-v2",
      "Freedom is the ability to detach from every commitment."
    )
  },
  change: change(4, "Record conflicting reviewed meaning")
});
assert.equal(conflict.kind, "updated");
assert.equal(conflict.concept.userDefinition.text, freedom.userDefinition.text);
assert.equal(conflict.concept.alternativeUserDefinitions.length, 1);
const redefined = applyReviewedConceptUpdate(
  createConceptIndex([conflict.concept]),
  {
    approval: approval(5),
    conceptId: freedom.id,
    expectedRevision: 2,
    update: {
      userDefinition: definition(
        "freedom-v3",
        "Freedom is my explicitly revised personal definition."
      ),
      userDefinitionMode: "explicit_user_redefinition"
    },
    change: change(5, "Explicit user redefinition")
  }
);
assert.equal(redefined.kind, "updated");
assert.equal(redefined.concept.userDefinition.id, "freedom-v3");
assert.equal(redefined.concept.alternativeUserDefinitions.length, 0);

// Persistence inspection distinguishes ordinary, malformed, and future data.
assert.equal(inspectConceptMarkdown("# Ordinary note").kind, "ordinary_markdown");
const malformed = [
  "---",
  "lain-brain-type: concept-node",
  "---",
  "# Broken"
].join("\n");
const malformedInspection = inspectConceptMarkdown(malformed);
assert.equal(malformedInspection.kind, "invalid_concept");
assert.equal(malformedInspection.code, "invalid_concept_metadata");

const origin = {
  candidateId: "candidate-freedom",
  candidateRevision: 3,
  approvedAt: at(0)
};
const initialMarkdown = serializeConceptNodeIntoMarkdown(
  "# Freedom\n\nReviewed body.",
  freedom,
  origin
);
assert.match(initialMarkdown, /lain-brain-concept-aliases:/);
assert.match(initialMarkdown, /lain-brain-concept-relationships: 0/);
assert.equal(inspectConceptMarkdown(initialMarkdown).kind, "concept_node");
const futureMarkdown = initialMarkdown.replace(
  "lain-brain-concept-data:v1:",
  "lain-brain-concept-data:v2:"
);
const futureInspection = inspectConceptMarkdown(futureMarkdown);
assert.equal(futureInspection.kind, "invalid_concept");
assert.equal(futureInspection.code, "unsupported_schema_version");
assert.throws(
  () => deserializeConceptNodeFromMarkdown(futureMarkdown),
  /Unsupported Brain Growth persistence schema version/
);

// Pure persisted update leaves the old text untouched until a caller writes it.
const originalMarkdownSnapshot = initialMarkdown;
const prepared = preparePersistedConceptUpdate(initialMarkdown, {
  approval: approval(6),
  conceptId: freedom.id,
  expectedRevision: 1,
  update: {
    examples: [{
      id: "freedom-example",
      text: "Choosing a promise is one example.",
      sourceReferences: ["message-example"]
    }]
  },
  change: change(6, "Add reviewed example")
});
assert.equal(prepared.kind, "updated");
assert.equal(initialMarkdown, originalMarkdownSnapshot);
const preparedReload = deserializeConceptNodeFromMarkdown(prepared.markdown);
assert.equal(preparedReload.conceptNode.revision, 2);
assert.equal(preparedReload.conceptNode.examples.length, 1);
assert.equal(preparedReload.conceptNode.history[0].revision, 1);
assert.equal(preparedReload.conceptNode.userDefinition.text, freedom.userDefinition.text);

const failedPreparation = preparePersistedConceptUpdate(initialMarkdown, {
  approval: approval(7),
  conceptId: "missing-id",
  expectedRevision: 1,
  update: { aliases: ["never applied"] },
  change: change(7, "Wrong target")
});
assert.equal(failedPreparation.kind, "failed");
assert.equal(failedPreparation.markdown, initialMarkdown);

const restored = preparePersistedConceptRestore(prepared.markdown, {
  approval: approval(8),
  conceptId: freedom.id,
  expectedRevision: 2,
  restoreRevision: 1,
  change: change(8, "Restore original reviewed state")
});
assert.equal(restored.kind, "updated");
assert.equal(restored.concept.revision, 3);
assert.equal(restored.concept.examples.length, 0);
const restoredReload = deserializeConceptNodeFromMarkdown(restored.markdown);
assert.equal(restoredReload.conceptNode.revision, 3);
assert.equal(restoredReload.conceptNode.history.length, 2);
assert.equal(restoredReload.conceptNode.history[1].revision, 2);

// Relationship identity survives target rename because the stable ID is used.
freedom = addConceptRelationship(freedom, {
  id: "relation-change",
  relation: "depends_on",
  targetConceptId: changeNode.id,
  targetLabel: changeNode.title,
  sourceReferences: ["reviewed relation"]
}, change(9, "Add stable relationship"));
const renamedTarget = updateConceptNode(changeNode, {
  title: "Transformation"
}, change(9, "Rename relationship target"));
assert.equal(freedom.relationships[0].targetConceptId, renamedTarget.id);
const duplicateRelation = addConceptRelationship(freedom, {
  id: "relation-change-duplicate",
  relation: "depends_on",
  targetConceptId: changeNode.id,
  targetLabel: renamedTarget.title,
  sourceReferences: []
}, change(10, "Attempt duplicate"));
assert.equal(duplicateRelation, freedom);
freedom = removeConceptRelationship(
  freedom,
  "relation-change",
  change(10, "Remove relationship")
);
assert.equal(freedom.relationships.length, 0);

// Structured diagnostics inspect without mutating or writing.
const unresolved = createConceptNode({
  id: "concept-unresolved",
  title: "Freedom",
  relationships: [{
    id: "missing-edge",
    relation: "related_to",
    targetConceptId: "concept-missing",
    targetLabel: "Missing",
    sourceReferences: []
  }],
  unresolvedItems: [
    {
      id: "meaning-open",
      kind: "meaning",
      text: "Meaning remains unresolved.",
      alternatives: ["first", "second"],
      status: "open",
      sourceReferences: []
    },
    {
      id: "relationship-open",
      kind: "relationship",
      text: "Relationship target remains unresolved.",
      alternatives: [],
      status: "open",
      sourceReferences: []
    }
  ],
  createdAt: at(0)
});
const duplicateId = createConceptNode({
  id: "concept-unresolved",
  title: "Different label",
  createdAt: at(0)
});
const malformedRevision = {
  ...JSON.parse(JSON.stringify(changeNode)),
  revision: 0
};
const diagnosticInput = [unresolved, duplicateId, freedomOther, malformedRevision];
const diagnosticSnapshot = JSON.stringify(diagnosticInput);
const diagnostics = diagnoseBrain(diagnosticInput, [{
  ref: "Lain Brain/Notes/Broken.md",
  inspection: malformedInspection
}]);
const codes = diagnostics.issues.map((item) => item.code);
for (const expected of [
  "duplicate_concept_id",
  "same_title_candidates",
  "missing_user_definition",
  "unresolved_ambiguity",
  "unresolved_relationship",
  "missing_relationship_target",
  "malformed_revision_history",
  "invalid_persistence_metadata"
]) {
  assert.equal(codes.includes(expected), true, `missing diagnostic ${expected}`);
}
assert.equal(JSON.stringify(diagnosticInput), diagnosticSnapshot);

const bundledInputs = Object.keys(built.metafile.inputs);
assert.equal(bundledInputs.some((path) => path.includes("obsidian")), false);
assert.equal(bundledInputs.some((path) => path.includes("LainBrainSession")), false);

console.log(JSON.stringify({
  lookupModes: ["stable_id", "exact_title", "normalized_title", "alias"],
  ambiguousLookupPreserved: true,
  reviewedUpdateAndNoOp: true,
  conflictAndExplicitRedefinition: true,
  persistenceInspection: true,
  historyUpdateRestoreRoundTrip: true,
  relationshipIntegrity: true,
  diagnosticCodes: [...new Set(codes)],
  vaultWrites: 0,
  result: "PASS"
}, null, 2));
