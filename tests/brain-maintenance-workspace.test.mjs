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
      export * from "./src/BrainMaintenanceWorkspace";
      export * from "./src/ObsidianConceptMaintenance";
    `,
    resolveDir: process.cwd(),
    sourcefile: "brain-maintenance-workspace-entry.ts",
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
  `2026-08-15T03:${String(minute).padStart(2, "0")}:00.000Z`;
const source = {
  sourceKind: "message_span",
  messageId: "message-user-1",
  snapshot: "Freedom is choosing commitments I can stand behind.",
  actor: "user"
};
const target = api.createConceptNode({
  id: "concept-target",
  title: "Commitment",
  createdAt: at(0)
});
const concept = api.createConceptNode({
  id: "concept-freedom",
  title: "Freedom",
  aliases: ["liberty"],
  userEvidence: [source],
  generatedInterpretations: [{
    id: "ai-1",
    text: "AI wording must remain non-authoritative.",
    sourceReferences: ["candidate-1"]
  }],
  standardDefinitions: [{
    id: "external-1",
    text: "A standard external definition.",
    sourceReferences: ["book-1"]
  }],
  relationships: [{
    id: "old-relation",
    relation: "contrasts_with",
    targetConceptId: target.id,
    targetLabel: target.title,
    sourceReferences: []
  }],
  unresolvedItems: [{
    id: "meaning-1",
    kind: "meaning",
    text: "The personal meaning is not chosen yet.",
    alternatives: [source.snapshot, "AI wording must remain non-authoritative."],
    status: "open",
    sourceReferences: []
  }],
  createdAt: at(0)
});
const origin = {
  candidateId: "candidate-freedom",
  candidateRevision: 2,
  approvedAt: at(0)
};
const originalMarkdown = api.serializeConceptNodeIntoMarkdown(
  "# Freedom\n\nReadable candidate body.",
  concept,
  origin
);

// Draft creation is read-only and keeps semantic layers separate.
const draft = api.createConceptMaintenanceDraft(concept);
assert.equal(draft.personalDefinitionText, "");
assert.equal(concept.generatedInterpretations[0].text,
  "AI wording must remain non-authoritative.");
assert.equal(concept.standardDefinitions[0].text,
  "A standard external definition.");
assert.equal(concept.userDefinition, undefined);

const relationship = api.createMaintenanceRelationship({
  sourceConceptId: concept.id,
  relation: "depends_on",
  targetConceptId: target.id,
  targetLabel: target.title
});
let writes = 0;
const prepared = api.prepareConceptMaintenanceDraft({
  markdown: originalMarkdown,
  concept,
  draft: {
    ...draft,
    personalDefinitionText: source.snapshot,
    personalDefinitionSource: { kind: "user_evidence", evidence: source },
    aliases: ["autonomy"],
    relationships: [relationship],
    resolveUnresolvedItemIds: ["meaning-1"]
  },
  reviewedAt: at(1)
});
assert.equal(prepared.kind, "updated");
assert.equal(writes, 0);
assert.equal(concept.userDefinition, undefined);
assert.equal(prepared.concept.userDefinition.text, source.snapshot);
assert.equal(prepared.concept.userDefinition.sourceRefs[0].messageId,
  source.messageId);
assert.deepEqual(JSON.parse(JSON.stringify(prepared.concept.aliases)),
  ["autonomy"]);
assert.deepEqual(
  JSON.parse(JSON.stringify(prepared.concept.relationships.map((item) => item.id))),
  [relationship.id]
);
assert.equal(prepared.concept.unresolvedItems[0].status, "resolved");
assert.equal(prepared.concept.revision, 2);
for (const kind of [
  "personal_definition",
  "aliases",
  "relationship",
  "ambiguity",
  "revision"
]) {
  assert.equal(prepared.diff.some((item) => item.kind === kind), true);
}

// Manual entry becomes user-authored provenance only in the prepared result.
const manual = api.prepareConceptMaintenanceDraft({
  markdown: originalMarkdown,
  concept,
  draft: {
    ...draft,
    personalDefinitionText: "My exact new wording.",
    personalDefinitionSource: { kind: "maintenance_input" }
  },
  reviewedAt: at(2)
});
assert.equal(manual.kind, "updated");
assert.equal(manual.concept.userDefinition.text, "My exact new wording.");
assert.equal(manual.concept.userDefinition.sourceRefs[0].sourceKind, "user_edit");
assert.equal(concept.userDefinition, undefined);

// AI text is not promoted merely because it is displayed by the workspace.
assert.equal(draft.personalDefinitionText.includes("AI wording"), false);

const defined = manual.concept;
const definedMarkdown = manual.markdown;
const replacementDraft = api.createConceptMaintenanceDraft(defined);
const replacement = api.prepareConceptMaintenanceDraft({
  markdown: definedMarkdown,
  concept: defined,
  draft: {
    ...replacementDraft,
    personalDefinitionText: "My explicitly replaced definition.",
    personalDefinitionSource: { kind: "maintenance_input" }
  },
  reviewedAt: at(3)
});
assert.equal(replacement.kind, "updated");
assert.equal(replacement.concept.userDefinition.text,
  "My explicitly replaced definition.");
assert.equal(replacement.concept.history.at(-1).snapshot.userDefinition.text,
  "My exact new wording.");

const noChangeDraft = api.createConceptMaintenanceDraft(defined);
const noChange = api.prepareConceptMaintenanceDraft({
  markdown: definedMarkdown,
  concept: defined,
  draft: noChangeDraft,
  reviewedAt: at(3)
});
assert.equal(noChange.kind, "no_change");
assert.equal(noChange.concept.revision, defined.revision);

const invalid = api.prepareConceptMaintenanceDraft({
  markdown: definedMarkdown,
  concept: defined,
  draft: { ...noChangeDraft, expectedRevision: 1 },
  reviewedAt: at(3)
});
assert.equal(invalid.kind, "failed");
assert.equal(invalid.code, "stale_revision");

// Restore is prepared as a new revision, never destructive history mutation.
const restored = api.prepareConceptMaintenanceRestore({
  markdown: definedMarkdown,
  concept: defined,
  restoreRevision: 1,
  reviewedAt: at(4)
});
assert.equal(restored.kind, "updated");
assert.equal(restored.concept.revision, 3);
assert.equal(restored.restoredRevision, 1);
assert.equal(restored.diff.some((item) => item.kind === "history_restore"), true);

// Real read/write adapter: reads are safe; only explicit persist modifies once.
const file = { path: "Lain Brain/Notes/Freedom.md" };
const ordinaryFile = { path: "Notes/Ordinary.md" };
const futureFile = { path: "Lain Brain/Notes/Future.md" };
const store = new Map([
  [file.path, originalMarkdown],
  [ordinaryFile.path, "# Ordinary"],
  [futureFile.path, originalMarkdown.replace(
    "lain-brain-concept-data:v1:",
    "lain-brain-concept-data:v9:"
  )]
]);
const files = new Map([
  [file.path, file],
  [ordinaryFile.path, ordinaryFile],
  [futureFile.path, futureFile]
]);
const app = {
  vault: {
    getFileByPath: (path) => files.get(path) ?? null,
    cachedRead: async (selected) => store.get(selected.path),
    modify: async (selected, markdown) => {
      writes += 1;
      store.set(selected.path, markdown);
    }
  }
};
assert.equal((await api.loadConceptForMaintenance(app, file.path)).ok, true);
assert.equal((await api.loadConceptForMaintenance(app, ordinaryFile.path)).error,
  "The selected note is not a ConceptNode");
assert.equal((await api.loadConceptForMaintenance(app, futureFile.path)).error,
  "Concept persistence version is unsupported");
assert.equal(writes, 0);

const confirmed = await api.persistConfirmedConceptUpdate(app, {
  vaultPath: file.path,
  conceptId: concept.id,
  expectedRevision: concept.revision,
  expectedMarkdown: originalMarkdown,
  preparedMarkdown: prepared.markdown
});
assert.equal(confirmed.ok, true);
assert.equal(writes, 1);
assert.equal(api.inspectConceptMarkdown(store.get(file.path))
  .persisted.conceptNode.userDefinition.text, source.snapshot);

// Stale exact content and stale revision both block without another write.
const staleResult = await api.persistConfirmedConceptUpdate(app, {
  vaultPath: file.path,
  conceptId: concept.id,
  expectedRevision: concept.revision,
  expectedMarkdown: originalMarkdown,
  preparedMarkdown: prepared.markdown
});
assert.equal(staleResult.ok, false);
assert.equal(staleResult.error,
  "The concept changed. Reload and review the update again.");
assert.equal(writes, 1);

// Failed persistence does not change the mock file.
const failingStore = new Map([[file.path, originalMarkdown]]);
let failedWrites = 0;
const failingApp = {
  vault: {
    getFileByPath: () => file,
    cachedRead: async () => failingStore.get(file.path),
    modify: async () => {
      failedWrites += 1;
      throw new Error("simulated failure");
    }
  }
};
const failed = await api.persistConfirmedConceptUpdate(failingApp, {
  vaultPath: file.path,
  conceptId: concept.id,
  expectedRevision: concept.revision,
  expectedMarkdown: originalMarkdown,
  preparedMarkdown: prepared.markdown
});
assert.equal(failed.ok, false);
assert.equal(failed.error, "Vault update failed");
assert.equal(failingStore.get(file.path), originalMarkdown);

// Same-label awareness is explicit and never merges.
const sameLabel = api.createConceptNode({
  id: "concept-other-freedom",
  title: "Other",
  aliases: ["Freedom"],
  createdAt: at(0)
});
assert.deepEqual(
  JSON.parse(JSON.stringify(
    api.findConceptsSharingLabels([concept, target, sameLabel], concept)
      .map((item) => item.id)
  )),
  [sameLabel.id]
);

console.log(JSON.stringify({
  semanticLayersSeparated: true,
  explicitDefinitionReview: true,
  semanticDiffKinds: prepared.diff.map((item) => item.kind),
  restoreCreatesNewRevision: true,
  ordinaryAndFutureNotesRejected: true,
  confirmedVaultWrites: writes,
  staleAdditionalWrites: 0,
  failedPersistenceContentPreserved: true,
  result: "PASS"
}, null, 2));
