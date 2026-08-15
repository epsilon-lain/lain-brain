import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: "export * from './src/BrainGrowth';",
    resolveDir: process.cwd(),
    sourcefile: "brain-growth-entry.ts",
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
  JSON
});
const {
  addConceptRelationship,
  createConceptNode,
  findMissingConceptReferences,
  getConceptMeaningStatus,
  getConceptRevision,
  removeConceptRelationship,
  renderConceptNodeMarkdown,
  renderConceptRevisionMarkdown,
  resolveConceptMeaning,
  resolveConceptUnresolvedItem,
  restoreConceptRevision,
  updateConceptNode,
  updateConceptRelationship
} = module.exports;

const at = (minute) => `2026-08-14T00:${String(minute).padStart(2, "0")}:00.000Z`;
const change = (minute, reason) => ({ changedAt: at(minute), reason });
const userDefinition = (id, text, messageId = `message-${id}`) => ({
  id,
  text,
  sourceRefs: [{
    sourceKind: "message_span",
    messageId,
    snapshot: text,
    actor: "user"
  }]
});
const content = (id, text, source = "user material") => ({
  id,
  text,
  sourceReferences: [source]
});
const relation = (id, type, targetConceptId, targetLabel) => ({
  id,
  relation: type,
  targetConceptId,
  targetLabel,
  sourceReferences: ["reviewed relation"]
});

// Creation keeps the user's exact language separate from external meaning.
let node = createConceptNode({
  id: "concept-time",
  title: "Lain time",
  aliases: ["personal time"],
  userDefinition: userDefinition(
    "definition-time-v1",
    "时间是变化模式之间的关系。"
  ),
  standardDefinitions: [content(
    "standard-time",
    "A standard physics definition may describe time differently.",
    "external reference"
  )],
  unresolvedItems: [{
    id: "question-clock",
    kind: "question",
    text: "How should clocks relate to this definition?",
    alternatives: [],
    status: "open",
    sourceReferences: ["message-question"]
  }],
  createdAt: at(0)
});
assert.equal(node.id, "concept-time");
assert.equal(node.revision, 1);
assert.equal(node.userDefinition.text, "时间是变化模式之间的关系。");
assert.equal(node.standardDefinitions.length, 1);
assert.equal(node.history.length, 0);
assert.equal(getConceptMeaningStatus(node), "defined");
assert.ok(Object.isFrozen(node));
assert.ok(Object.isFrozen(node.userDefinition.sourceRefs[0]));

// A normal update grows the node and records the exact previous snapshot.
node = updateConceptNode(node, {
  examples: [content("example-season", "Seasonal change is one example.")],
  counterexamples: [content(
    "counter-static-label",
    "A static label alone is not a changing relation."
  )]
}, change(1, "Add reviewed examples"));
assert.equal(node.revision, 2);
assert.equal(node.examples.length, 1);
assert.equal(node.counterexamples.length, 1);
assert.equal(node.history.length, 1);
assert.equal(node.history[0].revision, 1);
assert.equal(node.history[0].snapshot.examples.length, 0);

// New conventional information never overwrites the user's current meaning.
const beforeStandardGrowth = node.userDefinition.text;
node = updateConceptNode(node, {
  standardDefinitions: [content(
    "dictionary-time",
    "A conventional definition used by another source.",
    "dictionary citation"
  )]
}, change(2, "Attach an external definition"));
assert.equal(node.userDefinition.text, beforeStandardGrowth);
assert.equal(node.standardDefinitions.length, 2);

// A conflicting user meaning is preserved as an alternative by default.
const alternative = userDefinition(
  "definition-time-v2",
  "时间是事件排序的尺度。"
);
node = updateConceptNode(node, {
  userDefinition: alternative
}, change(3, "Record a possible revised meaning"));
assert.equal(node.userDefinition.text, beforeStandardGrowth);
assert.equal(node.alternativeUserDefinitions.length, 1);
assert.equal(node.alternativeUserDefinitions[0].text, alternative.text);
assert.equal(getConceptMeaningStatus(node), "ambiguous");

// Explicit clarification promotes one preserved meaning; no AI confidence is used.
node = resolveConceptMeaning(
  node,
  alternative.id,
  change(4, "User selected the intended meaning")
);
assert.equal(node.userDefinition.text, alternative.text);
assert.equal(node.alternativeUserDefinitions.length, 0);
assert.equal(getConceptMeaningStatus(node), "defined");

// Relationship create/dedupe/update/remove and missing-reference detection.
const relatedToChange = relation(
  "relationship-change",
  "depends_on",
  "concept-change",
  "Change"
);
node = addConceptRelationship(
  node,
  relatedToChange,
  change(5, "Add concept relationship")
);
const relationshipRevision = node.revision;
const duplicateResult = addConceptRelationship(
  node,
  relation("relationship-duplicate", "depends_on", "concept-change", "Change"),
  change(6, "Attempt duplicate relationship")
);
assert.equal(duplicateResult, node);
assert.equal(duplicateResult.revision, relationshipRevision);
assert.equal(duplicateResult.relationships.length, 1);
assert.equal(
  findMissingConceptReferences(node, new Set(["concept-time"])).length,
  1
);
assert.equal(
  findMissingConceptReferences(
    node,
    new Set(["concept-time", "concept-change"])
  ).length,
  0
);
node = updateConceptRelationship(node, "relationship-change", {
  relation: "contrasts_with",
  targetConceptId: "concept-change",
  targetLabel: "Change",
  sourceReferences: ["user reviewed relation"]
}, change(7, "Refine relationship type"));
assert.equal(node.relationships[0].relation, "contrasts_with");
node = removeConceptRelationship(
  node,
  "relationship-change",
  change(8, "Remove relationship")
);
assert.equal(node.relationships.length, 0);

// Missing meaning is represented as ambiguity, not conventional substitution.
let unresolved = createConceptNode({
  id: "concept-a",
  title: "a",
  unresolvedItems: [{
    id: "meaning-a",
    kind: "meaning",
    text: "The user has not yet defined what a means.",
    alternatives: ["a as a personal symbol", "a as a conventional variable"],
    status: "open",
    sourceReferences: ["message-a"]
  }],
  createdAt: at(9)
});
assert.equal(unresolved.userDefinition, undefined);
assert.equal(getConceptMeaningStatus(unresolved), "ambiguous");
unresolved = updateConceptNode(unresolved, {
  userDefinition: userDefinition("definition-a", "a 是 lain 的变化单位。")
}, change(10, "User supplied a definition"));
unresolved = resolveConceptUnresolvedItem(
  unresolved,
  "meaning-a",
  "The user-defined meaning is authoritative for this node.",
  change(11, "Resolve the label ambiguity")
);
assert.equal(getConceptMeaningStatus(unresolved), "defined");

// Historical revisions remain inspectable and can be restored as a new change.
const revisionOne = getConceptRevision(node, 1);
assert.equal(revisionOne.userDefinition.text, "时间是变化模式之间的关系。");
assert.equal(revisionOne.examples.length, 0);
const renderedRevision = renderConceptRevisionMarkdown(node, 1);
assert.match(renderedRevision, /时间是变化模式之间的关系/);
const beforeRestoreRevision = node.revision;
node = restoreConceptRevision(
  node,
  1,
  change(12, "Restore the original concept state")
);
assert.equal(node.revision, beforeRestoreRevision + 1);
assert.equal(node.userDefinition.text, "时间是变化模式之间的关系。");
assert.equal(node.examples.length, 0);
assert.ok(node.history.some((entry) =>
  entry.revision === beforeRestoreRevision
));

// Markdown follows existing frontmatter conventions and does not invent links.
const markdown = renderConceptNodeMarkdown(node);
assert.match(markdown, /lain-brain-type: concept-node/);
assert.match(markdown, /lain-brain-concept-id: "concept-time"/);
assert.match(markdown, /## My definition/);
assert.match(markdown, /## Concept history/);
assert.equal(markdown.includes("[["), false);

// Same labels are not canonical identity, and non-user prose cannot masquerade
// as the user's definition.
const sameLabelDifferentNode = createConceptNode({
  id: "concept-time-other",
  title: "Lain time",
  createdAt: at(13)
});
assert.notEqual(sameLabelDifferentNode.id, node.id);
assert.equal(getConceptMeaningStatus(sameLabelDifferentNode), "ambiguous");
assert.throws(() => createConceptNode({
  id: "concept-invalid",
  title: "Invalid",
  userDefinition: {
    id: "invalid-definition",
    text: "AI rewritten meaning",
    sourceRefs: [{
      sourceKind: "message_span",
      messageId: "assistant-message",
      snapshot: "AI rewritten meaning",
      actor: "assistant"
    }]
  },
  createdAt: at(14)
}), /authored by the user/);

const bundledInputs = Object.keys(built.metafile.inputs);
assert.equal(bundledInputs.some((path) => path.includes("obsidian")), false);
assert.equal(bundledInputs.some((path) => path.includes("LainBrainSession")), false);

console.log(JSON.stringify({
  creation: true,
  safeModification: true,
  userMeaningPreserved: true,
  relationshipLifecycle: true,
  duplicateRelationshipPrevented: true,
  ambiguityRepresented: true,
  historyInspectAndRestore: true,
  markdownProjection: true,
  vaultWrites: 0,
  result: "PASS"
}, null, 2));
