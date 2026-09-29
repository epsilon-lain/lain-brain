import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: {
    contents: `export { LainBrainSession } from "./src/LainBrainSession";`,
    resolveDir: process.cwd(),
    sourcefile: "submit-recover-entry.ts",
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
  DOMMatrix: class {}, crypto: { randomUUID: () => "submit-recover" },
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

// Recover after answered submit and preserve newer unrelated segments.
{
  const session = makeSession(async () => "answer");
  session.appendKeyboardChatSpaceText("wrong input");
  assert.equal(await session.submitChatSpace(), "sent");
  assert.equal(
    session.getChatTranscriptMessages().some(
      (message) => message.content === "wrong input"
    ),
    true
  );
  session.appendKeyboardChatSpaceText("new unrelated");
  assert.equal(session.recoverLastSubmit(), true);
  assert.deepEqual(
    [...session.getChatSpace().map((segment) => segment.text)],
    ["wrong input", "new unrelated"]
  );
  assert.equal(
    session.getConversationHistory().some(
      (message) => message.content === "wrong input"
    ),
    false
  );
  assert.equal(
    session.getChatTranscriptMessages().some(
      (message) => message.content === "wrong input"
    ),
    true
  );
  assert.equal(session.recoverLastSubmit(), false);

  session.clearChat();
  session.appendKeyboardChatSpaceText("next correct");
  await session.submitChatSpace();
  const history = session.getConversationHistory()
    .map((message) => message.content).join("\n");
  assert.equal(history.includes("wrong input"), false);
  assert.equal(history.includes("next correct"), true);
}

// Late answer after recover must not write back.
{
  let resolveAsk;
  const session = makeSession(() => new Promise((resolve) => {
    resolveAsk = resolve;
  }));
  session.appendKeyboardChatSpaceText("late wrong");
  const pending = session.submitChatSpace();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.recoverLastSubmit(), true);
  resolveAsk("late answer");
  assert.equal(await pending, "blocked");
  assert.equal(
    session.getChatTranscriptMessages().some(
      (message) => message.content === "late answer"
    ),
    false
  );
}

// Unified journal: submit then edit, recover undoes the edit first.
{
  const session = makeSession(async () => "answer");
  session.setMacroRegistry({
    schemaVersion: 1,
    definitionPhrase: "定义宏",
    macros: [{
      id: "remove-line",
      name: "Remove line",
      patterns: [{ kind: "parameterized", template: "remove line {n}",
        parameters: [{ name: "n", type: "integer", min: 1 }] }],
      parameters: [{ name: "n", type: "integer", min: 1 }],
      actions: [{ kind: "delete_segment", line: { parameter: "n" } }],
      writesToChat: false,
      undoable: true,
      confirmation: { kind: "never" },
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1
    }, {
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
    }]
  });
  session.appendKeyboardChatSpaceText("wrong submit");
  assert.equal(await session.submitChatSpace(), "sent");

  session.appendKeyboardChatSpaceText("paragraph 1");
  session.appendKeyboardChatSpaceText("paragraph 2");
  assert.equal(session.ingestKeyboardChatSpaceTurn("remove line 1").kind, "executed");
  assert.deepEqual(
    [...session.getChatSpace().map((segment) => segment.text)],
    ["paragraph 2"]
  );

  assert.equal(session.ingestKeyboardChatSpaceTurn("recover").kind, "executed");
  assert.deepEqual(
    [...session.getChatSpace().map((segment) => segment.text)],
    ["paragraph 1", "paragraph 2"]
  );
  assert.equal(
    session.getChatTranscriptMessages().some(
      (message) => message.content === "wrong submit"
    ),
    true
  );

  assert.equal(session.ingestKeyboardChatSpaceTurn("recover").kind, "executed");
  assert.equal(
    session.getConversationHistory().some(
      (message) => message.content === "wrong submit"
    ),
    false
  );
}

console.log("submit-recover: ok");
