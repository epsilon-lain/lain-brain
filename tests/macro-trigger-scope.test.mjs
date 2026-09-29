import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: {
    contents: `export { LainBrainSession } from "./src/LainBrainSession";
               export { buildMacroDefinitionPreview } from "./src/MacroDefinitionInterpreter";
               export { deriveMacroTriggerLanguages, detectTriggerLanguages, isDirectMacroCommandShape } from "./src/MacroTypes";`,
    resolveDir: process.cwd(),
    sourcefile: "macro-trigger-scope-entry.ts",
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
  crypto: { randomUUID: () => "macro-scope" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  setTimeout, clearTimeout, console
});
const {
  LainBrainSession,
  buildMacroDefinitionPreview,
  deriveMacroTriggerLanguages,
  detectTriggerLanguages,
  isDirectMacroCommandShape
} = module.exports;

function makeApp() {
  return {
    vault: { cachedRead: async () => "", getMarkdownFiles: () => [],
      getFileByPath: () => null, getAbstractFileByPath: () => null },
    metadataCache: { getFirstLinkpathDest: () => null },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) }
  };
}

function rangeMacro(overrides = {}) {
  return {
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
    schemaVersion: 1,
    ...overrides
  };
}

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

function makeSession(macros = [rangeMacro(), recoverMacro]) {
  const session = new LainBrainSession(makeApp(), () => "key", () => null,
    undefined, async () => "answer");
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  session.setMacroRegistry({
    schemaVersion: 1,
    definitionPhrase: "定义宏",
    macros
  });
  session.setVoiceHoldDeadlineMs(25);
  return session;
}

function fill(session, count = 5) {
  for (let index = 1; index <= count; index += 1) {
    session.appendKeyboardChatSpaceText(`line ${index}`);
  }
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

// The model tries to overreach, but the local language scope rejects it.
function modelReturnsCommand(start, end) {
  return async () => JSON.stringify({
    decision: "command",
    macroId: "delete-range",
    parameters: { start, end }
  });
}

// ── Pure scope helpers ──────────────────────────────────────────────────────
assert.deepEqual([...detectTriggerLanguages("删除第 2 行到第 4 行")], ["zh"]);
assert.deepEqual([...detectTriggerLanguages("delete line 2 to 3")], ["en"]);
assert.deepEqual([...detectTriggerLanguages("删除 line 2")].sort(), ["en", "zh"]);
assert.deepEqual(
  [...deriveMacroTriggerLanguages(rangeMacro().patterns)],
  ["zh"]
);
assert.equal(isDirectMacroCommandShape("删除第二行到第三行"), true);
assert.equal(isDirectMacroCommandShape("delete line 2 to 3"), true);
assert.equal(isDirectMacroCommandShape("怎么删除第二行到第三行？"), false);
assert.equal(isDirectMacroCommandShape("「删除第二行到第三行」"), false);
assert.equal(isDirectMacroCommandShape("当我说删除第二行到第三行的时候"), false);

// ── Preview and persistence expose the conservative scope ──────────────────
{
  const preview = buildMacroDefinitionPreview(rangeMacro());
  assert.deepEqual([...preview.triggerLanguages], ["zh"]);
  assert.match(preview.triggerIntent, /删除 Chat Space 指定行范围/);

  const session = makeSession();
  const stored = session.getMacroRegistry();
  const storedMacro = stored.macros.find((m) => m.id === "delete-range");
  assert.deepEqual([...storedMacro.triggerLanguages], ["zh"]);
  assert.match(storedMacro.triggerIntent, /删除 Chat Space 指定行范围/);
}

// ── Chinese direct command and numeric variants execute once and recover ───
{
  for (const transcript of ["删除第二行到第三行。", "删除二到三行。"]) {
    const session = makeSession();
    session.setMacroIntentRequest(modelReturnsCommand(2, 3));
    fill(session);
    session.getVoiceInput().callbacks.onFinalizedTurn({
      sessionId: "s", turnOrder: 1, turnId: `zh:${transcript}`, transcript
    });
    await flush();
    assert.deepEqual(
      [...session.getChatSpace().map((s) => s.text)],
      ["line 1", "line 4", "line 5"]
    );
    session.getVoiceInput().callbacks.onFinalizedTurn({
      sessionId: "s", turnOrder: 2, turnId: `zh:${transcript}:recover`, transcript: "recover"
    });
    await flush();
    assert.deepEqual(
      [...session.getChatSpace().map((s) => s.text)],
      ["line 1", "line 2", "line 3", "line 4", "line 5"]
    );
  }
}

// ── Unauthorized English stays text even if the model returns command ──────
{
  const session = makeSession();
  session.setMacroIntentRequest(modelReturnsCommand(2, 3));
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "en:1", transcript: "delete line 2 to 3"
  });
  await flush();
  assert.deepEqual(
    [...session.getChatSpace().map((s) => s.text)],
    ["line 1", "line 2", "line 3", "line 4", "line 5", "delete line 2 to 3"]
  );
}

// ── Quotes, explanations, questions, and long dictation stay text ──────────
{
  const cases = [
    "「删除第二行到第三行」",
    "怎么删除第二行到第三行？",
    "当我说删除第二行到第三行的时候，系统就会删掉这两行",
    "请记录这个操作：删除第二行到第三行可以用来清理多余段落"
  ];
  for (const transcript of cases) {
    const session = makeSession();
    session.setMacroIntentRequest(modelReturnsCommand(2, 3));
    fill(session);
    session.getVoiceInput().callbacks.onFinalizedTurn({
      sessionId: "s", turnOrder: 1, turnId: `case:${transcript}`, transcript
    });
    await flush();
    assert.equal(
      session.getChatSpace().filter((s) => s.text === transcript).length,
      1,
      `expected "${transcript}" preserved once`
    );
    assert.equal(session.getChatSpace().length, 6);
  }
}

// ── Explicitly authorizing English makes English execute ───────────────────
{
  const englishRange = rangeMacro({
    patterns: [
      { kind: "parameterized", template: "删除第 {start} 行到第 {end} 行",
        parameters: [
          { name: "start", type: "integer", min: 1 },
          { name: "end", type: "integer", min: 1 }
        ] },
      { kind: "parameterized", template: "delete line {start} to {end}",
        parameters: [
          { name: "start", type: "integer", min: 1 },
          { name: "end", type: "integer", min: 1 }
        ] }
    ]
  });
  assert.deepEqual([...deriveMacroTriggerLanguages(englishRange.patterns)].sort(),
    ["en", "zh"]);
  const session = makeSession([englishRange, recoverMacro]);
  session.setMacroIntentRequest(modelReturnsCommand(2, 3));
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "en:auth", transcript: "delete line 2 to 3"
  });
  await flush();
  assert.deepEqual(
    [...session.getChatSpace().map((s) => s.text)],
    ["line 1", "line 4", "line 5"]
  );
}

// ── Split across adjacent finals executes once, no command text ────────────
{
  const session = makeSession();
  session.setMacroIntentRequest(async () => JSON.stringify({
    decision: "command",
    macroId: "delete-range",
    parameters: { start: 2, end: 3 }
  }));
  fill(session);
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "split:1", transcript: "删除。"
  });
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 2, turnId: "split:2", transcript: "二到三。"
  });
  await flush();
  assert.deepEqual(
    [...session.getChatSpace().map((s) => s.text)],
    ["line 1", "line 4", "line 5"]
  );
}

// ── Timeout and duplicate final still have exactly one destination ─────────
{
  const timeout = makeSession();
  timeout.setMacroIntentRequest(() => new Promise(() => {}));
  fill(timeout);
  timeout.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "to:1", transcript: "删除第二行到第三行。"
  });
  await flush();
  assert.equal(
    timeout.getChatSpace().filter((s) => s.text === "删除第二行到第三行。").length,
    1
  );

  const duplicate = makeSession();
  duplicate.setMacroIntentRequest(modelReturnsCommand(2, 3));
  fill(duplicate);
  duplicate.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "dup:1", transcript: "删除第二行到第三行。"
  });
  duplicate.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "s", turnOrder: 1, turnId: "dup:1", transcript: "删除第二行到第三行。"
  });
  await flush();
  assert.deepEqual(
    [...duplicate.getChatSpace().map((s) => s.text)],
    ["line 1", "line 4", "line 5"]
  );
}

console.log("macro-trigger-scope: ok");
