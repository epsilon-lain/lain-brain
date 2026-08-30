import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/ChatSemanticDelta';",
      "export { createChatSemanticDeltaAnalysisSystemPrompt } from './src/ChatSemanticDeltaAnalyzer';",
      "export { createConceptNode, updateConceptNode } from './src/BrainGrowth';",
      "export { serializeConceptNodeIntoMarkdown, inspectConceptMarkdown } from './src/BrainGrowthPersistence';",
      "export { createConceptIndex } from './src/BrainGrowthIndex';",
      "export { LainBrainSession } from './src/LainBrainSession';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "chat-semantic-delta-entry.ts",
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
          "exports.TFile = class TFile { constructor(path) { this.path = path; this.basename = path.replace(/^.*\\//, '').replace(/\\.md$/i, ''); this.extension = 'md'; } };",
          "exports.MarkdownView = class MarkdownView {};",
          "exports.normalizePath = (value) => value.replace(/\\\\/g, '/').replace(/\\/{2,}/g, '/');",
          "exports.parseLinktext = (value) => ({ path: value, subpath: '' });",
          "exports.resolveSubpath = () => null;",
          "exports.requestUrl = async () => { throw new Error('Unexpected model transport'); };"
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
let nextId = 0;
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console,
  Object,
  Map,
  Set,
  JSON,
  URL,
  Blob,
  DOMMatrix: class DOMMatrix {},
  crypto: { randomUUID: () => `delta-message-${++nextId}` },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  setTimeout,
  clearTimeout,
  Promise
});

const {
  LainBrainSession,
  createChatSemanticDeltaAnalysisSystemPrompt,
  createChatSemanticDeltaProposal,
  createConceptIndex,
  createConceptNode,
  inspectConceptMarkdown,
  parseChatSemanticDeltaAnalysisJson,
  selectChatSemanticDeltaParticipant,
  serializeConceptNodeIntoMarkdown,
  updateConceptNode
} = module.exports;

let passes = 0;
function pass(message) {
  passes += 1;
  console.log(`PASS ${passes}: ${message}`);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function analysisRequest(messages) {
  return {
    currentUserMessageId: messages.filter((item) => item.role === "user").at(-1).id,
    conversation: messages
  };
}

function modelProposal({
  conceptQuery = "A",
  proposedMeaning = "X",
  messageId = "user-1",
  quote = "When I say A, I mean X."
} = {}) {
  return JSON.stringify({
    outcome: "possible_principal_change",
    changeKind: "personal_definition",
    conceptQuery,
    proposedMeaning,
    reason: "The user explicitly defined the concept.",
    confidence: 0.93,
    explicitness: "explicit",
    tentative: false,
    evidence: [{ messageId, quote }]
  });
}

const strongMessages = [{
  id: "user-1",
  role: "user",
  content: "When I say A, I mean X."
}];
const strong = parseChatSemanticDeltaAnalysisJson(
  modelProposal(),
  analysisRequest(strongMessages)
);
assert.equal(strong.kind, "possible_principal_change");
assert.equal(strong.evidence[0].snapshot, strongMessages[0].content);
assert.equal(strong.evidence[0].startOffset, 0);
assert.equal(strong.evidence[0].endOffset, strongMessages[0].content.length);
pass("strong definition preserves exact user evidence and offsets");

const redefinitionText = "I used to define A as X. Now I define it as Y.";
const redefinition = parseChatSemanticDeltaAnalysisJson(modelProposal({
  proposedMeaning: "Y",
  quote: redefinitionText
}), analysisRequest([{ id: "user-1", role: "user", content: redefinitionText }]));
assert.equal(redefinition.proposedMeaning, "Y");
pass("explicit redefinition is accepted as a non-authoritative analysis result");

assert.equal(parseChatSemanticDeltaAnalysisJson(
  '{"outcome":"no_meaningful_change"}',
  analysisRequest([{ id: "q", role: "user", content: "What does A mean?" }])
).kind, "no_meaningful_change");
pass("question-only analysis produces no proposal");

const tentative = JSON.parse(modelProposal());
tentative.tentative = true;
assert.equal(parseChatSemanticDeltaAnalysisJson(
  JSON.stringify(tentative),
  analysisRequest(strongMessages)
).kind, "no_meaningful_change");
pass("tentative speculation cannot become a proposal");

assert.throws(() => parseChatSemanticDeltaAnalysisJson(modelProposal({
  messageId: "assistant-1"
}), analysisRequest([
  ...strongMessages,
  { id: "assistant-1", role: "assistant", content: "When I say A, I mean X." }
])), /user message/);
pass("assistant-only wording cannot become user evidence");

const wrapped = "I probably do not understand this, but when I say A I really mean X.";
const wrappedAnalysis = parseChatSemanticDeltaAnalysisJson(modelProposal({
  quote: "when I say A I really mean X",
  proposedMeaning: "X"
}), analysisRequest([{ id: "user-1", role: "user", content: wrapped }]));
assert.equal(wrappedAnalysis.evidence[0].snapshot, wrapped);
pass("self-deprecating wrapper does not hide explicit semantic evidence");

assert.equal(parseChatSemanticDeltaAnalysisJson(
  '{"outcome":"ambiguous_change","reason":"Two changes are comparable."}',
  analysisRequest(strongMessages)
).kind, "ambiguous_change");
assert.throws(() => parseChatSemanticDeltaAnalysisJson(
  modelProposal({ conceptQuery: "A\nB" }),
  analysisRequest(strongMessages)
), /single line/);
pass("multiple comparable changes stay ambiguous and labels must be single-line");

const prompt = createChatSemanticDeltaAnalysisSystemPrompt();
assert.match(prompt, /at most one principal durable semantic change/);
assert.match(prompt, /Prefer no_meaningful_change/);
assert.match(prompt, /Never claim confirmation/);
assert.match(prompt, /Never use assistant text as user evidence/);
assert.match(prompt, /strict JSON only/);
pass("analysis prompt is conservative, bounded to one change, and non-authoritative");

const relationText = "ZIP depends on Personal Brain.";
const relationRequest = analysisRequest([{
  id: "relation-user",
  role: "user",
  content: relationText
}]);
const relationAnalysis = parseChatSemanticDeltaAnalysisJson(JSON.stringify({
  outcome: "possible_principal_change",
  changeKind: "relationship_confirmed",
  sourceConceptQuery: "ZIP",
  targetConceptQuery: "Personal Brain",
  relationType: "depends_on",
  reason: "The user explicitly established a dependency.",
  confidence: 0.96,
  explicitness: "explicit",
  tentative: false,
  evidence: [{ messageId: "relation-user", quote: relationText }]
}), relationRequest);
assert.equal(relationAnalysis.changeKind, "relationship_confirmed");
assert.equal(relationAnalysis.sourceConceptQuery, "ZIP");
assert.equal(relationAnalysis.targetConceptQuery, "Personal Brain");
assert.equal(relationAnalysis.relationType, "depends_on");
assert.equal(relationAnalysis.evidence[0].snapshot, relationText);

const tentativeRelation = JSON.parse(JSON.stringify({
  outcome: "possible_principal_change",
  changeKind: "relationship_confirmed",
  sourceConceptQuery: "ZIP",
  targetConceptQuery: "Personal Brain",
  relationType: "analogous_to",
  reason: "Tentative analogy.",
  confidence: 0.5,
  explicitness: "explicit",
  tentative: true,
  evidence: [{ messageId: "relation-user", quote: relationText }]
}));
assert.equal(parseChatSemanticDeltaAnalysisJson(
  JSON.stringify(tentativeRelation), relationRequest
).kind, "no_meaningful_change");
assert.throws(() => parseChatSemanticDeltaAnalysisJson(JSON.stringify({
  ...tentativeRelation,
  tentative: false,
  relationType: "equivalent_to"
}), relationRequest), /Unsupported structural relation type/);
assert.match(prompt, /Preserve direction and the exact relation type/);
assert.match(prompt, /analogous_to is not equivalence/);
assert.match(prompt, /explicit correction of the assistant ranks above/);
pass("typed relation parsing preserves direction and evidence while rejecting tentative or unsupported relations");

const definitionSource = [{
  sourceKind: "message_span",
  messageId: "origin",
  startOffset: 0,
  endOffset: 12,
  snapshot: "A means old.",
  actor: "user"
}];
const conceptA = createConceptNode({
  id: "concept:stable-a",
  title: "Renamed A",
  aliases: ["A", "Alpha"],
  userDefinition: { id: "definition-a", text: "A means old.", sourceRefs: definitionSource },
  createdAt: "2026-01-01T00:00:00.000Z"
});
const records = [{ vaultPath: "Lain Brain/Notes/Renamed A.md", concept: conceptA }];
const index = createConceptIndex([conceptA]);
const created = createChatSemanticDeltaProposal(strong, index, records, {
  createdAt: "2026-01-02T00:00:00.000Z",
  createdAtUserTurn: 1
});
assert.equal(created.kind, "proposal");
assert.equal(created.proposal.target.kind, "known_concept");
assert.equal(created.proposal.target.conceptId, "concept:stable-a");
assert.equal(created.proposal.target.title, "Renamed A");
assert.equal(created.proposal.authority, "proposed");
pass("unique alias resolves through stable identity after a title rename");

const duplicateA = createConceptNode({
  id: "concept:other-a",
  title: "Other",
  aliases: ["A"],
  createdAt: "2026-01-01T00:00:00.000Z"
});
const ambiguousCreated = createChatSemanticDeltaProposal(
  strong,
  createConceptIndex([conceptA, duplicateA]),
  [...records, { vaultPath: "Lain Brain/Notes/Other.md", concept: duplicateA }],
  { createdAt: "fixed", createdAtUserTurn: 1 }
);
assert.equal(ambiguousCreated.proposal.target.kind, "ambiguous_concept");
assert.equal(ambiguousCreated.proposal.target.choices.length, 2);
pass("same-label concepts remain ambiguous and never silently merge");

const missingCreated = createChatSemanticDeltaProposal(
  strong,
  createConceptIndex([]),
  [],
  { createdAt: "fixed", createdAtUserTurn: 1 }
);
assert.equal(missingCreated.proposal.target.kind, "new_concept");
const repeatedCreated = createChatSemanticDeltaProposal(
  strong,
  createConceptIndex([]),
  [],
  { createdAt: "different", createdAtUserTurn: 99 }
);
assert.equal(missingCreated.proposal.fingerprint, repeatedCreated.proposal.fingerprint);
pass("missing concept remains reviewed-new and proposal fingerprints are deterministic");

function makeApp() {
  const files = new Map();
  const folders = new Set(["Lain Brain", "Lain Brain/Notes"]);
  const operations = [];
  const app = {
    workspace: {
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
      getLeaf: () => ({ openFile: async () => {} })
    },
    metadataCache: {
      resolvedLinks: {},
      getFileCache: () => null,
      getFirstLinkpathDest: () => null
    },
    vault: {
      getMarkdownFiles: () => [...files.values()].map((entry) => entry.file),
      getAbstractFileByPath: (path) => files.get(path)?.file ?? (folders.has(path) ? { path } : null),
      getFileByPath: (path) => files.get(path)?.file ?? null,
      getFolderByPath: (path) => folders.has(path) ? { path } : null,
      cachedRead: async (file) => files.get(file.path)?.content ?? "",
      createFolder: async (path) => { operations.push(["createFolder", path]); folders.add(path); },
      create: async (path, content) => {
        operations.push(["create", path, content]);
        const file = { path, basename: path.replace(/^.*\//, "").replace(/\.md$/i, ""), extension: "md" };
        files.set(path, { file, content });
        return file;
      },
      modify: async (file, content) => {
        operations.push(["modify", file.path, content]);
        files.set(file.path, { file, content });
      },
      trash: async () => { throw new Error("Unexpected trash"); }
    }
  };
  return { app, files, operations };
}

function makePropagation() {
  const calls = [];
  return {
    calls,
    port: {
      recordConfirmedDelta: async (delta, path) => { calls.push(["record", delta, path]); return true; },
      markOriginWriteFailed: async (id) => { calls.push(["failed", id]); },
      markOriginCommittedAndEnqueue: async (id) => { calls.push(["enqueue", id]); }
    }
  };
}

function seedConcept(fixture, concept, title = concept.title) {
  const path = `Lain Brain/Notes/${title}.md`;
  const file = { path, basename: title, extension: "md" };
  const content = serializeConceptNodeIntoMarkdown(`# ${title}`, concept, {
    candidateId: `fixture:${concept.id}`,
    candidateRevision: 0,
    approvedAt: concept.createdAt
  });
  fixture.files.set(path, { file, content });
  return path;
}

function structuralAnalysis(request, input) {
  const message = request.conversation.find((item) =>
    item.id === request.currentUserMessageId
  );
  return {
    kind: "possible_principal_change",
    changeKind: input.changeKind,
    sourceConceptQuery: input.source,
    ...(input.changeKind === "ambiguity_resolved"
      ? {
          selectedConceptQuery: input.target,
          ambiguityLabel: input.ambiguityLabel
        }
      : { targetConceptQuery: input.target }),
    ...(input.relationType === undefined
      ? {}
      : { relationType: input.relationType }),
    ...(input.distinctionText === undefined
      ? {}
      : { distinctionText: input.distinctionText }),
    reason: input.reason ?? "The user explicitly changed concept structure.",
    confidence: 0.95,
    evidence: [{
      sourceKind: "message_span",
      messageId: message.id,
      startOffset: 0,
      endOffset: message.content.length,
      snapshot: message.content,
      actor: "user"
    }]
  };
}

function makeSession({ analyzer, enabled = true, apiKey = "configured-key", appFixture } = {}) {
  const fixture = appFixture ?? makeApp();
  const asks = [];
  const session = new LainBrainSession(
    fixture.app,
    () => apiKey,
    () => null,
    { analyzeImage: async () => { throw new Error("Vision not expected"); } },
    async (_key, history) => { asks.push(plain(history)); return "Normal assistant answer."; }
  );
  session.setChatSemanticAnalyzer(async () => { throw new Error("Shadow ignored in this test"); });
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => enabled);
  if (analyzer !== undefined) session.setChatSemanticDeltaAnalyzer(analyzer);
  return { fixture, session, asks };
}

const evidenceAnalysis = (request, title = "Lain Time") => ({
  kind: "possible_principal_change",
  changeKind: "personal_definition",
  conceptQuery: title,
  proposedMeaning: "Time is the relation between patterns of change.",
  reason: "The user explicitly defined the concept.",
  confidence: 0.9,
  evidence: [{
    sourceKind: "message_span",
    messageId: request.currentUserMessageId,
    startOffset: 0,
    endOffset: request.conversation.find((item) => item.id === request.currentUserMessageId).content.length,
    snapshot: request.conversation.find((item) => item.id === request.currentUserMessageId).content,
    actor: "user"
  }]
});

// The real public send path answers first, then exposes only a proposal.
{
  let release;
  let captured;
  const held = new Promise((resolve) => { release = resolve; });
  const { fixture, session } = makeSession({ analyzer: async (_key, request) => {
    captured = plain(request);
    await held;
    return evidenceAnalysis(request);
  } });
  session.setDraft("When I say Lain Time, I mean the relation between patterns of change.");
  assert.equal(await session.send(), "sent");
  assert.equal(session.getChatTranscriptMessages().at(-1).content, "Normal assistant answer.");
  assert.equal(session.getActiveChatSemanticDeltaProposal(), undefined);
  assert.equal(fixture.operations.length, 0);
  release();
  await session.waitForChatSemanticDelta();
  assert.equal(session.getActiveChatSemanticDeltaProposal().authority, "proposed");
  assert.equal(fixture.operations.length, 0);
  assert.equal(captured.conversation.length, 2);
  assert.equal(captured.conversation[0].content.includes("When I say Lain Time"), true);
  assert.equal(JSON.stringify(captured).includes("configured-key"), false);
  pass("normal chat completes before supplemental analysis and proposal performs zero writes");
}

// Editing remains local; explicit confirmation is the sole write boundary.
{
  const setup = makeSession({ analyzer: async (_key, request) => evidenceAnalysis(request) });
  const propagation = makePropagation();
  setup.session.setSemanticPropagationCoordinator(propagation.port);
  setup.session.setDraft("When I say Lain Time, I mean the relation between patterns of change.");
  await setup.session.send();
  await setup.session.waitForChatSemanticDelta();
  setup.session.beginChatSemanticDeltaEdit();
  setup.session.setChatSemanticDeltaMeaningDraft("Time is a relation among changing patterns.");
  assert.equal(setup.fixture.operations.length, 0);
  assert.equal(propagation.calls.length, 0);
  const result = await setup.session.confirmActiveChatSemanticDelta();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(setup.fixture.operations.filter((item) => item[0] === "create").length, 1);
  assert.equal(propagation.calls.filter((item) => item[0] === "record").length, 1);
  assert.equal(propagation.calls.filter((item) => item[0] === "enqueue").length, 1);
  assert.equal(result.delta.confirmation.userEvidence.some((item) =>
    item.sourceKind === "user_edit" && item.snapshot === "Time is a relation among changing patterns."
  ), true);
  assert.equal(setup.session.getActiveChatSemanticDeltaProposal().status, "confirmed");
  pass("edited confirmation creates one authoritative delta, one concept, and one propagation handoff");
}

// Rejecting and disabling analysis are side-effect free.
{
  let calls = 0;
  const rejected = makeSession({ analyzer: async (_key, request) => { calls += 1; return evidenceAnalysis(request); } });
  rejected.session.setDraft("When I say Lain Time, I mean change relations.");
  await rejected.session.send();
  await rejected.session.waitForChatSemanticDelta();
  rejected.session.rejectActiveChatSemanticDelta();
  assert.equal(rejected.session.getActiveChatSemanticDeltaProposal().status, "rejected");
  assert.equal(rejected.fixture.operations.length, 0);

  const disabled = makeSession({ enabled: false, analyzer: async () => { calls += 1; throw new Error("disabled analyzer ran"); } });
  disabled.session.setDraft("When I say A, I mean X.");
  await disabled.session.send();
  await disabled.session.waitForChatSemanticDelta();
  assert.equal(calls, 1);
  assert.equal(disabled.session.getActiveChatSemanticDeltaProposal(), undefined);
  assert.equal(disabled.fixture.operations.length, 0);
  pass("reject and disabled-analysis paths never mutate the Brain");
}

// A short chat confirmation keeps the assistant-card proposal and the exact
// confirming user message as distinct, honest provenance.
{
  const setup = makeSession({ analyzer: async (_key, request) => evidenceAnalysis(request, "Short Confirm Concept") });
  const propagation = makePropagation();
  setup.session.setSemanticPropagationCoordinator(propagation.port);
  setup.session.setDraft("When I say Short Confirm Concept, I mean this durable definition.");
  await setup.session.send();
  await setup.session.waitForChatSemanticDelta();
  setup.session.setDraft("对喵");
  assert.equal(await setup.session.send(), "sent");
  const recorded = propagation.calls.find((item) => item[0] === "record")[1];
  assert.equal(recorded.confirmation.userEvidence.some((item) =>
    item.sourceKind === "message_span" && item.snapshot === "对喵"
  ), true);
  assert.equal(recorded.confirmation.userEvidence.some((item) =>
    item.sourceKind === "user_edit" && item.snapshot === "Time is the relation between patterns of change."
  ), true);
  assert.equal(setup.session.getActiveChatSemanticDeltaProposal().status, "confirmed");
  pass("bare confirmation preserves the exact user acceptance and reviewed definition provenance chain");
}

// Fail-open analysis cannot break the foreground response.
{
  const failed = makeSession({ analyzer: async () => { throw new Error("invalid model result"); } });
  failed.session.setDraft("Ordinary conversation.");
  assert.equal(await failed.session.send(), "sent");
  await failed.session.waitForChatSemanticDelta();
  assert.equal(failed.session.getChatTranscriptMessages().at(-1).content, "Normal assistant answer.");
  assert.equal(failed.session.getChatSemanticDeltaFailureCount(), 1);
  assert.equal(failed.fixture.operations.length, 0);
  pass("semantic analysis failure is fail-open for normal chat");
}

// Attachment-bearing foreground turns remain outside this text-only analyzer.
{
  let analysisCalls = 0;
  const fixture = makeApp();
  const profile = {
    id: "vision-provider",
    displayName: "Vision Provider",
    protocol: "openai-responses",
    baseUrl: "https://example.test/v1/responses",
    model: "vision-model",
    apiKey: "vision-secret",
    capabilities: { supportsText: true, supportsImages: true, supportsPdf: false }
  };
  const session = new LainBrainSession(
    fixture.app,
    () => "configured-key",
    () => profile,
    { analyzeImage: async () => ({
      text: "Vision answer.",
      providerId: profile.id,
      providerDisplayName: profile.displayName
    }) }
  );
  session.setChatSemanticDeltaAnalyzer(async () => {
    analysisCalls += 1;
    return { kind: "no_meaningful_change" };
  });
  session.addChatAttachment({
    name: "private.png",
    type: "image/png",
    size: 4,
    arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer
  });
  session.setDraft("Text beside a private image.");
  assert.equal(await session.send(profile.id), "sent");
  await session.waitForChatSemanticDelta();
  assert.equal(analysisCalls, 0);
  assert.equal(fixture.operations.length, 0);
  pass("image turns and attachment bytes are never sent to Semantic Delta analysis");
}

// With no configured DeepSeek key, normal key handling remains authoritative
// and no supplemental request is scheduled.
{
  let analysisCalls = 0;
  const missingKey = makeSession({
    apiKey: "",
    analyzer: async () => { analysisCalls += 1; return { kind: "no_meaningful_change" }; }
  });
  missingKey.session.setDraft("When I say A, I mean X.");
  assert.equal(await missingKey.session.send(), "blocked");
  await missingKey.session.waitForChatSemanticDelta();
  assert.equal(analysisCalls, 0);
  assert.equal(missingKey.fixture.operations.length, 0);
  pass("no DeepSeek connection means no supplemental semantic request");
}

// The analysis request is deliberately bounded to three recent text turns.
{
  const requests = [];
  const bounded = makeSession({ analyzer: async (_key, request) => {
    requests.push(plain(request));
    return { kind: "no_meaningful_change" };
  } });
  for (const text of ["turn one", "turn two", "turn three", "turn four"]) {
    bounded.session.setDraft(text);
    await bounded.session.send();
    await bounded.session.waitForChatSemanticDelta();
  }
  const last = requests.at(-1);
  assert.equal(last.conversation.length, 6);
  assert.equal(last.conversation.some((item) => item.content === "turn one"), false);
  assert.deepEqual(last.conversation.filter((item) => item.role === "user").map((item) => item.content), [
    "turn two", "turn three", "turn four"
  ]);
  pass("analysis receives only the three most recent eligible text turns");
}

// Moving on expires the active target, so an unrelated later yes cannot confirm it.
{
  let analyses = 0;
  const expired = makeSession({ analyzer: async (_key, request) => {
    analyses += 1;
    return analyses === 1 ? evidenceAnalysis(request) : { kind: "no_meaningful_change" };
  } });
  const propagation = makePropagation();
  expired.session.setSemanticPropagationCoordinator(propagation.port);
  expired.session.setDraft("When I say Lain Time, I mean change relations.");
  await expired.session.send();
  await expired.session.waitForChatSemanticDelta();
  expired.session.setDraft("Let us discuss something unrelated.");
  await expired.session.send();
  await expired.session.waitForChatSemanticDelta();
  assert.equal(expired.session.getActiveChatSemanticDeltaProposal().status, "expired");
  expired.session.setDraft("yes");
  await expired.session.send();
  assert.equal(propagation.calls.length, 0);
  pass("unrelated conversation expires a proposal before a later bare confirmation");
}

// Explicit structural confirmation updates only the stable-ID source node.
{
  const setup = makeSession({ analyzer: async (_key, request) =>
    structuralAnalysis(request, {
      changeKind: "relationship_confirmed",
      source: "A",
      target: "B",
      relationType: "depends_on"
    })
  });
  const source = createConceptNode({
    id: "concept:a",
    title: "A",
    createdAt: "2026-02-01T00:00:00.000Z"
  });
  const target = createConceptNode({
    id: "concept:b",
    title: "B",
    createdAt: "2026-02-01T00:00:00.000Z"
  });
  const sourcePath = seedConcept(setup.fixture, source);
  const targetPath = seedConcept(setup.fixture, target);
  const propagation = makePropagation();
  setup.session.setSemanticPropagationCoordinator(propagation.port);
  setup.session.setDraft("A depends on B.");
  await setup.session.send();
  await setup.session.waitForChatSemanticDelta();
  const proposal = setup.session.getActiveChatSemanticDeltaProposal();
  assert.equal(proposal.changeKind, "relationship_confirmed");
  assert.equal(proposal.target.conceptId, "concept:a");
  assert.equal(proposal.secondaryTarget.conceptId, "concept:b");
  assert.equal(setup.fixture.operations.length, 0);
  const result = await setup.session.confirmActiveChatSemanticDelta();
  assert.equal(result.ok, true, JSON.stringify(result));
  const persisted = inspectConceptMarkdown(setup.fixture.files.get(sourcePath).content);
  assert.equal(persisted.kind, "concept_node");
  assert.equal(persisted.persisted.conceptNode.relationships.length, 1);
  assert.equal(persisted.persisted.conceptNode.relationships[0].relation, "depends_on");
  assert.equal(persisted.persisted.conceptNode.relationships[0].targetConceptId, "concept:b");
  assert.equal(persisted.persisted.conceptNode.history.length, 1);
  assert.equal(setup.fixture.files.get(targetPath).content.includes("concept:b"), true);
  const operationCount = setup.fixture.operations.length;
  assert.equal((await setup.session.confirmActiveChatSemanticDelta()).ok, false);
  assert.equal(setup.fixture.operations.length, operationCount);
  assert.equal(propagation.calls.filter((call) => call[0] === "record").length, 1);
  assert.equal(propagation.calls.filter((call) => call[0] === "enqueue").length, 1);
  pass("confirmed directional relationship writes one source revision and replay creates no duplicate");
}

// A proposal cannot write after its checked source revision becomes stale.
{
  const setup = makeSession({ analyzer: async (_key, request) =>
    structuralAnalysis(request, {
      changeKind: "relationship_confirmed",
      source: "Stale A",
      target: "Stale B",
      relationType: "depends_on"
    })
  });
  const source = createConceptNode({ id: "concept:stale-a", title: "Stale A", createdAt: "2026-02-01T01:00:00.000Z" });
  const target = createConceptNode({ id: "concept:stale-b", title: "Stale B", createdAt: "2026-02-01T01:00:00.000Z" });
  const sourcePath = seedConcept(setup.fixture, source);
  seedConcept(setup.fixture, target);
  const propagation = makePropagation();
  setup.session.setSemanticPropagationCoordinator(propagation.port);
  setup.session.setDraft("Stale A depends on Stale B.");
  await setup.session.send();
  await setup.session.waitForChatSemanticDelta();
  const newer = updateConceptNode(source, { aliases: ["Concurrent edit"] }, {
    changedAt: "2026-02-01T02:00:00.000Z",
    reason: "Concurrent user edit"
  });
  setup.fixture.files.get(sourcePath).content = serializeConceptNodeIntoMarkdown(
    setup.fixture.files.get(sourcePath).content,
    newer,
    { candidateId: "fixture:stale", candidateRevision: 0, approvedAt: source.createdAt }
  );
  const result = await setup.session.confirmActiveChatSemanticDelta();
  assert.equal(result.ok, false);
  assert.equal(setup.fixture.operations.length, 0);
  assert.equal(propagation.calls.length, 0);
  pass("stale structural confirmation performs zero Vault mutation and queues no propagation");
}

// Removal targets the exact relation key and preserves other edges and history.
{
  const setup = makeSession({ analyzer: async (_key, request) =>
    structuralAnalysis(request, {
      changeKind: "relationship_removed",
      source: "A",
      target: "B",
      relationType: "depends_on"
    })
  });
  const target = createConceptNode({
    id: "concept:b-remove",
    title: "B",
    createdAt: "2026-02-02T00:00:00.000Z"
  });
  const source = createConceptNode({
    id: "concept:a-remove",
    title: "A",
    relationships: [
      { id: "dep", relation: "depends_on", targetConceptId: target.id, targetLabel: "B", sourceReferences: ["fixture"] },
      { id: "analogy", relation: "analogous_to", targetConceptId: target.id, targetLabel: "B", sourceReferences: ["fixture"] }
    ],
    createdAt: "2026-02-02T00:00:00.000Z"
  });
  const sourcePath = seedConcept(setup.fixture, source);
  seedConcept(setup.fixture, target);
  const propagation = makePropagation();
  setup.session.setSemanticPropagationCoordinator(propagation.port);
  setup.session.setDraft("A no longer depends on B.");
  await setup.session.send();
  await setup.session.waitForChatSemanticDelta();
  assert.equal(setup.fixture.operations.length, 0);
  assert.equal((await setup.session.confirmActiveChatSemanticDelta()).ok, true);
  const persisted = inspectConceptMarkdown(setup.fixture.files.get(sourcePath).content).persisted.conceptNode;
  assert.deepEqual(plain(persisted.relationships.map((item) => item.relation)), ["analogous_to"]);
  assert.equal(persisted.history[0].snapshot.relationships.length, 2);
  pass("relationship removal deletes only the exact edge and preserves historical provenance");
}

// Distinction is first-class rather than a merge or blanket relationship removal.
{
  const setup = makeSession({ analyzer: async (_key, request) =>
    structuralAnalysis(request, {
      changeKind: "concept_distinction",
      source: "ZIP",
      target: "ConceptNode",
      distinctionText: "ZIP is the semantic object; ConceptNode is its storage representation."
    })
  });
  const source = createConceptNode({
    id: "concept:zip",
    title: "ZIP",
    relationships: [{ id: "old", relation: "related_to", targetConceptId: "concept:node", targetLabel: "ConceptNode", sourceReferences: ["fixture"] }],
    createdAt: "2026-02-03T00:00:00.000Z"
  });
  const target = createConceptNode({
    id: "concept:node",
    title: "ConceptNode",
    createdAt: "2026-02-03T00:00:00.000Z"
  });
  const sourcePath = seedConcept(setup.fixture, source);
  const targetPath = seedConcept(setup.fixture, target);
  const targetBefore = setup.fixture.files.get(targetPath).content;
  const propagation = makePropagation();
  setup.session.setSemanticPropagationCoordinator(propagation.port);
  setup.session.setDraft("No: ZIP is the semantic object; ConceptNode is how Brain stores it.");
  await setup.session.send();
  await setup.session.waitForChatSemanticDelta();
  setup.session.beginChatSemanticDeltaEdit();
  setup.session.setChatSemanticDeltaMeaningDraft(
    "ZIP remains the semantic object; ConceptNode remains its storage representation."
  );
  const confirmation = await setup.session.confirmActiveChatSemanticDelta();
  assert.equal(confirmation.ok, true);
  assert.equal(confirmation.delta.confirmation.userEvidence.some((item) =>
    item.sourceKind === "user_edit" &&
    item.snapshot === "ZIP remains the semantic object; ConceptNode remains its storage representation."
  ), true);
  const persisted = inspectConceptMarkdown(setup.fixture.files.get(sourcePath).content).persisted.conceptNode;
  assert.equal(persisted.id, "concept:zip");
  assert.deepEqual(plain(persisted.relationships.map((item) => item.relation)), [
    "related_to", "explicitly_distinct_from"
  ]);
  assert.equal(setup.fixture.files.get(targetPath).content, targetBefore);
  pass("explicit correction persists one distinction edge without merging or modifying the target");
}

// A known ambiguity is resolved exactly; competing concepts are untouched.
{
  const setup = makeSession({ analyzer: async (_key, request) =>
    structuralAnalysis(request, {
      changeKind: "ambiguity_resolved",
      source: "Usage Context",
      target: "Alpha",
      ambiguityLabel: "A"
    })
  });
  const source = createConceptNode({
    id: "concept:usage",
    title: "Usage Context",
    unresolvedItems: [{
      id: "ambiguity:a",
      kind: "interpretation_conflict",
      text: "A",
      alternatives: ["Alpha", "Alternate Alpha"],
      status: "open",
      sourceReferences: ["fixture"]
    }],
    createdAt: "2026-02-04T00:00:00.000Z"
  });
  const selected = createConceptNode({ id: "concept:alpha", title: "Alpha", createdAt: "2026-02-04T00:00:00.000Z" });
  const other = createConceptNode({ id: "concept:other-alpha", title: "Alternate Alpha", createdAt: "2026-02-04T00:00:00.000Z" });
  const sourcePath = seedConcept(setup.fixture, source);
  seedConcept(setup.fixture, selected);
  const otherPath = seedConcept(setup.fixture, other);
  const otherBefore = setup.fixture.files.get(otherPath).content;
  const propagation = makePropagation();
  setup.session.setSemanticPropagationCoordinator(propagation.port);
  setup.session.setDraft("Here A specifically means Alpha.");
  await setup.session.send();
  await setup.session.waitForChatSemanticDelta();
  assert.equal((await setup.session.confirmActiveChatSemanticDelta()).ok, true);
  const persisted = inspectConceptMarkdown(setup.fixture.files.get(sourcePath).content).persisted.conceptNode;
  assert.equal(persisted.unresolvedItems[0].status, "resolved");
  assert.match(persisted.unresolvedItems[0].resolution, /concept:alpha/);
  assert.equal(setup.fixture.files.get(otherPath).content, otherBefore);
  pass("ambiguity confirmation records the selected stable identity and leaves the competing concept untouched");
}

// Missing participants are created only after confirmation; pre-confirmation stays read-only.
{
  const setup = makeSession({ analyzer: async (_key, request) =>
    structuralAnalysis(request, {
      changeKind: "relationship_confirmed",
      source: "Known Source",
      target: "New Target",
      relationType: "part_of"
    })
  });
  const source = createConceptNode({ id: "concept:known-source", title: "Known Source", createdAt: "2026-02-05T00:00:00.000Z" });
  const sourcePath = seedConcept(setup.fixture, source);
  const propagation = makePropagation();
  setup.session.setSemanticPropagationCoordinator(propagation.port);
  setup.session.setDraft("Known Source is part of New Target.");
  await setup.session.send();
  await setup.session.waitForChatSemanticDelta();
  assert.equal(setup.fixture.operations.length, 0);
  assert.equal(setup.session.getActiveChatSemanticDeltaProposal().secondaryTarget.kind, "new_concept");
  assert.equal((await setup.session.confirmActiveChatSemanticDelta()).ok, true);
  assert.equal(setup.fixture.operations.filter((item) => item[0] === "create").length, 1);
  assert.equal(setup.fixture.operations.filter((item) => item[0] === "modify").length, 1);
  const persisted = inspectConceptMarkdown(setup.fixture.files.get(sourcePath).content).persisted.conceptNode;
  assert.equal(persisted.relationships[0].targetLabel, "New Target");
  assert.equal(propagation.calls.at(-1)[0], "enqueue");
  pass("confirmed structural change creates a required new target before one checked origin update");
}

// Partial failure rolls back only the participant created by this confirmation.
{
  const setup = makeSession({ analyzer: async (_key, request) =>
    structuralAnalysis(request, {
      changeKind: "relationship_confirmed",
      source: "Rollback Source",
      target: "Rollback Target",
      relationType: "related_to"
    })
  });
  const source = createConceptNode({ id: "concept:rollback-source", title: "Rollback Source", createdAt: "2026-02-05T01:00:00.000Z" });
  const sourcePath = seedConcept(setup.fixture, source);
  const sourceBefore = setup.fixture.files.get(sourcePath).content;
  setup.fixture.app.vault.modify = async () => {
    throw new Error("simulated checked write failure");
  };
  setup.fixture.app.vault.trash = async (file) => {
    setup.fixture.operations.push(["trash", file.path]);
    setup.fixture.files.delete(file.path);
  };
  const propagation = makePropagation();
  setup.session.setSemanticPropagationCoordinator(propagation.port);
  setup.session.setDraft("Rollback Source is related to Rollback Target.");
  await setup.session.send();
  await setup.session.waitForChatSemanticDelta();
  const result = await setup.session.confirmActiveChatSemanticDelta();
  assert.equal(result.ok, false);
  assert.equal(setup.fixture.files.get(sourcePath).content, sourceBefore);
  assert.equal([...setup.fixture.files.keys()].some((path) => path.includes("Rollback Target")), false);
  assert.equal(setup.fixture.operations.filter((item) => item[0] === "trash").length, 1);
  assert.equal(propagation.calls.filter((call) => call[0] === "failed").length, 1);
  assert.equal(propagation.calls.filter((call) => call[0] === "enqueue").length, 0);
  pass("partial confirmed operation trashes only its newly created participant and never queues propagation");
}

// Ambiguous structural participants require a user selection and preserve stable IDs.
{
  const b1 = createConceptNode({ id: "concept:b1", title: "B One", aliases: ["B"], createdAt: "2026-02-06T00:00:00.000Z" });
  const b2 = createConceptNode({ id: "concept:b2", title: "B Two", aliases: ["B"], createdAt: "2026-02-06T00:00:00.000Z" });
  const a = createConceptNode({ id: "concept:a-amb", title: "A", createdAt: "2026-02-06T00:00:00.000Z" });
  const analysis = structuralAnalysis({ currentUserMessageId: "u", conversation: [{ id: "u", role: "user", content: "A depends on B." }] }, {
    changeKind: "relationship_confirmed", source: "A", target: "B", relationType: "depends_on"
  });
  const result = createChatSemanticDeltaProposal(
    analysis,
    createConceptIndex([a, b1, b2]),
    [a, b1, b2].map((concept) => ({ vaultPath: `${concept.title}.md`, concept })),
    { createdAt: "fixed", createdAtUserTurn: 1 }
  );
  assert.equal(result.proposal.secondaryTarget.kind, "ambiguous_concept");
  const selected = selectChatSemanticDeltaParticipant(result.proposal, "target", "concept:b2");
  assert.equal(selected.secondaryTarget.kind, "known_concept");
  assert.equal(selected.secondaryTarget.conceptId, "concept:b2");
  assert.notEqual(selected.fingerprint, result.proposal.fingerprint);
  assert.equal(
    selectChatSemanticDeltaParticipant(result.proposal, "target", "concept:b2").fingerprint,
    selected.fingerprint
  );
  pass("ambiguous structural target blocks guessing and resolves only through explicit stable-ID selection");
}

// The shared sidebar/large-panel implementation owns one lightweight card;
// this mirrors the repository's existing panel-wiring regression style.
{
  const panelSource = fs.readFileSync("src/LainBrainChatPanel.ts", "utf8");
  assert.match(panelSource, /renderSemanticDeltaProposal\(\)/);
  assert.match(panelSource, /Brain noticed a possible semantic change\./);
  assert.match(panelSource, /text: "Confirm"/);
  assert.match(panelSource, /text: "Edit"/);
  assert.match(panelSource, /text: "Not a change"/);
  assert.match(panelSource, /Select semantic-change concept/);
  assert.match(panelSource, /Relationship removal/);
  assert.match(panelSource, /explicitly distinct from/);
  assert.match(panelSource, /Edit structural relation type/);
  assert.match(panelSource, /selectChatSemanticDeltaSecondaryTarget/);
  assert.match(panelSource, /Based on exact user evidence/);
  assert.match(panelSource, /confirmActiveChatSemanticDelta\(\)/);
  assert.match(panelSource, /rejectActiveChatSemanticDelta\(\)/);
  pass("shared chat panel wires proposal, edit, reject, evidence, and ambiguity controls without raw JSON");
}

// ═════════════════════════════════════════════════════════════════════════
// SCOPED BINDING != DURABLE SEMANTIC DEFINITION
// ═════════════════════════════════════════════════════════════════════════

// Binder statements introduce or constrain a symbol inside a LOCAL
// reasoning scope. They must not produce a durable personal_definition
// proposal. Each form below quotes the exact binder message.

for (const binder of [
  "设 X 为一个未知变量",
  "令 G 为一个群",
  "记 f 为这个映射",
  "假设 n 是偶数",
  "Let x be a group",
  "Let x = 3"
]) {
  const request = analysisRequest([{
    id: "user-1",
    role: "user",
    content: binder
  }]);
  const parsed = parseChatSemanticDeltaAnalysisJson(
    modelProposal({
      conceptQuery: binder.split(/\s+/u)[1],
      proposedMeaning: "binder-introduced meaning",
      messageId: "user-1",
      quote: binder
    }),
    request
  );
  assert.equal(parsed.kind, "no_meaningful_change",
    `binder form must stay scoped: ${JSON.stringify(binder)}`);
}
pass("scoped binder forms never become durable definition proposals");

// Partial quotes that omit the binder word are caught through the
// current-message fallback.
{
  const request = analysisRequest([{
    id: "user-1",
    role: "user",
    content: "设 X 为一个未知变量"
  }]);
  const parsed = parseChatSemanticDeltaAnalysisJson(
    modelProposal({
      conceptQuery: "X",
      proposedMeaning: "unknown variable",
      messageId: "user-1",
      quote: "X 为一个未知变量"
    }),
    request
  );
  assert.equal(parsed.kind, "no_meaningful_change");
  pass("partial binder quote is caught via the current-message fallback");
}

// Compound words containing the binder characters are not binders.
{
  const request = analysisRequest([{
    id: "user-1",
    role: "user",
    content: "我记住 X 是一个变量，设计 Y 为实验代号。"
  }]);
  const parsed = parseChatSemanticDeltaAnalysisJson(
    modelProposal({
      conceptQuery: "X",
      proposedMeaning: "variable",
      messageId: "user-1",
      quote: "我记住 X 是一个变量，设计 Y 为实验代号。"
    }),
    request
  );
  assert.equal(parsed.kind, "possible_principal_change",
    "记住/设计 are compound words, not binders — LLM proposal stands");
  pass("compound words (记住/设计) do not trigger the scoped-binding gate");
}

// Positive controls: durable framing keeps the proposal alive.
for (const durable of [
  "以后我说 X，就是指一个未知变量",
  "对我来说，X 一直表示未知变量"
]) {
  const request = analysisRequest([{
    id: "user-1",
    role: "user",
    content: durable
  }]);
  const parsed = parseChatSemanticDeltaAnalysisJson(
    modelProposal({
      conceptQuery: "X",
      proposedMeaning: "unknown variable",
      messageId: "user-1",
      quote: durable
    }),
    request
  );
  assert.equal(parsed.kind, "possible_principal_change",
    `durable framing must stay durable: ${JSON.stringify(durable)}`);
  assert.equal(parsed.changeKind, "personal_definition");
}
pass("durable personal definitions remain proposal-eligible");

// Mixed message: a scoped binder plus durable framing in one message keeps
// the proposal (the durable clause is the support).
{
  const mixed = "设 X 为一个未知变量。以后我说 X 就是指未知变量。";
  const request = analysisRequest([{
    id: "user-1",
    role: "user",
    content: mixed
  }]);
  const parsed = parseChatSemanticDeltaAnalysisJson(
    modelProposal({
      conceptQuery: "X",
      proposedMeaning: "unknown variable",
      messageId: "user-1",
      quote: mixed
    }),
    request
  );
  assert.equal(parsed.kind, "possible_principal_change");
  pass("durable framing alongside a binder keeps the proposal");
}

// Evidence split across messages: a durable statement elsewhere keeps the
// proposal even when the current message is a binder.
{
  const request = analysisRequest([
    { id: "user-1", role: "user", content: "以后我说 X 就是指未知变量。" },
    { id: "user-2", role: "user", content: "设 X 为一个未知变量" }
  ]);
  const parsed = parseChatSemanticDeltaAnalysisJson(
    JSON.stringify({
      outcome: "possible_principal_change",
      changeKind: "personal_definition",
      conceptQuery: "X",
      proposedMeaning: "unknown variable",
      reason: "durable framing in the earlier message",
      confidence: 0.9,
      explicitness: "explicit",
      tentative: false,
      evidence: [
        { messageId: "user-1", quote: "以后我说 X 就是指未知变量。" },
        { messageId: "user-2", quote: "设 X 为一个未知变量" }
      ]
    }),
    request
  );
  assert.equal(parsed.kind, "possible_principal_change",
    "durable evidence outside the binder message keeps the proposal");
  pass("cross-message durable evidence keeps the proposal");
}

// A binder clause must not suppress an INDEPENDENT personal-semantic
// clause in the same message. "对我来说，X 是某种自由。" is the
// declarative semantic frame current main treats as meaningful
// user-authored semantic content.
{
  const mixed = "设 X 为一个未知变量。对我来说，X 是某种自由。";
  const request = analysisRequest([{
    id: "user-1",
    role: "user",
    content: mixed
  }]);
  const parsed = parseChatSemanticDeltaAnalysisJson(
    modelProposal({
      conceptQuery: "X",
      proposedMeaning: "a kind of freedom for the user",
      messageId: "user-1",
      quote: mixed
    }),
    request
  );
  assert.equal(parsed.kind, "possible_principal_change",
    "mixed binder + personal-semantic message must stay proposal-eligible");
  assert.equal(parsed.changeKind, "personal_definition");
  pass("binder clause does not suppress an independent personal-semantic clause");
}

// English mixed form: the same structure with the English personal frame.
{
  const mixed = "Let x be an unknown variable. For me, x represents freedom.";
  const request = analysisRequest([{
    id: "user-1",
    role: "user",
    content: mixed
  }]);
  const parsed = parseChatSemanticDeltaAnalysisJson(
    modelProposal({
      conceptQuery: "x",
      proposedMeaning: "freedom",
      messageId: "user-1",
      quote: mixed
    }),
    request
  );
  assert.equal(parsed.kind, "possible_principal_change",
    "English mixed binder + personal frame must stay proposal-eligible");
  assert.equal(parsed.changeKind, "personal_definition");
  pass("English mixed binder + personal frame stays proposal-eligible");
}

// Binder-only messages remain suppressed — unchanged conservative behavior.
{
  for (const binder of ["设 X 为一个未知变量", "Let x be an unknown variable"]) {
    const request = analysisRequest([{
      id: "user-1",
      role: "user",
      content: binder
    }]);
    const parsed = parseChatSemanticDeltaAnalysisJson(
      modelProposal({
        conceptQuery: "X",
        proposedMeaning: "unknown variable",
        messageId: "user-1",
        quote: binder
      }),
      request
    );
    assert.equal(parsed.kind, "no_meaningful_change",
      `binder-only message stays suppressed: ${JSON.stringify(binder)}`);
  }
  pass("binder-only messages stay suppressed");
}

// Concept-linked durability: an unrelated marker elsewhere in the message
// is NOT evidence about the proposal's concept. All three negatives bind
// X locally and say nothing durable/personal about X.
{
  for (const message of [
    "设 X 为一个未知变量。这个问题对我来说很难。",
    "设 X 为一个未知变量。这个问题一直很难。",
    "设 X 为一个未知变量。对我来说，Y 是某种自由。"
  ]) {
    const request = analysisRequest([{
      id: "user-1",
      role: "user",
      content: message
    }]);
    const parsed = parseChatSemanticDeltaAnalysisJson(
      modelProposal({
        conceptQuery: "X",
        proposedMeaning: "unknown variable",
        messageId: "user-1",
        quote: message
      }),
      request
    );
    assert.equal(parsed.kind, "no_meaningful_change",
      `unrelated marker must not keep a binder-only X proposal alive: ${JSON.stringify(message)}`);
  }
  pass("markers unrelated to the proposal concept do not keep proposals alive");
}

console.log(`chat-semantic-delta: ${passes} PASS`);
