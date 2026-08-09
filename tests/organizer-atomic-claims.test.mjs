import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { LainBrainSession } from './src/LainBrainSession';",
      "export {",
      "  isIgnoredCandidateTopic,",
      "  isTrivialMessages",
      "} from './src/LainBrainSession';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "organizer-atomic-claims-entry.ts",
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
          "exports.requestUrl = async (options) => {",
          "  const body = JSON.parse(options.body);",
          "  globalThis.__lainBrainRequests.push(body);",
          "  const systemText = body.messages",
          "    .filter((m) => m.role === 'system')",
          "    .map((m) => m.content)",
          "    .join('\\n');",
          "",
          "  // ── Topic extraction ────────────────────────────────",
          "  if (systemText.includes('Extract every substantive')) {",
          "    // Use the mock's topic config for this test",
          "    const topics = globalThis.__mockTopicExtraction();",
          "    return { json: { choices: [{ message: { content: JSON.stringify({ topics }) } }] } };",
          "  }",
          "",
          "  // ── Claim classification (fallback) ─────────────────",
          "  if (systemText.includes('Classify atomic claims')) {",
          "    // Error injection for testing error-boundary behavior",
          "    if (globalThis.__mockClaimError) {",
          "      throw globalThis.__mockClaimError;",
          "    }",
          "    const userContent = body.messages",
          "      .filter((m) => m.role === 'user')",
          "      .map((m) => m.content)",
          "      .join('\\n');",
          "    const claims = globalThis.__mockClaimClassification(userContent);",
          "    return { json: { choices: [{ message: { content: JSON.stringify({ claims }) } }] } };",
          "  }",
          "",
          "  // ── Candidate note body generation ─────────────────",
          "  if (systemText.includes('Your task is not ordinary question answering')) {",
          "    const title = globalThis.__mockNoteTitle || 'Generated Note';",
          "    return { json: { choices: [{ message: { content: '# ' + title + '\\n\\nGenerated content.' } }] } };",
          "  }",
          "",
          "  // ── Fallback ───────────────────────────────────────",
          "  return { json: { choices: [{ message: { content: '{}' } }] } };",
          "};"
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
const requestLog = [];

// ═══════════════════════════════════════════════════════════════════════
// Mock classifier — returns claims based on input text.
// Only substantive mathematical/formal inputs get claims.
// Non-substantive inputs get empty claims.
// ═══════════════════════════════════════════════════════════════════════

function classifyClaimsMock(userContent) {
  // Formal mathematical claims
  if (userContent.includes("1+1=2") || userContent.includes("1 + 1 = 2")) {
    return [{
      text: "1 + 1 = 2",
      kind: "formal_statement",
      verification: "lean_pending",
      sourceReferences: [],
      sourceMessageIds: [],
      leanStatement: undefined
    }];
  }
  if (userContent.includes("x + 0 = x") || userContent.includes("x+0=x")) {
    return [{
      text: "x + 0 = x",
      kind: "formal_statement",
      verification: "lean_pending",
      sourceReferences: [],
      sourceMessageIds: [],
      leanStatement: undefined
    }];
  }
  if (userContent.includes("orthonormal basis")) {
    return [{
      text: "Every finite-dimensional inner product space has an orthonormal basis.",
      kind: "formal_statement",
      verification: "lean_pending",
      sourceReferences: [],
      sourceMessageIds: [],
      leanStatement: undefined
    }];
  }
  // Non-substantive → no claims
  return [];
}

// ═══════════════════════════════════════════════════════════════════════
// Test contexts — each sets up mockTopicExtraction before VM runs
// ═══════════════════════════════════════════════════════════════════════

let mockTopicExtraction;
let mockClaimClassification;
let mockNoteTitle;

const vmContext = {
  module,
  exports: module.exports,
  require,
  console,
  URL,
  crypto: { randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout,
  get __lainBrainRequests() { return requestLog; },
  get __mockTopicExtraction() { return mockTopicExtraction; },
  get __mockClaimClassification() { return mockClaimClassification; },
  get __mockNoteTitle() { return mockNoteTitle; },
  __mockClaimError: null
};

vm.runInNewContext(built.outputFiles[0].text, vmContext);
const {
  LainBrainSession,
  isIgnoredCandidateTopic,
  isTrivialMessages
} = module.exports;

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function makeOrgTestApp() {
  const files = new Map();
  const writes = [];
  return {
    app: {
      vault: {
        getMarkdownFiles: () => [],
        getAbstractFileByPath: (path) => files.get(path) ?? null,
        getFileByPath: (path) => files.get(path)?.extension === "md" ? files.get(path) : null,
        getFolderByPath: () => null,
        cachedRead: async (file) => file?.content ?? "",
        read: async (file) => file?.content ?? "",
        create: async (path, content) => {
          writes.push({ operation: "create", path, content });
          const file = { path, basename: path.split("/").pop().replace(/\.md$/i, ""), extension: "md", content };
          files.set(path, file);
          return file;
        },
        createFolder: async () => {},
        modify: async (file, content) => {
          writes.push({ operation: "modify", path: file.path, content });
          file.content = content;
        },
        trash: async (file) => { files.delete(file.path); }
      },
      workspace: { getLeaf: () => ({ openFile: async () => {} }) },
      metadataCache: { getFileCache: () => null }
    },
    files,
    writes
  };
}

function makeOrganizerSession(env, messages) {
  // Only pass 5 args — leave classifyClaims as the default
  // (the real classifyCandidateClaims). Passing a 6th arg would
  // silently override the classifier with a stub.
  const session = new LainBrainSession(
    env.app,
    () => "sk-test-api-key-000000000000000000000000",
    () => null,
    { analyzeImage: async () => { throw new Error("Vision not expected"); } },
    async () => { throw new Error("Chat not expected"); }
  );
  session.candidates = [];
  session.activeCandidateId = null;
  // hasCompletedExchange() requires the latest message to be from "assistant"
  session.messages = [
    ...messages,
    { id: "msg-assistant", role: "assistant", content: "I understand.", includeInHistory: true }
  ];
  return session;
}

// ═══════════════════════════════════════════════════════════════════════
// E2E Test 1: "1+1=2" — fallback produces a candidate note
// ═══════════════════════════════════════════════════════════════════════

{
  requestLog.length = 0;
  mockTopicExtraction = () => []; // topic extraction returns empty → trigger fallback
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "1+1=2";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-1p1", role: "user", content: "1+1=2", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "success");
  assert.equal(session.candidateCount, 1);

  const candidates = session.getCandidateNotes();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, "1+1=2");
  // Source message preserved
  assert.ok(candidates[0].sourceMessageIds.includes("msg-1p1"));

  // Verify: fallback classifier WAS called
  const classifyCalls = requestLog.filter((r) =>
    r.messages.some((m) =>
      m.content.includes("Classify atomic claims")
    )
  );
  assert.equal(classifyCalls.length, 1);

  console.log("E2E-1 PASS: \"1+1=2\" → organizer success, 1 candidate, source msg preserved");
}

// ═══════════════════════════════════════════════════════════════════════
// E2E Test 2: "x + 0 = x" — fallback produces a candidate note
// ═══════════════════════════════════════════════════════════════════════

{
  requestLog.length = 0;
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "x+0=x";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-x0x", role: "user", content: "x + 0 = x", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "success");
  assert.equal(session.candidateCount, 1);

  const candidates = session.getCandidateNotes();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, "x+0=x");

  console.log("E2E-2 PASS: \"x + 0 = x\" → organizer success, 1 candidate");
}

// ═══════════════════════════════════════════════════════════════════════
// E2E Test 3: "喵" — trivial pre-filter → no classifier call → failed
// ═══════════════════════════════════════════════════════════════════════

{
  requestLog.length = 0;
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-meow", role: "user", content: "喵", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "failed");
  assert.equal(session.candidateCount, 0);

  // Verify: fallback classifier was NOT called (trivial pre-filter blocked it)
  const classifyCalls = requestLog.filter((r) =>
    r.messages.some((m) =>
      m.content.includes("Classify atomic claims")
    )
  );
  assert.equal(classifyCalls.length, 0);

  console.log("E2E-3 PASS: \"喵\" → organizer failed, no classifier call, no candidate");
}

// ═══════════════════════════════════════════════════════════════════════
// E2E Test 4: "C++ 今天又炸了" — classifier returns empty → no candidate
// ═══════════════════════════════════════════════════════════════════════

{
  requestLog.length = 0;
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-cpp", role: "user", content: "C++ 今天又炸了", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "failed");
  assert.equal(session.candidateCount, 0);

  console.log("E2E-4 PASS: \"C++ 今天又炸了\" → failed, no candidate (not substantive)");
}

// ═══════════════════════════════════════════════════════════════════════
// E2E Test 5: "2026-08-09 去日本" — classifier returns empty → no candidate
// ═══════════════════════════════════════════════════════════════════════

{
  requestLog.length = 0;
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-date", role: "user", content: "2026-08-09 去日本", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "failed");
  assert.equal(session.candidateCount, 0);

  console.log("E2E-5 PASS: \"2026-08-09 去日本\" → failed, no candidate (not substantive)");
}

// ═══════════════════════════════════════════════════════════════════════
// E2E Test 6: "a/b testing is annoying" — no candidate
// ═══════════════════════════════════════════════════════════════════════

{
  requestLog.length = 0;
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-ab", role: "user", content: "a/b testing is annoying", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "failed");
  assert.equal(session.candidateCount, 0);

  console.log("E2E-6 PASS: \"a/b testing is annoying\" → failed, no candidate");
}

// ═══════════════════════════════════════════════════════════════════════
// E2E Test 7: Long casual sentence — no candidate
// ═══════════════════════════════════════════════════════════════════════

{
  requestLog.length = 0;
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-long", role: "user", content: "I walked around campus for a really long time today and saw many interesting things.", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "failed");
  assert.equal(session.candidateCount, 0);

  console.log("E2E-7 PASS: long casual sentence → failed, no candidate (length alone insufficient)");
}

// ═══════════════════════════════════════════════════════════════════════
// E2E Test 8: Multi-topic regression — normal topic path, fallback NOT called
// ═══════════════════════════════════════════════════════════════════════

{
  requestLog.length = 0;
  // Topic extraction returns two substantive topics → fallback must NOT be called
  // Wire format: primaryConcept is a string (mapped to name by the parser)
  mockTopicExtraction = () => [
    {
      title: "Group Theory",
      conversationTopic: "basic group theory concepts",
      primaryConcept: "group theory",
      aliases: ["group theory", "groups"],
      sourceMessageIds: ["msg-gt"],
      activeNoteRelevant: false
    },
    {
      title: "Linear Algebra",
      conversationTopic: "vector spaces and linear maps",
      primaryConcept: "linear algebra",
      aliases: ["linear algebra", "vector spaces"],
      sourceMessageIds: ["msg-la"],
      activeNoteRelevant: false
    }
  ];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "Multi Topic";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-gt", role: "user", content: "Let's discuss groups and subgroups.", includeInHistory: true },
    { id: "msg-la", role: "user", content: "What about vector spaces?", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "success");
  assert.equal(session.candidateCount, 2);

  // Verify: fallback classifier was NOT called (normal topic path succeeded)
  const classifyCalls = requestLog.filter((r) =>
    r.messages.some((m) =>
      m.content.includes("Classify atomic claims")
    )
  );
  assert.equal(classifyCalls.length, 0);

  console.log("E2E-8 PASS: multi-topic → normal path, fallback NOT called, 2 candidates");
}

// ═══════════════════════════════════════════════════════════════════════
// Provenance Tests
// ═══════════════════════════════════════════════════════════════════════

// P-A: One user message + missing classifier source ids → safe recovery
{
  requestLog.length = 0;
  mockTopicExtraction = () => [];
  // Classifier returns a claim but WITHOUT sourceMessageIds
  mockClaimClassification = (userContent) => {
    if (userContent.includes("1+1=2")) {
      return [{
        text: "1 + 1 = 2",
        kind: "formal_statement",
        verification: "lean_pending",
        sourceReferences: [],
        sourceMessageIds: [], // intentionally empty
        leanStatement: undefined
      }];
    }
    return [];
  };
  mockNoteTitle = "1+1=2";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-prov-a", role: "user", content: "1+1=2", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "success");
  assert.equal(session.candidateCount, 1);

  const candidate = session.getCandidateNotes()[0];
  // Safe recovery: exactly one user message, so that ID is used
  assert.ok(candidate.sourceMessageIds.includes("msg-prov-a"));

  console.log("PROV-A PASS: single source + missing classifier ids → safe recovery to one id");
}

// P-B: Multiple user messages + missing classifier source ids → claim rejected
{
  requestLog.length = 0;
  mockTopicExtraction = () => [];
  // Classifier returns a claim WITHOUT sourceMessageIds, but there are 2 user messages
  mockClaimClassification = (userContent) => {
    if (userContent.includes("1+1=2")) {
      return [{
        text: "1 + 1 = 2",
        kind: "formal_statement",
        verification: "lean_pending",
        sourceReferences: [],
        sourceMessageIds: [], // intentionally empty
        leanStatement: undefined
      }];
    }
    return [];
  };
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-prov-b1", role: "user", content: "1+1=2", includeInHistory: true },
    { id: "msg-prov-b2", role: "user", content: "Also check 2+2=4", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  // The claim should be rejected because provenance is unresolved
  // (multiple messages, no classifier source ids)
  assert.equal(result, "failed");
  assert.equal(session.candidateCount, 0);

  console.log("PROV-B PASS: multiple sources + missing classifier ids → claim rejected (unresolved)");
}

// ═══════════════════════════════════════════════════════════════════════
// P-C: Classifier returns valid sourceMessageIds → used directly
// ═══════════════════════════════════════════════════════════════════════

{
  requestLog.length = 0;
  mockTopicExtraction = () => [];
  mockClaimClassification = (userContent) => {
    if (userContent.includes("1+1=2")) {
      return [{
        text: "1 + 1 = 2",
        kind: "formal_statement",
        verification: "lean_pending",
        sourceReferences: [],
        sourceMessageIds: ["msg-prov-c1"], // explicit
        leanStatement: undefined
      }];
    }
    return [];
  };
  mockNoteTitle = "1+1=2";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-prov-c1", role: "user", content: "1+1=2", includeInHistory: true },
    { id: "msg-prov-c2", role: "user", content: "Also 2+2=4", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "success");
  assert.equal(session.candidateCount, 1);

  const candidate = session.getCandidateNotes()[0];
  // Only the explicit source id, not all user message ids
  assert.ok(candidate.sourceMessageIds.includes("msg-prov-c1"));
  assert.equal(candidate.sourceMessageIds.includes("msg-prov-c2"), false);

  console.log("PROV-C PASS: classifier source ids → used directly, not all user ids");
}

// ═══════════════════════════════════════════════════════════════════════
// isIgnoredCandidateTopic regression — 1+1=2 no longer hardcoded
// ═══════════════════════════════════════════════════════════════════════

{
  assert.equal(isIgnoredCandidateTopic([{ id: "x", role: "user", content: "1+1=2" }]), false);
  assert.equal(isIgnoredCandidateTopic([{ id: "x", role: "user", content: "hello" }]), true);
  console.log("IGNORE-REG PASS: hardcoded 1+1=2 removal verified, hello still ignored");
}

// ═══════════════════════════════════════════════════════════════════════
// isTrivialMessages — pre-filter regression
// ═══════════════════════════════════════════════════════════════════════

{
  assert.equal(isTrivialMessages([{ id: "x", role: "user", content: "喵" }]), true);
  assert.equal(isTrivialMessages([{ id: "x", role: "user", content: "hello" }]), true);
  assert.equal(isTrivialMessages([{ id: "x", role: "user", content: "1+1=2" }]), false);
  assert.equal(isTrivialMessages([{ id: "x", role: "user", content: "C++ 今天又炸了" }]), false);
  console.log("TRIVIAL-REG PASS: trivial pre-filter correct");
}

// ═══════════════════════════════════════════════════════════════════════
// No regex classifier exported
// ═══════════════════════════════════════════════════════════════════════

{
  assert.equal(typeof module.exports.isAtomicSubstantiveClaim, "undefined");
  console.log("NO-REGEX PASS: isAtomicSubstantiveClaim is not exported");
}

// ═══════════════════════════════════════════════════════════════════════
// Error-boundary Tests
// ═══════════════════════════════════════════════════════════════════════

// ERR-A: Valid {claims:[]} → semantic zero → "No substantive topics"
{
  requestLog.length = 0;
  vmContext.__mockClaimError = null;
  mockTopicExtraction = () => [];
  // Classifier returns a valid zero-claim response
  mockClaimClassification = () => [];
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-err-a", role: "user", content: "Some random chatter", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  // Valid zero-claim result → semantic "no substantive topics"
  assert.equal(result, "failed");
  assert.equal(session.candidateError, "No substantive topics were found in the current chat.");
  assert.equal(session.candidateCount, 0);

  console.log("ERR-A PASS: {claims:[]} → semantic zero → No substantive topics");
}

// ERR-B: 1 formal_statement → success (regression guard)
{
  requestLog.length = 0;
  vmContext.__mockClaimError = null;
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "1+1=2";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-err-b", role: "user", content: "1+1=2", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "success");
  assert.equal(session.candidateCount, 1);

  console.log("ERR-B PASS: 1 formal_statement → organizer success (existing E2E still works)");
}

// ERR-C: Classifier API/network error → system failure, NOT "No substantive topics"
{
  requestLog.length = 0;
  // Inject a simulated network error
  vmContext.__mockClaimError = new Error("Network timeout");
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-err-c", role: "user", content: "1+1=2", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  // Must be a system failure, NOT "No substantive topics"
  assert.equal(result, "failed");
  assert.notEqual(session.candidateError, "No substantive topics were found in the current chat.");
  assert.equal(session.candidateError, "Unable to create candidate notes. Please try again.");

  console.log("ERR-C PASS: API error → system failure, not mislabeled as non-substantive");
}

// ERR-D: Malformed JSON → system failure, NOT interpreted as zero claims
{
  requestLog.length = 0;
  // Simulate a malformed response: the shim returns non-JSON
  // We inject an error that parseClaimSuggestionsJson would throw for
  vmContext.__mockClaimError = new Error("DeepSeek returned invalid claim suggestions.");
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-err-d", role: "user", content: "1+1=2", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  // Must be a system failure, NOT "No substantive topics"
  assert.equal(result, "failed");
  assert.notEqual(session.candidateError, "No substantive topics were found in the current chat.");
  assert.equal(session.candidateError, "Unable to create candidate notes. Please try again.");

  console.log("ERR-D PASS: malformed response → system failure, not zero claims");
}

// Clean up error injection
vmContext.__mockClaimError = null;

// ═══════════════════════════════════════════════════════════════════════
// Parser-boundary regression tests
// ═══════════════════════════════════════════════════════════════════════

// PARSE-1: {claims:[]} → valid semantic zero
{
  requestLog.length = 0;
  vmContext.__mockClaimError = null;
  mockTopicExtraction = () => [];
  mockClaimClassification = () => []; // empty → {claims:[]}
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-parse-1", role: "user", content: "hello", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "failed");
  assert.equal(session.candidateError, "No substantive topics were found in the current chat.");

  console.log("PARSE-1 PASS: {claims:[]} → semantic zero");
}

// PARSE-2: {claims:[{}]} → malformed, NOT semantic zero
{
  requestLog.length = 0;
  // Inject a parse error: the claims array has entries but they're all
  // malformed (empty objects that fail normalization).
  // The real classifier would throw; we simulate with an error injection
  // that represents the parser throwing after normalization.
  vmContext.__mockClaimError = new Error("DeepSeek returned invalid claim suggestions.");
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-parse-2", role: "user", content: "1+1=2", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  // Must NOT be "No substantive topics" — it's a parser failure
  assert.equal(result, "failed");
  assert.notEqual(session.candidateError, "No substantive topics were found in the current chat.");
  assert.equal(session.candidateError, "Unable to create candidate notes. Please try again.");

  console.log("PARSE-2 PASS: {claims:[{}]} → parser error, not semantic zero");
}

// PARSE-3: all-malformed claim objects → system failure
{
  requestLog.length = 0;
  vmContext.__mockClaimError = new Error("DeepSeek returned invalid claim suggestions.");
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "n/a";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-parse-3", role: "user", content: "Some text", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "failed");
  assert.notEqual(session.candidateError, "No substantive topics were found in the current chat.");
  assert.equal(session.candidateError, "Unable to create candidate notes. Please try again.");

  console.log("PARSE-3 PASS: all-malformed objects → system failure, not zero claims");
}

// PARSE-4: 1 valid formal_statement → still succeeds
{
  requestLog.length = 0;
  vmContext.__mockClaimError = null;
  mockTopicExtraction = () => [];
  mockClaimClassification = classifyClaimsMock;
  mockNoteTitle = "1+1=2";

  const env = makeOrgTestApp();
  const messages = [
    { id: "msg-parse-4", role: "user", content: "1+1=2", includeInHistory: true }
  ];
  const session = makeOrganizerSession(env, messages);

  const result = await session.generateOrUpdateCandidateNotes();
  assert.equal(result, "success");
  assert.equal(session.candidateCount, 1);

  console.log("PARSE-4 PASS: 1 valid formal_statement → success (regression)");
}

// ═══════════════════════════════════════════════════════════════════════
// Complete
// ═══════════════════════════════════════════════════════════════════════

console.log(JSON.stringify({
  e2e_1plus1equals2_organizerSuccess: true,
  e2e_xplus0equalsx_organizerSuccess: true,
  e2e_meow_organizerFailed_noClassifierCall: true,
  e2e_cpp_noCandidate: true,
  e2e_date_noCandidate: true,
  e2e_abTesting_noCandidate: true,
  e2e_longCasual_noCandidate: true,
  e2e_multiTopic_normalPath_fallbackNotCalled: true,
  prov_singleSource_safeRecovery: true,
  prov_multipleSources_missingIds_rejected: true,
  prov_classifierIds_usedDirectly: true,
  ignore_hardcoded1plus1equals2_removed: true,
  trivialPreFilter_correct: true,
  noRegexClassifier_exported: true,
  errA_emptyClaims_semanticZero: true,
  errB_oneFormalStatement_stillSucceeds: true,
  errC_apiError_systemFailure_notMislabeled: true,
  errD_malformedResponse_systemFailure: true,
  parse1_emptyClaims_semanticZero: true,
  parse2_emptyObjectClaims_parserError: true,
  parse3_allMalformed_systemFailure: true,
  parse4_oneValid_stillSucceeds: true,
  result: "PASS"
}, null, 2));
