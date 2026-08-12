import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { LainBrainSession } from './src/LainBrainSession';",
      "export { createSemanticSpec } from './src/SemanticSpec';",
      "export { createChatSemanticAnalysisSystemPrompt, parseChatSemanticAnalysisJson } from './src/ChatSemanticAnalyzer';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "chat-semantic-shadow-entry.ts",
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
          "exports.requestUrl = async () => { throw new Error('Network not expected'); };"
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
let uuid = 0;
vm.runInNewContext(built.outputFiles[0].text, {
  DOMMatrix: class { constructor(){} },
  module,
  exports: module.exports,
  require,
  console,
  URL,
  Blob,
  crypto: { randomUUID: () => `shadow-uuid-${++uuid}` },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  setTimeout,
  clearTimeout
});
const {
  LainBrainSession,
  createSemanticSpec,
  createChatSemanticAnalysisSystemPrompt,
  parseChatSemanticAnalysisJson
} = module.exports;

const vaultWrites = [];
const app = {
  vault: {
    cachedRead: async () => "",
    getMarkdownFiles: () => [],
    getFileByPath: () => null,
    getAbstractFileByPath: () => null,
    getFolderByPath: () => null,
    createFolder: async (path) => vaultWrites.push(["createFolder", path]),
    create: async (path) => vaultWrites.push(["create", path]),
    modify: async (file) => vaultWrites.push(["modify", file.path]),
    trash: async (file) => vaultWrites.push(["trash", file.path])
  },
  metadataCache: { getFirstLinkpathDest: () => null },
  workspace: { getLeaf: () => ({ openFile: async () => {} }) }
};

function sourceRefs(request) {
  return request.userEvidence.map((item, index) => ({
    id: `source-${index}-${item.messageId}`,
    messageId: item.messageId,
    snapshot: item.text
  }));
}

function proposition(request, surface, description, userDefined = false) {
  const refs = sourceRefs(request);
  return createSemanticSpec({
    claimId: request.semanticSessionId,
    sourceRefs: refs,
    symbols: [{
      id: "main-symbol",
      surface,
      role: "proposition",
      description,
      userDefined,
      sourceRefIds: refs.map((ref) => ref.id)
    }],
    expressions: [{ id: "main-expression", kind: "symbol_ref", symbolId: "main-symbol" }],
    statements: [{ id: "main-statement", kind: "assertion", exprId: "main-expression" }],
    ambiguities: []
  });
}

function sessionWith(analyzer) {
  const session = new LainBrainSession(
    app,
    () => "test-key",
    () => null,
    { analyzeImage: async () => { throw new Error("Vision not expected"); } },
    async () => "A normal assistant response."
  );
  session.setChatSemanticAnalyzer(analyzer);
  return session;
}

async function send(session, text) {
  session.setDraft(text);
  assert.equal(await session.send(), "sent");
  await session.waitForChatSemanticShadow();
}

// Adapter contract: strict structured meaning, exact evidence, and no generic
// confirmation policy. This exercises the real parser used by DeepSeek output.
{
  const prompt = createChatSemanticAnalysisSystemPrompt();
  assert.match(prompt, /invisible, provisional semantic hypothesis/);
  assert.match(prompt, /do not answer the user/);
  assert.match(prompt, /do not request accept\/reject confirmation/);
  assert.match(prompt, /merely new, informal, metaphorical, or undefined user term is not blocking/);
  const text = "A梦到B。";
  const parsed = parseChatSemanticAnalysisJson(JSON.stringify({
    description: "A dreams of B",
    symbols: [
      { id: "a", surface: "A", role: "entity", sourceMessageIds: ["message-1"] },
      { id: "b", surface: "B", role: "entity", sourceMessageIds: ["message-1"] },
      { id: "dream", surface: "梦到", role: "relation", userDefined: true, sourceMessageIds: ["message-1"] }
    ],
    expressions: [
      { id: "a-ref", kind: "symbol_ref", symbolId: "a" },
      { id: "b-ref", kind: "symbol_ref", symbolId: "b" },
      { id: "dream-app", kind: "application", operatorSymbolId: "dream", argumentExprIds: ["a-ref", "b-ref"] }
    ],
    statements: [{ id: "dream-assertion", kind: "assertion", exprId: "dream-app" }],
    ambiguities: []
  }), [{ messageId: "message-1", text }], "parse-contract");
  assert.equal(parsed.sourceRefs[0].snapshot, text);
  assert.equal(parsed.symbols.find((item) => item.id === "dream").surface, "梦到");
  assert.equal(parsed.symbols.find((item) => item.id === "dream").userDefined, true);
}

// A — ordinary chat succeeds while H0 is built invisibly.
{
  const session = sessionWith(async (_key, request) =>
    proposition(request, "一个复数加上0还是它自己", "additive identity"));
  await send(session, "一个复数加上0还是它自己。");
  assert.equal(session.getChatTranscriptMessages().at(-1).content, "A normal assistant response.");
  assert.equal(session.getChatSemanticSession().state, "understood");
  assert.equal(session.getChatSemanticDeveloperState().historyCount, 1);
  assert.equal(session.candidateCount, 0);
  assert.equal(JSON.stringify(session.getChatSemanticSession()).includes("UserConclusion"), false);
  assert.equal(JSON.stringify(session.getChatSemanticSession()).toLowerCase().includes("lean"), false);
}

// B — later user evidence revises H0 to H1 with immutable history and no
// accept/reject event.
{
  let analysisCount = 0;
  const session = sessionWith(async (_key, request) => {
    analysisCount += 1;
    const refs = sourceRefs(request);
    return createSemanticSpec({
      claimId: request.semanticSessionId,
      sourceRefs: refs,
      symbols: [{
        id: "plus",
        surface: "+",
        role: "operator",
        description: analysisCount === 1
          ? "ordinary addition"
          : "the operation defined by the user",
        userDefined: analysisCount === 2,
        sourceRefIds: refs.map((ref) => ref.id)
      }],
      expressions: [{ id: "plus-ref", kind: "symbol_ref", symbolId: "plus" }],
      statements: [{ id: "plus-statement", kind: "assertion", exprId: "plus-ref" }],
      ambiguities: []
    });
  });
  await send(session, "一个复数加上0还是它自己。");
  await send(session, "这里的 + 是我自己定义的运算。");
  const shadow = session.getChatSemanticSession();
  assert.equal(shadow.hypothesisHistory.length, 2);
  assert.equal(shadow.hypothesisHistory[0].semanticSpec.symbols[0].description, "ordinary addition");
  assert.equal(shadow.semanticSpec.symbols[0].surface, "+");
  assert.equal(shadow.semanticSpec.symbols[0].description, "the operation defined by the user");
  assert.equal(shadow.semanticSpec.symbols[0].userDefined, true);
  assert.equal(shadow.semanticSpec.reviewStatus, "pending");
  assert.equal(JSON.stringify(shadow).includes("accept"), false);
  assert.equal(JSON.stringify(shadow).includes("reject"), false);
}

// C — the user's linguistic relation survives without graph/Lean side effects.
{
  const session = sessionWith(async (_key, request) => {
    const refs = sourceRefs(request);
    return createSemanticSpec({
      claimId: request.semanticSessionId,
      sourceRefs: refs,
      symbols: [
        { id: "a", surface: "A", role: "entity", sourceRefIds: [refs[0].id] },
        { id: "b", surface: "B", role: "entity", sourceRefIds: [refs[0].id] },
        { id: "dream", surface: "梦到", role: "relation", userDefined: true, sourceRefIds: [refs[0].id] }
      ],
      expressions: [
        { id: "a-ref", kind: "symbol_ref", symbolId: "a" },
        { id: "b-ref", kind: "symbol_ref", symbolId: "b" },
        { id: "dream-app", kind: "application", operatorSymbolId: "dream", argumentExprIds: ["a-ref", "b-ref"] }
      ],
      statements: [{ id: "dream-statement", kind: "assertion", exprId: "dream-app" }],
      ambiguities: []
    });
  });
  await send(session, "A梦到B。");
  const shadow = session.getChatSemanticSession();
  assert.equal(shadow.semanticSpec.symbols.find((item) => item.id === "dream").surface, "梦到");
  assert.equal(session.candidateCount, 0);
  assert.equal(JSON.stringify(shadow).toLowerCase().includes("lean"), false);
}

// D — a coined name remains usable and does not become a blocker merely for
// lacking a standard definition.
{
  const session = sessionWith(async (_key, request) =>
    proposition(request, "无穷物件时间尺度", "user-defined time scale", true));
  await send(session, "我把它叫作无穷物件时间尺度。");
  const shadow = session.getChatSemanticSession();
  assert.equal(shadow.state, "understood");
  assert.equal(shadow.semanticSpec.symbols[0].surface, "无穷物件时间尺度");
  assert.equal(shadow.semanticSpec.symbols[0].userDefined, true);
}

// E — real multi-referent ambiguity exposes a concrete question.
{
  const session = sessionWith(async (_key, request) => {
    const refs = sourceRefs(request);
    return createSemanticSpec({
      claimId: request.semanticSessionId,
      sourceRefs: refs,
      symbols: [{ id: "it", surface: "它", role: "unresolved", sourceRefIds: refs.map((ref) => ref.id) }],
      expressions: [{ id: "it-ref", kind: "symbol_ref", symbolId: "it" }],
      statements: [{ id: "it-statement", kind: "assertion", exprId: "it-ref" }],
      ambiguities: [{
        id: "which-it",
        kind: "reference_target",
        question: "Does 它 refer to the sequence term, partial sum, or limit?",
        affectedIds: ["it"],
        blocking: true,
        choices: [
          { id: "term", label: "the sequence term" },
          { id: "sum", label: "the partial sum" },
          { id: "limit", label: "the limit" }
        ]
      }]
    });
  });
  await send(session, "数列项和部分和都在变化，它最后变成0。");
  const shadow = session.getChatSemanticSession();
  assert.equal(shadow.state, "needs_clarification");
  assert.equal(shadow.semanticSpec.ambiguities[0].question, "Does 它 refer to the sequence term, partial sum, or limit?");
  assert.doesNotMatch(shadow.semanticSpec.ambiguities[0].question, /confirm/i);
}

// F/G — analyzer failure is isolated from the successful reply and creates no
// Candidate, Vault, Lean, conclusion, or evidence artifact.
{
  const writesBefore = vaultWrites.length;
  const session = sessionWith(async () => {
    throw new Error("malformed semantic JSON");
  });
  await send(session, "Keep chatting even if background analysis fails.");
  assert.equal(session.getChatTranscriptMessages().at(-1).content, "A normal assistant response.");
  assert.equal(session.getChatSemanticSession(), undefined);
  assert.equal(session.getChatSemanticFailureCount(), 1);
  assert.equal(session.candidateCount, 0);
  assert.equal(vaultWrites.length, writesBefore);
}

assert.equal(vaultWrites.length, 0);
console.log(JSON.stringify({
  clearChatShadow: "PASS",
  continuousRevision: "PASS",
  customRelation: "PASS",
  customName: "PASS",
  blockingAmbiguity: "PASS",
  failOpen: "PASS",
  userConclusions: 0,
  candidates: 0,
  vaultWrites: 0,
  leanCalls: 0,
  empiricalArtifacts: 0,
  result: "PASS"
}, null, 2));
