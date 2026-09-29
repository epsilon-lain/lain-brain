import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: {
    contents: `export { LainBrainSession } from "./src/LainBrainSession";
               export { buildChatTranscriptOrder } from "./src/ChatTranscriptOrder";`,
    resolveDir: process.cwd(),
    sourcefile: "chat-transcript-order-entry.ts",
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
  DOMMatrix: class {}, crypto: { randomUUID: () => "chat-order" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  setTimeout, clearTimeout, console
});
const { LainBrainSession, buildChatTranscriptOrder } = module.exports;

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

// Renders item order exactly like LainBrainChatPanel.render(): it iterates
// buildChatTranscriptOrder(...) and appends one DOM node per item in order.
function renderItemOrder(session) {
  return Array.from(
    buildChatTranscriptOrder(
      session.getChatTranscriptMessages(),
      session.getChatSpace(),
      session.loadingMode,
      session.candidateLoading
    ),
    (item) => item.kind
  );
}

function appendDomInOrder(items) {
  const dom = [];
  for (const item of items) {
    if (item.kind === "message") {
      dom.push(`message:${item.message.role}:${item.message.content}`);
    } else if (item.kind === "thinking") {
      dom.push("thinking");
    } else if (item.kind === "chat_space") {
      dom.push(`chat_space:${item.segments.map((s) => s.text).join("|")}`);
    } else {
      dom.push("candidate_loading");
    }
  }
  return dom;
}

// 1. After Brain answers, newly accumulated Chat Space renders below the
//    previous lain> / brain> messages.
{
  const session = makeSession(async () => "2");
  session.appendKeyboardChatSpaceText("1+1");
  assert.equal(await session.submitChatSpace(), "sent");
  assert.equal(session.loadingMode, null);

  const messages = session.getChatTranscriptMessages();
  assert.deepEqual(Array.from(messages, (m) => m.content), ["1+1", "2"]);
  assert.equal(session.getChatSpace().length, 0);

  session.appendKeyboardChatSpaceText("next question");
  const items = buildChatTranscriptOrder(
    session.getChatTranscriptMessages(),
    session.getChatSpace(),
    session.loadingMode,
    session.candidateLoading
  );
  const dom = appendDomInOrder(items);
  assert.deepEqual(dom, [
    "message:user:1+1",
    "message:assistant:2",
    "chat_space:next question"
  ]);
  assert.equal(items.at(-1).kind, "chat_space");
}

// 2. While Brain is still answering, continued input stays below the
//    "Thinking..." indicator, never above the user turn.
{
  let resolveAsk;
  const session = makeSession(() => new Promise((resolve) => {
    resolveAsk = resolve;
  }));
  session.appendKeyboardChatSpaceText("1+1");
  const pending = session.submitChatSpace();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(session.loadingMode, "chat");
  session.appendKeyboardChatSpaceText("more while waiting");
  const items = buildChatTranscriptOrder(
    session.getChatTranscriptMessages(),
    session.getChatSpace(),
    session.loadingMode,
    session.candidateLoading
  );
  assert.deepEqual(renderItemOrder(session), ["message", "thinking", "chat_space"]);
  const dom = appendDomInOrder(items);
  assert.equal(dom.length, 3);
  assert.equal(dom[0], "message:user:1+1");
  assert.equal(dom[1], "thinking");
  assert.match(dom[2], /^chat_space:/);
  assert.match(dom[2], /more while waiting/);

  resolveAsk("2");
  assert.equal(await pending, "sent");
}

// 3. After a recover, the recovered Chat Space (and any newer segments)
//    still renders below the existing messages.
{
  const session = makeSession(async () => "answer");
  session.appendKeyboardChatSpaceText("wrong input");
  assert.equal(await session.submitChatSpace(), "sent");

  assert.equal(session.recoverLastSubmit(), true);
  // The submitted text returns to Chat Space; the transcript still holds the
  // (abandoned) branch but ordering must keep Chat Space at the bottom.
  session.appendKeyboardChatSpaceText("new after recover");
  const items = buildChatTranscriptOrder(
    session.getChatTranscriptMessages(),
    session.getChatSpace(),
    session.loadingMode,
    session.candidateLoading
  );
  assert.equal(items.at(-1).kind, "chat_space");
  assert.deepEqual(Array.from(items.at(-1).segments, (s) => s.text),
    ["wrong input", "new after recover"]);
  assert.deepEqual(renderItemOrder(session), ["message", "message", "chat_space"]);
}

// 4. Empty Chat Space still leaves only the transcript; the future input
//    row (`lain>`) is appended by the panel below everything.
{
  const session = makeSession(async () => "2");
  session.appendKeyboardChatSpaceText("1+1");
  await session.submitChatSpace();
  assert.deepEqual(renderItemOrder(session), ["message", "message"]);
}

console.log("chat-transcript-order: ok");
