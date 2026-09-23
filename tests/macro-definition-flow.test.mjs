import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export { LainBrainSession } from "./src/LainBrainSession";
      export {
        parseMacroDefinitionCandidateJson,
        validateMacroDefinitionCandidate
      } from "./src/MacroDefinitionInterpreter";
      export { DEFAULT_KA_MACRO } from "./src/MacroRegistry";
    `,
    resolveDir: process.cwd(),
    sourcefile: "macro-definition-flow-entry.ts",
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
  crypto: { randomUUID: () => "macro-definition-test" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  console: {
    log: (...values) => capturedLogs.push(values.join(" ")),
    warn: (...values) => capturedLogs.push(values.join(" ")),
    error: (...values) => capturedLogs.push(values.join(" "))
  },
  setTimeout,
  clearTimeout
});

const {
  LainBrainSession,
  parseMacroDefinitionCandidateJson,
  validateMacroDefinitionCandidate,
  DEFAULT_KA_MACRO
} = module.exports;

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

const VALID_REMOVE_MACRO = {
  id: "remove-line-n",
  name: "Remove line",
  patterns: [{
    kind: "parameterized",
    template: "remove line {n}",
    parameters: [{ name: "n", type: "integer", min: 1 }]
  }],
  parameters: [{ name: "n", type: "integer", min: 1 }],
  actions: [{ kind: "delete_segment", line: { parameter: "n" } }],
  writesToChat: false,
  undoable: true,
  confirmation: { kind: "destructive" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  schemaVersion: 1
};

const VALID_RECOVER_MACRO = {
  id: "recover-last",
  name: "Recover",
  patterns: [{ kind: "exact", phrase: "recover" }],
  parameters: [],
  actions: [{ kind: "restore_last_step" }],
  writesToChat: false,
  undoable: true,
  confirmation: { kind: "never" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  schemaVersion: 1
};

function makeSession(generator) {
  const session = new LainBrainSession(
    makeApp(),
    () => "deepseek-key",
    () => null,
    undefined,
    undefined,
    undefined,
    undefined,
    generator
  );
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  return session;
}

function generatorForRemoveAndRecover(_apiKey, description) {
  return description.toLowerCase().includes("recover")
    ? { ok: true, macro: VALID_RECOVER_MACRO }
    : { ok: true, macro: VALID_REMOVE_MACRO };
}

// Trigger phrase only enters mode; ordinary text is untouched.
{
  const session = makeSession(async () => ({ ok: true, macro: VALID_REMOVE_MACRO }));
  assert.equal(session.handleMacroDefinitionInput("ordinary message"), false);
  assert.equal(session.handleMacroDefinitionInput("定义宏"), true);
  assert.equal(session.getMacroDefinitionState().kind, "awaiting_description");
  assert.equal(session.getChatSpace().length, 0);
}

// Duplicate finalized turn is idempotent and does not enter a second flow.
{
  const session = makeSession(async () => ({ ok: true, macro: VALID_REMOVE_MACRO }));
  assert.equal(session.handleMacroDefinitionInput("定义宏", "voice:1"), true);
  assert.equal(session.getMacroDefinitionState().kind, "awaiting_description");
  assert.equal(session.handleMacroDefinitionInput("定义宏", "voice:1"), true);
  assert.equal(session.getMacroDefinitionState().kind, "awaiting_description");
}

// Success: description -> preview -> confirm persists exactly once.
{
  const saved = [];
  const session = makeSession(async () => ({ ok: true, macro: VALID_REMOVE_MACRO }));
  session.setMacroRegistrySaveCallback((registry) => saved.push(registry));
  session.handleMacroDefinitionInput("定义宏");
  await session.submitMacroDefinitionDescription("删除第5行");
  const state = session.getMacroDefinitionState();
  assert.equal(state.kind, "preview");
  assert.equal(state.preview.triggerPhrases[0], "remove line {n}");
  assert.equal(session.getChatSpace().length, 0);
  assert.equal(
    session.getChatTranscriptMessages().filter(
      (message) => message.role === "user"
    ).length,
    0
  );
  assert.equal(session.confirmMacroDefinition(), true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].macros.some((macro) => macro.id === "remove-line-n"), true);
  assert.equal(session.getMacroDefinitionState().kind, "idle");
}

// Cancel leaves no partial state and writes nothing.
{
  const saved = [];
  const session = makeSession(async () => ({ ok: true, macro: VALID_REMOVE_MACRO }));
  session.setMacroRegistrySaveCallback((registry) => saved.push(registry));
  session.handleMacroDefinitionInput("定义宏");
  await session.submitMacroDefinitionDescription("删除第5行");
  assert.equal(session.getMacroDefinitionState().kind, "preview");
  session.cancelMacroDefinition();
  assert.equal(session.getMacroDefinitionState().kind, "idle");
  assert.equal(saved.length, 0);
}

// Provider failure surfaces as an error state, never a preview.
{
  const session = makeSession(async () => ({ ok: false, error: "provider down" }));
  session.handleMacroDefinitionInput("定义宏");
  await session.submitMacroDefinitionDescription("删除第5行");
  const state = session.getMacroDefinitionState();
  assert.equal(state.kind, "error");
  assert.equal(state.message, "provider down");
}

// Cancelling while a provider request is in flight discards the late result.
{
  let resolveGenerator;
  const session = makeSession(() => new Promise((resolve) => {
    resolveGenerator = resolve;
  }));
  const pending = session.submitMacroDefinitionDescription("recover");
  session.cancelMacroDefinition();
  resolveGenerator({ ok: true, macro: VALID_REMOVE_MACRO });
  await pending;
  assert.equal(session.getMacroDefinitionState().kind, "idle");
  assert.equal(session.getMacroRegistry().macros.some(
    (macro) => macro.id === "remove-line-n"
  ), false);
}

// Saved macros execute through both keyboard and finalized voice turns.
{
  const session = makeSession(generatorForRemoveAndRecover);
  session.handleMacroDefinitionInput("定义宏");
  await session.submitMacroDefinitionDescription("remove line");
  assert.equal(session.getMacroDefinitionState().kind, "preview");
  session.confirmMacroDefinition();

  session.handleMacroDefinitionInput("定义宏");
  await session.submitMacroDefinitionDescription("recover last step");
  assert.equal(session.getMacroDefinitionState().kind, "preview");
  session.confirmMacroDefinition();

  session.appendKeyboardChatSpaceText("paragraph 1");
  session.appendKeyboardChatSpaceText("paragraph 2");
  session.appendKeyboardChatSpaceText("paragraph 3");

  const keyboardDelete = session.ingestKeyboardChatSpaceTurn("remove line 1");
  assert.equal(keyboardDelete.kind, "executed");
  assert.deepEqual(
    [...session.getChatSpace().map((segment) => segment.text)],
    ["paragraph 2", "paragraph 3"]
  );

  const voiceDelete = session.ingestFinalizedVoiceTurn(
    "remove line 2",
    "2026-01-01T00:00:00.000Z",
    "voice:remove-2"
  );
  assert.equal(voiceDelete.kind, "executed");
  assert.deepEqual(
    [...session.getChatSpace().map((segment) => segment.text)],
    ["paragraph 2"]
  );

  const voiceRecover = session.ingestFinalizedVoiceTurn(
    "recover",
    "2026-01-01T00:00:01.000Z",
    "voice:recover"
  );
  assert.equal(voiceRecover.kind, "executed");
  assert.deepEqual(
    [...session.getChatSpace().map((segment) => segment.text)],
    ["paragraph 2", "paragraph 3"]
  );
}

// Invalid JSON is rejected.
{
  const invalid = parseMacroDefinitionCandidateJson("not json");
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /not valid JSON/);
}

// Illegal action is rejected by the whitelist.
{
  const illegal = validateMacroDefinitionCandidate({
    ...VALID_REMOVE_MACRO,
    id: "illegal-action",
    actions: [{ kind: "run_arbitrary_code" }]
  });
  assert.equal(illegal.ok, false);
}

// Trigger conflict against the built-in ka macro is rejected.
{
  const conflict = validateMacroDefinitionCandidate({
    ...VALID_REMOVE_MACRO,
    id: "conflicting-ka",
    patterns: [{ kind: "trailing", phrase: "ka" }],
    parameters: [],
    actions: [{ kind: "submit_to_brain" }]
  }, [DEFAULT_KA_MACRO]);
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /already belongs/);
}

console.log("macro-definition-flow: ok");
