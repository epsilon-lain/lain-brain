import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: {
    contents: `export { LainBrainSession } from "./src/LainBrainSession";`,
    resolveDir: process.cwd(),
    sourcefile: "define-macro-delete-entry.ts",
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
        contents: [
          `exports.requestUrl = async () => { throw Error("unexpected network"); };`,
          `exports.normalizePath = (p) => String(p).replace(/\\\\/g, "/").replace(/^\\.[\\/]/, "").replace(/\\/+$/g, "");`
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports, require: createRequire(import.meta.url),
  URL, URLSearchParams,
  DOMMatrix: class {},
  crypto: { randomUUID: () => "macro-delete" },
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

function macro(id, name) {
  return {
    id,
    name,
    patterns: [{ kind: "exact", phrase: id }],
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
}

function makeSession(customMacros) {
  const saved = [];
  const session = new LainBrainSession(
    makeApp(),
    () => "deepseek-key",
    () => null,
    undefined,
    async () => "answer"
  );
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  session.setMacroRegistry({
    schemaVersion: 1,
    definitionPhrase: "定义宏",
    macros: customMacros
  });
  session.setMacroRegistrySaveCallback((registry) => saved.push(registry));
  return { session, saved };
}

const ids = (session) =>
  Array.from(session.getMacroRegistry().macros, (m) => m.id);

// ── Single delete removes the macro, keeps ka and other macros ─────────────
{
  const { session, saved } = makeSession([macro("m1", "One"), macro("m2", "Two")]);
  assert.equal(session.deleteMacro("m1"), true);
  assert.deepEqual(ids(session), ["builtin-ka", "m2"]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].macros.some((m) => m.id === "m1"), false);
}

// ── builtin-ka is protected from deletion ─────────────────────────────────
{
  const { session, saved } = makeSession([macro("m1", "One")]);
  assert.equal(session.deleteMacro("builtin-ka"), false);
  assert.deepEqual(ids(session), ["builtin-ka", "m1"]);
  assert.equal(saved.length, 0);
}

// ── Delete all custom macros leaves only ka and returns the count ──────────
{
  const { session } = makeSession([
    macro("m1", "One"),
    macro("m2", "Two"),
    macro("m3", "Three")
  ]);
  assert.equal(session.deleteAllCustomMacros(), 3);
  assert.deepEqual(ids(session), ["builtin-ka"]);
  assert.equal(session.deleteAllCustomMacros(), 0);
}

// ── Deleted macros stay gone after serialization + reload ─────────────────
{
  const { session } = makeSession([macro("m1", "One"), macro("m2", "Two")]);
  session.deleteMacro("m1");
  const serialized = session.getMacroRegistry();

  const reloaded = new LainBrainSession(
    makeApp(),
    () => "deepseek-key",
    () => null,
    undefined,
    async () => "answer"
  );
  reloaded.setMacroRegistry(serialized);
  assert.deepEqual(ids(reloaded), ["builtin-ka", "m2"]);
}

// ── UI wiring: Delete / Delete all exist, ka has no Delete ────────────────
{
  const source = readFileSync(
    new URL("../src/LainBrainChatPanel.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /"Delete all custom macros"/);
  assert.match(source, /class ConfirmMacroDeleteModal/);
  assert.match(source, /text: "Delete",\s*cls: "mod-warning"/);
  assert.match(source, /if \(macro\.id !== "builtin-ka"\)/);
}

console.log("define-macro-delete: ok");
