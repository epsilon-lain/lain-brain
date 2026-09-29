import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: {
    contents: `export { LainBrainSession } from "./src/LainBrainSession";`,
    resolveDir: process.cwd(),
    sourcefile: "submit-after-macro-delete-entry.ts",
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
  DOMMatrix: class {},
  crypto: { randomUUID: () => "submit-delete" },
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

const rangeMacro = {
  id: "delete-range",
  name: "Delete range",
  description: "删除指定行范围",
  patterns: [{ kind: "parameterized", template: "删除第 {start} 行到第 {end} 行",
    parameters: [
      { name: "start", type: "integer", min: 1 },
      { name: "end", type: "integer", min: 1 }
    ] }],
  parameters: [
    { name: "start", type: "integer", min: 1 },
    { name: "end", type: "integer", min: 1 }
  ],
  actions: [{
    kind: "delete_segment_range",
    startLine: { parameter: "start" },
    endLine: { parameter: "end" }
  }],
  writesToChat: false,
  undoable: true,
  confirmation: { kind: "never" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  schemaVersion: 1
};

const recoverMacro = {
  id: "recover-last",
  name: "Recover",
  patterns: [{ kind: "exact", phrase: "recover" }],
  parameters: [],
  actions: [{ kind: "restore_last_step" }],
  writesToChat: false,
  undoable: false,
  confirmation: { kind: "never" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  schemaVersion: 1
};

function makeSession(askText) {
  const session = new LainBrainSession(makeApp(), () => "key", () => null,
    undefined, askText);
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  session.setMacroRegistry({
    schemaVersion: 1,
    definitionPhrase: "定义宏",
    macros: [rangeMacro, recoverMacro]
  });
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

function flattenStrings(value, acc = []) {
  if (typeof value === "string") {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, acc);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) flattenStrings(value[key], acc);
  }
  return acc;
}

const TEST_WORD = "REMOVED_LINE_927";

// 1. Delete line 2, submit via ka: the Brain request must not carry the word,
//    while lines 1 and 3 remain.
{
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  });
  session.appendKeyboardChatSpaceText("line 1");
  session.appendKeyboardChatSpaceText(TEST_WORD);
  session.appendKeyboardChatSpaceText("line 3");

  const deleted = session.ingestKeyboardChatSpaceTurn("删除第 2 行到第 2 行");
  assert.equal(deleted.kind, "executed");
  assert.deepEqual(
    [...session.getChatSpace().map((s) => s.text)],
    ["line 1", "line 3"]
  );

  session.ingestKeyboardChatSpaceTurn("ka");
  await waitFor(() => requests.length === 1);

  const [apiKey, conversationHistory, noteContext, semanticPrior, foreground, sense] = requests[0];
  void apiKey;
  assert.ok(Array.isArray(conversationHistory), "message context is a history array");
  const historyText = flattenStrings(conversationHistory).join("\n");
  assert.equal(historyText.includes(TEST_WORD), false, "submitted body excludes the deleted line");
  assert.equal(historyText.includes("line 1"), true);
  assert.equal(historyText.includes("line 3"), true);
  assert.equal(
    flattenStrings([noteContext, semanticPrior, foreground, sense]).join("\n")
      .includes(TEST_WORD),
    false,
    "semantic state excludes the deleted line"
  );

  // Transcript keeps the surviving lines, never the deleted word.
  const transcript = flattenStrings(session.getChatTranscriptMessages()).join("\n");
  assert.equal(transcript.includes(TEST_WORD), false);
  assert.equal(transcript.includes("line 1"), true);
  assert.equal(transcript.includes("line 3"), true);
}

// 2. Control: delete then recover before submitting; the word reappears.
{
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  });
  session.appendKeyboardChatSpaceText("line 1");
  session.appendKeyboardChatSpaceText(TEST_WORD);
  session.appendKeyboardChatSpaceText("line 3");

  assert.equal(session.ingestKeyboardChatSpaceTurn("删除第 2 行到第 2 行").kind, "executed");
  assert.deepEqual(
    [...session.getChatSpace().map((s) => s.text)],
    ["line 1", "line 3"]
  );

  assert.equal(session.ingestKeyboardChatSpaceTurn("recover").kind, "executed");
  assert.deepEqual(
    [...session.getChatSpace().map((s) => s.text)],
    ["line 1", TEST_WORD, "line 3"]
  );

  session.ingestKeyboardChatSpaceTurn("ka");
  await waitFor(() => requests.length === 1);
  const historyText = flattenStrings(requests[0][1]).join("\n");
  assert.equal(historyText.includes(TEST_WORD), true,
    "recovered line reappears in the submitted body");
}

// 3. Segments typed while a Brain send is in flight are not mixed into that send.
{
  const requests = [];
  let resolveAsk;
  const session = makeSession((...args) => {
    requests.push(args);
    return new Promise((resolve) => { resolveAsk = resolve; });
  });
  session.appendKeyboardChatSpaceText("line 1");
  session.appendKeyboardChatSpaceText(TEST_WORD);
  session.appendKeyboardChatSpaceText("line 3");
  session.ingestKeyboardChatSpaceTurn("删除第 2 行到第 2 行");

  session.ingestKeyboardChatSpaceTurn("ka");
  await waitFor(() => requests.length === 1);

  session.appendKeyboardChatSpaceText("during send");
  const historyText = flattenStrings(requests[0][1]).join("\n");
  assert.equal(historyText.includes("during send"), false,
    "in-flight input is not merged into this submission");
  assert.equal(historyText.includes(TEST_WORD), false);

  resolveAsk("answer");
  // The later segment survives in Chat Space after the submitted snapshot is
  // removed, for the next round.
  await waitFor(() => session.getChatSpace().length === 1);
  assert.deepEqual(
    [...session.getChatSpace().map((s) => s.text)],
    ["during send"]
  );
}

console.log("submit-after-macro-delete: ok");
