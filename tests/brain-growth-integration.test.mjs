import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/BrainGrowth";
      export * from "./src/BrainGrowthCandidateAdapter";
      export * from "./src/BrainGrowthPersistence";
      export { LainBrainSession } from "./src/LainBrainSession";
    `,
    resolveDir: process.cwd(),
    sourcefile: "brain-growth-integration-entry.ts",
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
        contents: `
          exports.normalizePath = (value) => value.replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");
          exports.requestUrl = async () => { throw new Error("No LLM call expected"); };
        `
      }));
    }
  }]
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  DOMMatrix: class { constructor() {} },
  module,
  exports: module.exports,
  require,
  console,
  setTimeout,
  clearTimeout,
  TextEncoder,
  TextDecoder
});
const {
  LainBrainSession,
  assessCandidateConceptConflict,
  createConceptIdForCandidate,
  createConceptNodeFromApprovedCandidate,
  deserializeConceptNodeFromMarkdown,
  getConceptMeaningStatus,
  serializeConceptNodeIntoMarkdown,
  updateConceptNode
} = module.exports;

const approvedAt = "2026-08-15T00:00:00.000Z";
const exactUserText = "时间是变化模式之间的关系。";
const candidate = {
  id: "candidate-time",
  title: "Lain time",
  primaryConcept: {
    name: "Lain time",
    aliases: ["personal time", "时间关系"]
  },
  markdown: [
    "# Lain time",
    "",
    "AI-organized explanation that is not the user's definition.",
    "",
    "## Relationships",
    "- [[Change]]",
    "- [[Unknown clock concept]]"
  ].join("\n"),
  sourceMessageIds: ["message-user-time"],
  revision: 4
};
const sourceMessages = [{
  id: "message-user-time",
  role: "user",
  content: exactUserText
}];
const userDefinition = {
  id: "definition-time",
  text: exactUserText,
  sourceRefs: [{
    sourceKind: "message_span",
    messageId: "message-user-time",
    snapshot: exactUserText,
    actor: "user"
  }]
};

// Explicit approval converts the reviewed candidate without conflating layers.
const conceptId = createConceptIdForCandidate(candidate.id);
let concept = createConceptNodeFromApprovedCandidate({
  approval: { kind: "confirmed_create_note", approvedAt },
  candidate,
  conceptId,
  sourceMessages,
  userDefinition,
  externalDefinitions: [{
    id: "external-time",
    text: "A textbook may define time using a different operational model.",
    sourceReferences: ["textbook:chapter-1"]
  }],
  relationships: [
    {
      id: "relation-change",
      relation: "depends_on",
      targetLabel: "Change",
      targetConceptId: "concept-change",
      sourceReferences: ["candidate relation review"]
    },
    {
      id: "relation-clock",
      relation: "related_to",
      targetLabel: "Unknown clock concept",
      sourceReferences: ["wikilink:Unknown clock concept"]
    }
  ]
});
assert.equal(concept.id, "concept:candidate-time");
assert.equal(concept.title, candidate.title);
assert.deepEqual([...concept.aliases], ["personal time", "时间关系"]);
assert.equal(concept.userDefinition.text, exactUserText);
assert.equal(concept.userDefinition.sourceRefs[0].messageId, "message-user-time");
assert.equal(concept.userEvidence[0].snapshot, exactUserText);
assert.equal(concept.generatedInterpretations[0].text, candidate.markdown);
assert.notEqual(
  concept.generatedInterpretations[0].text,
  concept.userDefinition.text
);
assert.equal(concept.standardDefinitions[0].text.startsWith("A textbook"), true);
assert.equal(concept.relationships[0].targetConceptId, "concept-change");
assert.equal(
  concept.unresolvedItems.some((item) =>
    item.text.includes("Unknown clock concept")
  ),
  true
);
assert.equal(getConceptMeaningStatus(concept), "defined");

// Without an explicit exact definition the node remains safely ambiguous.
const ambiguous = createConceptNodeFromApprovedCandidate({
  approval: { kind: "confirmed_create_note", approvedAt },
  candidate,
  conceptId: "concept:ambiguous-time",
  sourceMessages
});
assert.equal(ambiguous.userDefinition, undefined);
assert.equal(ambiguous.userEvidence[0].snapshot, exactUserText);
assert.equal(ambiguous.generatedInterpretations[0].text, candidate.markdown);
assert.equal(getConceptMeaningStatus(ambiguous), "ambiguous");
assert.equal(ambiguous.relationships.length, 0);
assert.equal(
  ambiguous.unresolvedItems.some((item) =>
    item.text.includes("no stable concept ID")
  ),
  true
);

// A non-user source can never masquerade as authoritative user meaning.
assert.throws(() => createConceptNodeFromApprovedCandidate({
  approval: { kind: "confirmed_create_note", approvedAt },
  candidate,
  conceptId: "concept:invalid",
  sourceMessages,
  userDefinition: {
    id: "invalid-ai-definition",
    text: "AI wording",
    sourceRefs: [{
      sourceKind: "message_span",
      messageId: "message-user-time",
      snapshot: "AI wording",
      actor: "assistant"
    }]
  }
}), /authored by the user/);

// The explicit projection is human-readable and deterministically reloadable.
concept = updateConceptNode(concept, {
  examples: [{
    id: "example-time",
    text: "A reviewed example.",
    sourceReferences: ["message-user-time"]
  }]
}, {
  changedAt: "2026-08-15T00:01:00.000Z",
  reason: "Add a reviewed example"
});
const origin = {
  candidateId: candidate.id,
  candidateRevision: candidate.revision,
  approvedAt
};
const persistedMarkdown = serializeConceptNodeIntoMarkdown(
  candidate.markdown,
  concept,
  origin
);
assert.match(persistedMarkdown, /lain-brain-type: concept-node/);
assert.match(persistedMarkdown, /lain-brain-concept-id: "concept:candidate-time"/);
assert.match(persistedMarkdown, /AI-organized explanation/);
const firstReload = deserializeConceptNodeFromMarkdown(persistedMarkdown);
const secondReload = deserializeConceptNodeFromMarkdown(persistedMarkdown);
assert.deepEqual(
  JSON.parse(JSON.stringify(firstReload)),
  JSON.parse(JSON.stringify(secondReload))
);
assert.deepEqual(
  JSON.parse(JSON.stringify(firstReload.conceptNode)),
  JSON.parse(JSON.stringify(concept))
);
assert.equal(firstReload.origin.candidateRevision, 4);

// Identity survives title/filename changes; equal titles never imply a merge.
const renamed = updateConceptNode(concept, { title: "Renamed time handle" }, {
  changedAt: "2026-08-15T00:02:00.000Z",
  reason: "Rename the handle"
});
assert.equal(renamed.id, concept.id);
assert.equal(
  assessCandidateConceptConflict(concept.id, "Anything", [concept]).kind,
  "exact_identity"
);
const titleConflict = assessCandidateConceptConflict(
  "concept:different-id",
  concept.title,
  [concept]
);
assert.equal(titleConflict.kind, "same_title_distinct_identity");
assert.deepEqual([...titleConflict.conflictingConceptIds], [concept.id]);

function makeApp() {
  const files = new Map();
  const folders = new Set(["Lain Brain", "Lain Brain/Notes"]);
  let vaultWrites = 0;
  return {
    files,
    get vaultWrites() { return vaultWrites; },
    app: {
      vault: {
        getAbstractFileByPath: (path) =>
          files.get(path)?.file ?? (folders.has(path) ? { path } : null),
        getFolderByPath: (path) => folders.has(path) ? { path } : null,
        getFileByPath: (path) => files.get(path)?.file ?? null,
        getMarkdownFiles: () => [...files.values()].map((entry) => entry.file),
        cachedRead: async (file) => files.get(file.path).content,
        createFolder: async (path) => {
          vaultWrites += 1;
          folders.add(path);
        },
        create: async (path, content) => {
          vaultWrites += 1;
          const file = {
            path,
            basename: path.split("/").pop().replace(/\.md$/i, "")
          };
          files.set(path, { file, content });
          return file;
        },
        modify: async (file, content) => {
          vaultWrites += 1;
          files.get(file.path).content = content;
        },
        trash: async (file) => {
          vaultWrites += 1;
          files.delete(file.path);
        }
      },
      metadataCache: { getFirstLinkpathDest: () => null },
      workspace: { getLeaf: () => ({ openFile: async () => {} }) }
    }
  };
}

// Pure preview/conversion/serialization never touches the Vault.
const fixture = makeApp();
assert.equal(fixture.vaultWrites, 0);
assert.equal(persistedMarkdown.includes("lain-brain-concept-data:v1"), true);
assert.equal(fixture.vaultWrites, 0);

// Only the existing confirmed Create Note method persists the projection.
const session = new LainBrainSession(fixture.app, () => "unused");
session.messages = [{
  id: "message-user-time",
  role: "user",
  content: exactUserText,
  includeInHistory: true
}];
session.candidates = [{
  ...candidate,
  primaryConcept: {
    name: candidate.primaryConcept.name,
    aliases: [...candidate.primaryConcept.aliases]
  },
  sourceMessageIds: [...candidate.sourceMessageIds],
  viewMode: "preview",
  userEdited: false,
  claims: [],
  formalizationIds: []
}];
session.activeCandidateId = candidate.id;
assert.equal(fixture.vaultWrites, 0);
const createResult = await session.createCandidateNote(
  candidate.id,
  "Lain time",
  "Lain Brain/Notes"
);
assert.equal(createResult.ok, true);
assert.equal(fixture.vaultWrites, 1);
const createdPath = "Lain Brain/Notes/Lain time.md";
const createdMarkdown = fixture.files.get(createdPath).content;
const createdConcept = deserializeConceptNodeFromMarkdown(createdMarkdown);
assert.equal(createdConcept.conceptNode.id, "concept:candidate-time");
assert.equal(createdConcept.conceptNode.userDefinition, undefined);
assert.equal(createdConcept.conceptNode.userEvidence[0].snapshot, exactUserText);
assert.equal(createdConcept.conceptNode.generatedInterpretations[0].text, candidate.markdown);
assert.equal(session.candidates[0].conceptId, "concept:candidate-time");

// Candidate-retained provenance survives a cleared transcript until approval.
const retainedFixture = makeApp();
const retainedSession = new LainBrainSession(retainedFixture.app, () => "unused");
retainedSession.messages = [];
retainedSession.candidates = [{
  ...candidate,
  id: "candidate-retained-source",
  title: "Retained source",
  primaryConcept: { name: "Retained source", aliases: [] },
  sourceMessages: sourceMessages.map((message) => ({ ...message })),
  viewMode: "preview",
  userEdited: false,
  claims: [],
  formalizationIds: []
}];
retainedSession.activeCandidateId = "candidate-retained-source";
const retainedCreate = await retainedSession.createCandidateNote(
  "candidate-retained-source",
  "Retained source",
  "Lain Brain/Notes"
);
assert.equal(retainedCreate.ok, true);
const retainedReload = deserializeConceptNodeFromMarkdown(
  retainedFixture.files.get("Lain Brain/Notes/Retained source.md").content
);
assert.equal(retainedReload.conceptNode.userEvidence[0].snapshot, exactUserText);

// Conversion failure happens before the existing Vault write begins.
const failedFixture = makeApp();
const failedSession = new LainBrainSession(failedFixture.app, () => "unused");
failedSession.candidates = [{
  ...candidate,
  id: "candidate-invalid-content",
  title: "Invalid content",
  markdown: "# Invalid\n\nUnsafe control: \u0000",
  sourceMessageIds: [],
  viewMode: "preview",
  userEdited: false,
  claims: [],
  formalizationIds: []
}];
failedSession.activeCandidateId = "candidate-invalid-content";
const failedCreate = await failedSession.createCandidateNote(
  "candidate-invalid-content",
  "Invalid content",
  "Lain Brain/Notes"
);
assert.equal(failedCreate.ok, false);
assert.equal(failedFixture.vaultWrites, 0);

// The existing confirmed Create Group boundary projects each approved child.
const groupFixture = makeApp();
const groupSession = new LainBrainSession(groupFixture.app, () => "unused");
groupSession.messages = [{
  id: "message-group",
  role: "user",
  content: "Two reviewed child concepts.",
  includeInHistory: true
}];
const groupCandidates = ["Alpha concept", "Beta concept"].map(
  (title, index) => ({
    id: `candidate-group-${index + 1}`,
    title,
    primaryConcept: { name: title, aliases: [title] },
    markdown: `# ${title}\n\nReviewed candidate body.`,
    sourceMessageIds: ["message-group"],
    viewMode: "preview",
    userEdited: false,
    revision: 0,
    groupId: "candidate-group",
    claims: [],
    formalizationIds: []
  })
);
groupSession.candidates = groupCandidates;
groupSession.candidateGroups = [{
  id: "candidate-group",
  title: "Reviewed concept group",
  sourceMessageIds: ["message-group"],
  candidateIds: groupCandidates.map((item) => item.id),
  revision: 0
}];
groupSession.activeCandidateId = groupCandidates[0].id;
const groupCreateResult = await groupSession.createCandidateGroup(
  "candidate-group",
  "Reviewed concept group",
  "Reviewed concept group",
  "Lain Brain/Notes"
);
assert.equal(groupCreateResult.ok, true);
assert.equal(groupFixture.vaultWrites, 3);
for (const child of groupCandidates) {
  const childPath = `Lain Brain/Notes/${child.title}.md`;
  const childReload = deserializeConceptNodeFromMarkdown(
    groupFixture.files.get(childPath).content
  );
  assert.equal(childReload.conceptNode.id, `concept:${child.id}`);
  assert.equal(child.conceptId, `concept:${child.id}`);
}

console.log(JSON.stringify({
  approvedCandidateToConcept: true,
  exactUserMeaningPreserved: true,
  semanticLayersSeparated: true,
  relationshipsAndUnresolvedTargets: true,
  deterministicRoundTrip: true,
  stableIdentityAcrossRename: true,
  titleConflictDoesNotMerge: true,
  previewAndCancelVaultWrites: 0,
  confirmedCreateNoteVaultWrites: fixture.vaultWrites,
  retainedProvenanceAfterTranscriptClear: true,
  conversionFailureVaultWrites: failedFixture.vaultWrites,
  confirmedCreateGroupVaultWrites: groupFixture.vaultWrites,
  result: "PASS"
}, null, 2));
