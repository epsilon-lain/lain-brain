import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export { LainBrainSession } from "./src/LainBrainSession";
    `,
    resolveDir: process.cwd(),
    sourcefile: "assemblyai-chat-space-session-entry.ts",
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
  crypto: { randomUUID: () => "assemblyai-test" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  console: {
    log: (...values) => capturedLogs.push(values.join(" ")),
    warn: (...values) => capturedLogs.push(values.join(" ")),
    error: (...values) => capturedLogs.push(values.join(" "))
  },
  setTimeout,
  clearTimeout
});

const { LainBrainSession } = module.exports;

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
    askText
  );
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  return session;
}

// Scenario 1: a single trailing ka turn submits once and strips the keyword.
{
  let askCalls = 0;
  const session = makeSession(async () => {
    askCalls += 1;
    return "answer";
  });
  const first = session.ingestFinalizedVoiceTurn(
    "1+1 等于多少，ka！",
    "2026-01-01T00:00:00.000Z",
    "session-a:1"
  );
  assert.equal(first.kind, "executed");
  await session.submitChatSpace();
  assert.equal(askCalls, 1);

  const userTexts = session.getChatTranscriptMessages()
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  assert.equal(userTexts, "1+1 等于多少");
  assert.equal(userTexts.includes("ka"), false);
  assert.equal(session.getChatSpace().length, 0);

  const duplicate = session.ingestFinalizedVoiceTurn(
    "1+1 等于多少，ka！",
    "2026-01-01T00:00:01.000Z",
    "session-a:1"
  );
  assert.equal(duplicate.kind, "ignored");
  assert.equal(askCalls, 1);
}

// Scenario 2: duplicate Enter shares the in-flight submission.
{
  let askCalls = 0;
  const session = makeSession(async () => {
    askCalls += 1;
    return "answer";
  });
  session.appendKeyboardChatSpaceText("hello");
  const first = session.submitChatSpace();
  const second = session.submitChatSpace();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(askCalls, 1);
  assert.equal(session.getChatSpace().length, 0);
}

// Scenario 3: new paragraphs added while the provider is waiting survive.
{
  let resolveAsk;
  let askCalls = 0;
  const session = makeSession(() => {
    askCalls += 1;
    return new Promise((resolve) => { resolveAsk = resolve; });
  });
  session.appendKeyboardChatSpaceText("original");
  const pending = session.submitChatSpace();
  session.appendKeyboardChatSpaceText("new while provider is waiting");
  while (resolveAsk === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  resolveAsk("answer");
  assert.equal(await pending, "sent");
  assert.deepEqual(
    [...session.getChatSpace().map((segment) => segment.text)],
    ["new while provider is waiting"]
  );
  assert.equal(askCalls, 1);
}

// Scenario 4: a failed send keeps Chat Space and a retry adds one user message.
{
  let askCalls = 0;
  const session = makeSession(async () => {
    askCalls += 1;
    if (askCalls === 1) throw new Error("provider down");
    return "answer";
  });
  session.appendKeyboardChatSpaceText("retry me");
  assert.equal(await session.submitChatSpace(), "failed");
  assert.equal(session.getChatSpace().map((segment) => segment.text).join("\n"), "retry me");
  assert.equal(
    session.getChatTranscriptMessages().filter((message) => message.role === "user").length,
    0
  );

  assert.equal(await session.submitChatSpace(), "sent");
  assert.equal(askCalls, 2);
  assert.equal(session.getChatSpace().length, 0);
  const retryUsers = session.getChatTranscriptMessages()
    .filter((message) => message.role === "user")
    .map((message) => message.content);
  assert.deepEqual([...retryUsers], ["retry me"]);
}

console.log("assemblyai-chat-space-session: ok");
