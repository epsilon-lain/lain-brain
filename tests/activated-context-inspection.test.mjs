import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: [
      "export { TFile } from 'obsidian';",
      "export * from './src/ActivatedContextInspection';",
      "export { createActiveNoteSeed, createSemanticPriorEpisodeSeed } from './src/ActivationSeed';",
      "export { createSemanticPriorActivatedContextResolver } from './src/SemanticPriorActivatedContextResolver';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "activated-context-inspection-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  write: false,
  metafile: true,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian",
        namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: [
          "exports.TFile = class TFile {",
          "  constructor(path) {",
          "    this.path = path;",
          "    this.extension = path.split('.').pop();",
          "  }",
          "};",
          "exports.MarkdownView = class MarkdownView {};",
          "exports.normalizePath = (value) => value",
          "  .replace(/\\\\/g, '/')",
          "  .replace(/\\/{2,}/g, '/')",
          "  .replace(/^\\.\\//, '')",
          "  .replace(/\\/$/, '');",
          "exports.parseLinktext = (value) => {",
          "  const index = value.indexOf('#');",
          "  return index < 0",
          "    ? { path: value, subpath: '' }",
          "    : { path: value.slice(0, index), subpath: value.slice(index) };",
          "};",
          "exports.resolveSubpath = (cache, subpath) =>",
          "  cache.__subpaths?.[subpath] ?? null;"
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console,
  Object,
  Map,
  Set,
  JSON
});

const {
  TFile,
  inspectActivatedContext,
  formatActivatedContextInspection,
  createActiveNoteSeed,
  createSemanticPriorEpisodeSeed,
  createSemanticPriorActivatedContextResolver
} = module.exports;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function reference(link) {
  return { link, original: `[[${link}]]` };
}

function targetKey(target) {
  switch (target.kind) {
    case "surface": return `surface:${target.text}`;
    case "vault_note": return `note:${target.vaultPath}`;
    case "vault_subpath": return `subpath:${target.vaultPath}${target.subpath}`;
    case "semantic_episode": return `episode:${target.episodeId}`;
  }
}

function findResult(inspection, key) {
  const result = inspection.traversal.results.find(
    (item) => targetKey(item.target) === key
  );
  assert.notEqual(result, undefined, `missing traversal result ${key}`);
  return result;
}

function findItem(inspection, key) {
  const item = inspection.contextBundle.items.find(
    (candidate) => targetKey(candidate.target) === key
  );
  assert.notEqual(item, undefined, `missing context item ${key}`);
  return item;
}

function makeFixture() {
  const contents = {
    "A.md": "# A\nAlpha context",
    "B.md": "# B\nBeta context",
    "C.md": "# C\nGamma context"
  };
  const files = new Map(
    Object.keys(contents).map((path) => [path, new TFile(path)])
  );
  const caches = {
    "A.md": { links: [reference("B")] },
    "B.md": { links: [reference("C")] },
    "C.md": {}
  };
  const writes = [];
  const llmCalls = [];
  const promptCalls = [];
  const app = {
    workspace: {
      getActiveFile: () => files.get("A.md"),
      getActiveViewOfType: () => null
    },
    vault: {
      getAbstractFileByPath: (path) => files.get(path) ?? null,
      cachedRead: async (file) => contents[file.path],
      create: (...args) => writes.push(["create", ...args]),
      createFolder: (...args) => writes.push(["createFolder", ...args]),
      modify: (...args) => writes.push(["modify", ...args]),
      trash: (...args) => writes.push(["trash", ...args])
    },
    metadataCache: {
      resolvedLinks: {},
      getFileCache: (file) => caches[file.path] ?? null,
      getFirstLinkpathDest: (linkPath, sourcePath) => {
        const destination = sourcePath === "A.md" && linkPath === "B"
          ? "B.md"
          : sourcePath === "B.md" && linkPath === "C"
            ? "C.md"
            : undefined;
        return destination === undefined ? null : files.get(destination);
      }
    },
    requestUrl: (...args) => llmCalls.push(args),
    buildPrompt: (...args) => promptCalls.push(args)
  };
  return { app, writes, llmCalls, promptCalls };
}

function makeEpisode() {
  return deepFreeze({
    id: "episode-123",
    createdAt: 1,
    evidenceRefs: [{
      sourceKind: "user_edit",
      editId: "edit-1",
      snapshot: "exact user evidence",
      actor: "user"
    }],
    anchors: ["must remain episode-owned"],
    semanticSpec: {
      id: "spec-123",
      schemaVersion: 1,
      claimId: "claim-123",
      sourceRefs: [],
      symbols: [],
      expressions: [],
      statements: [],
      ambiguities: [],
      resolutions: [],
      patches: [],
      analysisStatus: "under_specified",
      reviewStatus: "pending",
      revision: 1,
      createdAt: "fixed",
      updatedAt: "fixed",
      description: "provisional interpretation"
    },
    semanticSessionId: "session-1",
    semanticRevision: 1
  });
}

// One real inspection composes primary roots, adjacency traversal, and both
// materialization resolver kinds. Missing targets fail open.
{
  const fixture = makeFixture();
  const episode = makeEpisode();
  const episodeBefore = JSON.stringify(episode);
  const missingSeed = createActiveNoteSeed("Missing.md");
  const absoluteSeed = createActiveNoteSeed("C:/private/Vault/Secret.md");
  const episodeSeed = createSemanticPriorEpisodeSeed(episode);
  const episodeResolver = createSemanticPriorActivatedContextResolver(
    (episodeId) => episodeId === episode.id ? episode : undefined
  );
  const options = {
    extraSeeds: [missingSeed, absoluteSeed, episodeSeed],
    semanticEpisodeResolver: episodeResolver
  };

  const inspection = await inspectActivatedContext(fixture.app, options);
  assert.deepEqual([
    findResult(inspection, "note:A.md").activation,
    findResult(inspection, "note:B.md").activation,
    findResult(inspection, "note:C.md").activation
  ], [1, 0.5, 0.25]);
  assert.deepEqual([
    findResult(inspection, "note:A.md").depth,
    findResult(inspection, "note:B.md").depth,
    findResult(inspection, "note:C.md").depth
  ], [0, 1, 2]);
  assert.equal(
    findItem(inspection, "note:A.md").contentParts[0].text,
    "# A\nAlpha context"
  );
  assert.equal(
    findItem(inspection, "note:B.md").contentParts[0].text,
    "# B\nBeta context"
  );
  assert.equal(
    findItem(inspection, "note:C.md").contentParts[0].text,
    "# C\nGamma context"
  );

  const episodeItem = findItem(inspection, "episode:episode-123");
  assert.deepEqual(
    plain(episodeItem.contentParts.map((part) => part.sourceRole)),
    ["user_evidence", "provisional_semantic_interpretation"]
  );
  assert.equal(JSON.stringify(episode), episodeBefore);
  assert.equal(
    inspection.contextBundle.diagnostics.some(
      (item) => item.code === "target_missing"
    ),
    true
  );
  assert.equal(findItem(inspection, "note:C.md").contentParts.length, 1);

  const formatted = formatActivatedContextInspection(inspection);
  assert.match(formatted, /activation=1\.000 depth=0/u);
  assert.match(formatted, /activation=0\.500 depth=1/u);
  assert.match(formatted, /activation=0\.250 depth=2/u);
  assert.match(
    formatted,
    /winningTrace\.hop\.0=outgoing_link vault_note:A\.md -> vault_note:B\.md/u
  );
  assert.match(
    formatted,
    /winningTrace\.hop\.1=outgoing_link vault_note:B\.md -> vault_note:C\.md/u
  );
  assert.match(formatted, /sourceRole=vault_markdown/u);
  assert.match(formatted, /sourceRole=user_evidence/u);
  assert.match(formatted, /sourceRole=provisional_semantic_interpretation/u);
  assert.match(formatted, /code=target_missing/u);
  assert.match(formatted, /BudgetUsage: consideredResults=/u);
  assert.equal(formatted.includes("C:/private"), false);
  assert.match(formatted, /\[absolute-path-redacted\]/u);
  assert.deepEqual(plain(fixture.writes), []);
  assert.deepEqual(plain(fixture.llmCalls), []);
  assert.deepEqual(plain(fixture.promptCalls), []);

  const second = await inspectActivatedContext(fixture.app, options);
  assert.deepEqual(plain(second), plain(inspection));
  assert.equal(
    formatActivatedContextInspection(second),
    formatted
  );
  assert.equal(Object.isFrozen(inspection), true);
}

// Materialization truncation is reported without changing Stage 4B budgets.
{
  const fixture = makeFixture();
  const inspection = await inspectActivatedContext(fixture.app, {
    materializationBudget: { maxCharactersPerItem: 4 }
  });
  assert.equal(inspection.contextBundle.truncated, true);
  assert.equal(inspection.contextBundle.items.every((item) => item.truncated), true);
  const formatted = formatActivatedContextInspection(inspection);
  assert.match(formatted, /ContextBundle: items=3 truncated=true/u);
  assert.match(formatted, /Item \d+: .* truncated=true/u);
}

// The integration dependency graph excludes chat, prompts, LLM clients, and
// persistence. This guards the developer-only helper's architectural boundary.
{
  const inputs = Object.keys(built.metafile.inputs).join("\n");
  for (const forbidden of [
    "LainBrainSession.ts",
    "DeepSeekClient.ts",
    "LainBrainChatPanel.ts",
    "main.ts"
  ]) {
    assert.equal(inputs.includes(forbidden), false, forbidden);
  }
}

console.log("ACTIVATED-CONTEXT-INSPECTION PASS: 3 Stage 4B.5 groups");
