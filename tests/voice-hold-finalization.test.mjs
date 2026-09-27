import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: {
    contents: `export { LainBrainSession } from "./src/LainBrainSession";`,
    resolveDir: process.cwd(),
    sourcefile: "voice-hold-finalization-entry.ts",
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
  module,
  exports: module.exports,
  require: createRequire(import.meta.url),
  setTimeout,
  clearTimeout,
  DOMMatrix: class {},
  console
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

function makeSession() {
  const session = new LainBrainSession(makeApp(), () => "key", () => null,
    undefined, async () => "answer");
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  session.setMacroRegistry({
    schemaVersion: 1,
    definitionPhrase: "定义宏",
    macros: [rangeMacro]
  });
  session.setVoiceHoldDeadlineMs(25);
  return session;
}

function fill(session) {
  for (let i = 1; i <= 5; i += 1) session.appendKeyboardChatSpaceText(`line ${i}`);
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

// command succeeds and removes range without command text.
{
  const session = makeSession();
  session.setVoiceMacroIntentResolver(async () => ({
    kind: "command",
    macroId: "delete-range",
    parameters: { start: 2, end: 3 }
  }));
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "s:1", transcript: "删除二到三。"
  });
  await flush();
  assert.deepEqual(
    [...session.getChatSpace().map((s) => s.text)],
    ["line 1", "line 4", "line 5"]
  );
}

// text preserves original once.
{
  const session = makeSession();
  session.setVoiceMacroIntentResolver(async () => ({ kind: "text" }));
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "s:2", transcript: "普通文本。"
  });
  await flush();
  assert.equal(session.getChatSpace().at(-1).text, "普通文本。");
}

// uncertain preserves original once.
{
  const session = makeSession();
  session.setVoiceMacroIntentResolver(async () => ({ kind: "uncertain" }));
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "s:3", transcript: "不确定。"
  });
  await flush();
  assert.equal(session.getChatSpace().filter((s) => s.text === "不确定。").length, 1);
}

// timeout preserves original once.
{
  const session = makeSession();
  session.setVoiceMacroIntentResolver(() => new Promise(() => {}));
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "s:4", transcript: "超时。"
  });
  await flush();
  assert.equal(session.getChatSpace().filter((s) => s.text === "超时。").length, 1);
}

// request failure preserves original once.
{
  const session = makeSession();
  session.setVoiceMacroIntentResolver(async () => { throw new Error("fail"); });
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "s:5", transcript: "失败。"
  });
  await flush();
  assert.equal(session.getChatSpace().filter((s) => s.text === "失败。").length, 1);
}

// executor failure preserves original once.
{
  const session = makeSession();
  session.setVoiceMacroIntentResolver(async () => ({
    kind: "command",
    macroId: "delete-range",
    parameters: { start: 5, end: 2 }
  }));
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "s:6", transcript: "删除五到二。"
  });
  await flush();
  assert.equal(session.getChatSpace().filter((s) => s.text === "删除五到二。").length, 1);
  assert.equal(session.getChatSpace().length, 6);
}

// duplicate final processes once.
{
  const session = makeSession();
  session.setVoiceMacroIntentResolver(async () => ({ kind: "text" }));
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "s:7", transcript: "重复。"
  });
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "s:7", transcript: "重复。"
  });
  await flush();
  assert.equal(session.getChatSpace().filter((s) => s.text === "重复。").length, 1);
}

// stop recording still preserves original once.
{
  const session = makeSession();
  session.setVoiceMacroIntentResolver(() => new Promise(() => {}));
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "s:8", transcript: "停止。"
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await session.stopVoiceInput();
  await flush();
  assert.equal(session.getChatSpace().filter((s) => s.text === "停止。").length, 1);
}

// timer vs late model: raw settles once, late command ignored.
{
  const session = makeSession();
  session.setVoiceMacroIntentResolver(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { kind: "command", macroId: "delete-range", parameters: { start: 2, end: 3 } };
  });
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "s:9", transcript: "迟到。"
  });
  await flush();
  assert.equal(session.getChatSpace().filter((s) => s.text === "迟到。").length, 1);
  assert.equal(session.getChatSpace().length, 6);
}

console.log("voice-hold-finalization: ok");
