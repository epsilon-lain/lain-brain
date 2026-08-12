import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { LainBrainSession } from './src/LainBrainSession';",
      "export { createSemanticSpec } from './src/SemanticSpec';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "chat-semantic-concurrency-entry.ts",
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
          "exports.requestUrl = async () => {",
          "  return { json: { choices: [{ message: { content: 'Ok.' } }] } };",
          "};"
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
const capturedLogs = [];
class DOMMatrixStub { constructor(_init) { /* no-op */ } }
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  DOMMatrix: DOMMatrixStub,
  console: {
    log: (...args) => { capturedLogs.push(args); },
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {}
  },
  URL,
  crypto: {
    randomUUID: () =>
      "test-csc-" + Math.random().toString(36).slice(2, 8)
  },
  setTimeout,
  clearTimeout,
  prompt: () => ""
});

const { LainBrainSession, createSemanticSpec } = module.exports;

function makeApp() {
  return {
    vault: {
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null,
      getFileByPath: () => null,
      getFolderByPath: () => null,
      cachedRead: async () => "",
      read: async () => ""
    },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) },
    metadataCache: { getFileCache: () => null }
  };
}

function makeSession({
  askTextOverride,
  apiKey = "sk-test-key-12345"
} = {}) {
  const app = makeApp();
  const session = new LainBrainSession(
    app,
    () => apiKey,
    () => null,
    { analyzeImage: async () => { throw new Error("Vision not expected"); } },
    askTextOverride ?? (async () => "A natural reply."),
    async () => { throw new Error("Claim classification unexpected"); },
    async () => { throw new Error("Lean generation unexpected"); }
  );
  return session;
}

function resetSemanticState(session) {
  session.messages = [{
    id: "message-1",
    role: "user",
    content: "Initial message.",
    includeInHistory: true
  }, {
    id: "message-2",
    role: "assistant",
    content: "Initial reply.",
    includeInHistory: true
  }];
  session.generalDraft = "";
  session.loadingMode = null;
}

function makeUserMessage(id, content) {
  return {
    id, role: "user", content, includeInHistory: true,
    providerId: "deepseek", providerDisplayName: "DeepSeek"
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TEST B: Semantic already running is safe — foreground completes anyway.
// In-flight semantic overlap is acknowledged as a rare edge case.
// ═══════════════════════════════════════════════════════════════════════

{
  capturedLogs.length = 0;

  let foregroundCompleted = false;
  const session = makeSession({
    askTextOverride: async () => {
      foregroundCompleted = true;
      return "Foreground reply.";
    }
  });

  let semanticResolve;
  const semanticDeferred = new Promise((resolve) => {
    semanticResolve = resolve;
  });

  let semanticStarted = false;
  let semanticCompleted = false;
  session.setChatSemanticAnalyzer(async () => {
    semanticStarted = true;
    await semanticDeferred;
    semanticCompleted = true;
    return null;
  });

  session.messages = [
    makeUserMessage("msg-b-1", "Message B."),
    { id: "msg-b-2", role: "assistant", content: "Reply.", includeInHistory: true,
      providerId: "deepseek", providerDisplayName: "DeepSeek" }
  ];

  // Start semantic (foreground is NOT active, so it proceeds)
  session.enqueueChatSemanticAnalysis(
    "sk-test",
    makeUserMessage("msg-b-1", "Message B."),
    "Reply."
  );

  // Wait for semantic to start (it'll be awaiting semanticDeferred)
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(semanticStarted, true, "Semantic must have started");

  // Start foreground while semantic is still in-flight (rare overlap)
  session.generalDraft = "Foreground message.";
  const result = await session.send();
  assert.equal(result, "sent");
  assert.equal(foregroundCompleted, true,
    "Foreground must complete even while semantic is running");

  // Resolve semantic
  semanticResolve();
  await session.waitForChatSemanticShadow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(semanticCompleted, true,
    "Semantic must eventually complete");

  console.log("TEST-B PASS: in-flight semantic overlap is safe, foreground always wins");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST C: Semantic 429 / 5xx / network failure is fail-open.
// Diagnostics classify the error correctly.
// ═══════════════════════════════════════════════════════════════════════

{
  capturedLogs.length = 0;

  let foregroundCalls = 0;
  const session = makeSession({
    askTextOverride: async () => {
      foregroundCalls += 1;
      return `Foreground reply ${foregroundCalls}.`;
    }
  });

  const errors = [
    new Error("Request failed with status code 429"),
    new Error("502 Bad Gateway — server error"),
    new Error("ETIMEDOUT — connection timed out"),
  ];

  let semanticAttempts = 0;
  session.setChatSemanticAnalyzer(async () => {
    semanticAttempts += 1;
    throw errors[semanticAttempts - 1] ?? new Error("unknown");
  });

  session.messages = [
    makeUserMessage("msg-c-1", "Message C."),
    { id: "msg-c-2", role: "assistant", content: "Ok.", includeInHistory: true,
      providerId: "deepseek", providerDisplayName: "DeepSeek" }
  ];

  // 429
  session.enqueueChatSemanticAnalysis(
    "sk-test", makeUserMessage("msg-c-1", "Message C."), "Ok."
  );
  await session.waitForChatSemanticShadow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.getChatSemanticFailureCount(), 1);
  assert.equal(semanticAttempts, 1);

  // Check diagnostic classification via captured console.log
  const diag429 = JSON.parse(capturedLogs[capturedLogs.length - 1][0]);
  assert.equal(diag429.code, "rate_limited");
  assert.equal(diag429.status, 429);

  // 502
  session.enqueueChatSemanticAnalysis(
    "sk-test", makeUserMessage("msg-c-1", "Message C."), "Ok."
  );
  await session.waitForChatSemanticShadow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.getChatSemanticFailureCount(), 2);

  // ETIMEDOUT
  session.enqueueChatSemanticAnalysis(
    "sk-test", makeUserMessage("msg-c-1", "Message C."), "Ok."
  );
  await session.waitForChatSemanticShadow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.getChatSemanticFailureCount(), 3);

  // Foreground must work fine after all semantic failures
  session.generalDraft = "Does foreground still work?";
  const result = await session.send();
  assert.equal(result, "sent");
  assert.equal(foregroundCalls, 1,
    "Foreground must work perfectly after semantic failures");
  assert.equal(session.getChatSemanticFailureCount(), 3,
    "Foreground success does not reset semantic failure count");

  console.log("TEST-C PASS: semantic failures are fail-open, codes classified correctly");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST D: Foreground failure captures classified diagnostic + friendly UI
// ═══════════════════════════════════════════════════════════════════════

{
  capturedLogs.length = 0;

  let foregroundAttempt = 0;
  const session = makeSession({
    askTextOverride: async () => {
      foregroundAttempt += 1;
      if (foregroundAttempt === 1) {
        throw new Error("Request failed with status code 429");
      }
      if (foregroundAttempt === 2) {
        throw new Error("503 Service Unavailable");
      }
      return "Finally worked.";
    }
  });

  resetSemanticState(session);

  // Attempt 1 — 429
  session.generalDraft = "Test message D1.";
  await session.send();
  let error = session.getLastDeepSeekError();
  assert.equal(error.code, "rate_limited");
  assert.equal(error.status, 429);
  assert.ok(error.message.includes("429"));
  assert.equal(error.message.includes("sk-test"), false,
    "Sanitized error must not leak configured API key");

  // Verify user sees friendly message, not raw diagnostic
  const lastAssistant = session.messages[session.messages.length - 1];
  assert.equal(lastAssistant.content,
    "Unable to get an answer from DeepSeek. Please try again.");
  assert.equal(lastAssistant.includeInHistory, false);

  // Attempt 2 — 503
  session.generalDraft = "Test message D2.";
  await session.send();
  const error2 = session.getLastDeepSeekError();
  assert.equal(error2.code, "server_error");

  console.log("TEST-D PASS: diagnostic classified, friendly UI preserved");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST E: Error containing literal Bearer/API-key material is redacted
// ═══════════════════════════════════════════════════════════════════════

{
  capturedLogs.length = 0;
  const SECRET_KEY = "sk-super-secret-test-key-do-not-leak";

  const session = makeSession({
    askTextOverride: async () => {
      throw new Error(
        "Auth failure: Bearer " + SECRET_KEY +
        " rejected; Authorization: " + SECRET_KEY +
        " is invalid. The key " + SECRET_KEY + " was used."
      );
    },
    apiKey: SECRET_KEY
  });
  resetSemanticState(session);
  session.generalDraft = "Leak test.";
  await session.send();

  const error = session.getLastDeepSeekError();
  assert.ok(error !== null, "Error must be captured");

  // The stored message must NOT contain the raw secret
  assert.equal(error.message.includes(SECRET_KEY), false,
    "Configured API key must be redacted from stored diagnostic");
  assert.equal(error.message.includes("Bearer "), false,
    "Bearer token must be redacted (the word Bearer itself is removed)");
  assert.equal(error.message.includes("Authorization:"), false,
    "Authorization header value must be redacted");

  // Verify the redacted markers are present
  assert.ok(error.message.includes("[redacted"),
    "Redacted markers must be present in sanitized message");

  // The console log also must NOT contain the secret
  const logEntry = JSON.parse(capturedLogs[capturedLogs.length - 1][0]);
  assert.equal(JSON.stringify(logEntry).includes(SECRET_KEY), false,
    "Console diagnostic must NOT contain the secret");
  assert.equal(JSON.stringify(logEntry).includes("Bearer "), false,
    "Console diagnostic must NOT contain Bearer token");

  console.log("TEST-E PASS: Bearer/API-key material is redacted before storage and logging");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST F: Foreground error still gives friendly UI fallback
// (separate from diagnostic path)
// ═══════════════════════════════════════════════════════════════════════

{
  capturedLogs.length = 0;

  const session = makeSession({
    askTextOverride: async () => {
      throw new Error("Some internal failure");
    }
  });
  resetSemanticState(session);
  session.generalDraft = "Crash test.";
  await session.send();

  // Diagnostic was captured
  const error = session.getLastDeepSeekError();
  assert.ok(error !== null);
  assert.equal(error.code, "unknown");

  // User-facing message is friendly — never exposes raw diagnostic
  const lastAssistant = session.messages[session.messages.length - 1];
  assert.equal(
    lastAssistant.content,
    "Unable to get an answer from DeepSeek. Please try again."
  );
  assert.equal(lastAssistant.includeInHistory, false);

  console.log("TEST-F PASS: foreground failure gives friendly UI fallback");
}

console.log(JSON.stringify({
  inFlightSemanticOverlapAcknowledged: true,
  semanticFailuresFailOpen: true,
  diagnosticCodesClassified: true,
  bearerAndApiKeyRedacted: true,
  friendlyUiFallbackPreserved: true,
  result: "PASS"
}, null, 2));
