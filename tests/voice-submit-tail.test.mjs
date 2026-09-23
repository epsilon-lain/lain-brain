import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export { analyzeVoiceSubmitTail } from "./src/VoiceSubmitTail";
      export { LainBrainSession } from "./src/LainBrainSession";
    `,
    resolveDir: process.cwd(),
    sourcefile: "voice-submit-tail-entry.ts",
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
          exports.requestUrl = async () => { throw new Error("Unexpected DeepSeek request"); };
        `
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
  URL,
  URLSearchParams,
  DOMMatrix: DOMMatrixStub,
  crypto: { randomUUID: () => "voice-submit-tail" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  console: {
    log: (...values) => capturedLogs.push(values.join(" ")),
    warn: (...values) => capturedLogs.push(values.join(" ")),
    error: (...values) => capturedLogs.push(values.join(" "))
  },
  setTimeout,
  clearTimeout
});

const { analyzeVoiceSubmitTail, LainBrainSession } = module.exports;

function makeApp() {
  return {
    vault: {
      cachedRead: async () => "",
      getMarkdownFiles: () => [],
      getFileByPath: () => null,
      getAbstractFileByPath: () => null
    },
    metadataCache: { getFirstLinkpathDest: () => null },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) }
  };
}

function makeSession(askText) {
  const session = new LainBrainSession(
    makeApp(),
    () => "deepseek-key",
    () => null,
    undefined,
    askText,
    undefined,
    undefined,
    async () => ({ ok: false, error: "unused" })
  );
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  return session;
}

// Pure tail analysis: exact ka, punctuation suffix, middle ka, and similar cut.
assert.equal(analyzeVoiceSubmitTail("1+1 等于多少 ka").kind, "exact");
assert.equal(analyzeVoiceSubmitTail("1+1 等于多少 ka").body, "1+1 等于多少");
assert.equal(analyzeVoiceSubmitTail("1+1 等于多少 ka！").kind, "exact");
assert.equal(analyzeVoiceSubmitTail("ka 在中间").kind, "none");
assert.equal(analyzeVoiceSubmitTail("kafka").kind, "none");
assert.equal(analyzeVoiceSubmitTail("Cut. Cut.").kind, "uncertain");
assert.equal(analyzeVoiceSubmitTail("Cut. Cut.").candidate, "Cut");
assert.equal(analyzeVoiceSubmitTail("1+1 等于多少 cut").kind, "uncertain");
assert.equal(analyzeVoiceSubmitTail("1+1 等于多少 cut").body, "1+1 等于多少");

// Uncertain transcript is held for explicit review, never appended or submitted.
{
  let askCalls = 0;
  const session = makeSession(async () => {
    askCalls += 1;
    return "answer";
  });
  const outcome = session.ingestFinalizedVoiceTurn(
    "1+1 等于多少 cut",
    "2026-01-01T00:00:00.000Z",
    "voice:cut-1"
  );
  assert.equal(outcome.kind, "review");
  assert.equal(session.getVoiceSubmitReview().candidate, "cut");
  assert.equal(session.getVoiceSubmitReview().body, "1+1 等于多少");
  assert.equal(session.getChatSpace().length, 0);
  assert.equal(askCalls, 0);
}

// "是 ka" submits body without the tail; "保留原文" keeps the full text.
{
  let askCalls = 0;
  const submitSession = makeSession(async () => {
    askCalls += 1;
    return "answer";
  });
  submitSession.ingestFinalizedVoiceTurn(
    "1+1 等于多少 cut",
    "2026-01-01T00:00:00.000Z",
    "voice:cut-submit"
  );
  assert.equal(submitSession.resolveVoiceSubmitReview("submit"), true);
  await submitSession.submitChatSpace();
  assert.equal(askCalls, 1);
  assert.equal(
    submitSession.getChatTranscriptMessages()
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n"),
    "1+1 等于多少"
  );

  const keepSession = makeSession(async () => {
    throw new Error("must not send");
  });
  keepSession.ingestFinalizedVoiceTurn(
    "1+1 等于多少 cut",
    "2026-01-01T00:00:00.000Z",
    "voice:cut-keep"
  );
  assert.equal(keepSession.resolveVoiceSubmitReview("keep"), true);
  assert.deepEqual(
    [...keepSession.getChatSpace().map((segment) => segment.text)],
    ["1+1 等于多少 cut"]
  );
  assert.equal(
    keepSession.getChatTranscriptMessages().filter(
      (message) => message.role === "user"
    ).length,
    0
  );
}

// Discard clears the review without mutating Chat Space.
{
  const session = makeSession(async () => "answer");
  session.ingestFinalizedVoiceTurn(
    "1+1 等于多少 cut",
    "2026-01-01T00:00:00.000Z",
    "voice:cut-discard"
  );
  assert.equal(session.resolveVoiceSubmitReview("discard"), true);
  assert.equal(session.getVoiceSubmitReview(), undefined);
  assert.equal(session.getChatSpace().length, 0);
}

// Duplicate finalized turn keeps exactly one pending review.
{
  const session = makeSession(async () => "answer");
  const first = session.ingestFinalizedVoiceTurn(
    "1+1 等于多少 cut",
    "2026-01-01T00:00:00.000Z",
    "voice:cut-dup"
  );
  const duplicate = session.ingestFinalizedVoiceTurn(
    "1+1 等于多少 cut",
    "2026-01-01T00:00:01.000Z",
    "voice:cut-dup"
  );
  assert.equal(first.kind, "review");
  assert.equal(duplicate.kind, "ignored");
  assert.equal(session.getVoiceSubmitReview().candidate, "cut");
}

// A failed submit keeps the confirmed body and a retry adds one user message.
{
  let askCalls = 0;
  const session = makeSession(async () => {
    askCalls += 1;
    if (askCalls === 1) throw new Error("provider down");
    return "answer";
  });
  session.ingestFinalizedVoiceTurn(
    "1+1 等于多少 cut",
    "2026-01-01T00:00:00.000Z",
    "voice:cut-retry"
  );
  assert.equal(session.resolveVoiceSubmitReview("submit"), true);
  assert.equal(await session.submitChatSpace(), "failed");
  assert.deepEqual(
    [...session.getChatSpace().map((segment) => segment.text)],
    ["1+1 等于多少"]
  );
  assert.equal(await session.submitChatSpace(), "sent");
  assert.equal(askCalls, 2);
  assert.deepEqual(
    [
      ...session.getChatTranscriptMessages()
        .filter((message) => message.role === "user")
        .map((message) => message.content)
    ],
    ["1+1 等于多少"]
  );
}

// Exact trailing ka submits once and never includes the submit word.
{
  let askCalls = 0;
  const session = makeSession(async () => {
    askCalls += 1;
    return "answer";
  });
  const outcome = session.ingestFinalizedVoiceTurn(
    "1+1 等于多少，ka！",
    "2026-01-01T00:00:00.000Z",
    "voice:ka-1"
  );
  assert.equal(outcome.kind, "executed");
  await session.submitChatSpace();
  assert.equal(askCalls, 1);
  const userTexts = session.getChatTranscriptMessages()
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  assert.equal(userTexts, "1+1 等于多少");
  assert.equal(userTexts.includes("ka"), false);

  const duplicate = session.ingestFinalizedVoiceTurn(
    "1+1 等于多少，ka！",
    "2026-01-01T00:00:01.000Z",
    "voice:ka-1"
  );
  assert.equal(duplicate.kind, "ignored");
  assert.equal(askCalls, 1);
}

console.log("voice-submit-tail: ok");
