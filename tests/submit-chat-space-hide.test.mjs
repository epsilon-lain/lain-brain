import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: {
    contents: `export { LainBrainSession } from "./src/LainBrainSession";`,
    resolveDir: process.cwd(),
    sourcefile: "submit-chat-space-hide-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian", namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: `exports.requestUrl = async () => { throw Error("unexpected network"); };`
      }));
    }
  }]
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports, require: createRequire(import.meta.url),
  URL, URLSearchParams,
  DOMMatrix: class {}, crypto: { randomUUID: () => "submit-hide" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  setTimeout, clearTimeout, console
});
const { LainBrainSession } = module.exports;

function makeApp() {
  return {
    vault: { cachedRead: async () => "", getMarkdownFiles: () => [],
      getFileByPath: () => null, getAbstractFileByPath: () => null },
    metadataCache: { getFirstLinkpathDest: () => null },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) }
  };
}

function makeSession(askText) {
  const session = new LainBrainSession(makeApp(), () => "deepseek-key",
    () => null, undefined, askText);
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  return session;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}

// ── Success: submitted segments hide during Thinking, new segment visible ──
{
  const requests = [];
  let resolveAsk;
  const session = makeSession((...args) => {
    requests.push(args);
    return new Promise((resolve) => { resolveAsk = resolve; });
  });
  session.appendKeyboardChatSpaceText("A");
  session.appendKeyboardChatSpaceText("B");
  const pending = session.submitChatSpace();

  await waitFor(() => requests.length === 1);
  // During "Thinking…" the submitted paragraphs are hidden and shown once.
  assert.equal(session.getChatSpace().length, 0);
  const userMessages = session.getChatTranscriptMessages()
    .filter((message) => message.role === "user");
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0].content, "A\nB");

  // A segment typed during the send remains visible.
  session.appendKeyboardChatSpaceText("C");
  assert.deepEqual([...session.getChatSpace().map((s) => s.text)], ["C"]);

  resolveAsk("answer");
  assert.equal(await pending, "sent");
  assert.deepEqual([...session.getChatSpace().map((s) => s.text)], ["C"]);
  assert.equal(
    session.getChatTranscriptMessages()
      .filter((message) => message.role === "user").length,
    1
  );
}

// ── Failure: original paragraphs are restored for retry, new segment kept ──
{
  const requests = [];
  let rejectAsk;
  const session = makeSession((...args) => {
    requests.push(args);
    return new Promise((_, reject) => { rejectAsk = reject; });
  });
  session.appendKeyboardChatSpaceText("A");
  session.appendKeyboardChatSpaceText("B");
  const pending = session.submitChatSpace();

  await waitFor(() => requests.length === 1);
  assert.equal(session.getChatSpace().length, 0);
  session.appendKeyboardChatSpaceText("C");

  rejectAsk(new Error("provider down"));
  assert.equal(await pending, "failed");
  assert.deepEqual(
    [...session.getChatSpace().map((s) => s.text)],
    ["A", "B", "C"]
  );
  assert.equal(
    session.getChatTranscriptMessages()
      .filter((message) => message.role === "user").length,
    0
  );
}

console.log("submit-chat-space-hide: ok");
