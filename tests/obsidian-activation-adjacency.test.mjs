import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: [
      "export { TFile, MarkdownView } from 'obsidian';",
      "export * from './src/ObsidianActivationAdjacency';",
      "export {",
      "  createActivationSeedSet,",
      "  createActiveHeadingSeed,",
      "  createCurrentUtteranceSeed,",
      "  createSemanticPriorEpisodeSeed",
      "} from './src/ActivationSeed';",
      "export { traverseBoundedActivation } from './src/BoundedActivationTraversal';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "obsidian-activation-adjacency-entry.ts",
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
          "};"
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
  createObsidianActivationAdjacencyProvider,
  traverseObsidianActivation,
  createActivationSeedSet,
  createActiveHeadingSeed,
  createCurrentUtteranceSeed,
  createSemanticPriorEpisodeSeed,
  traverseBoundedActivation
} = module.exports;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
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

function resultFor(result, key) {
  const found = result.results.find((item) => targetKey(item.target) === key);
  assert.notEqual(found, undefined, `missing ${key}`);
  return found;
}

function makeFixture({
  activePath = "A.md",
  files = ["A.md"],
  caches = {},
  resolvedLinks = {},
  destinations = {}
} = {}) {
  const vaultFiles = new Map();
  for (const path of new Set([activePath, ...files])) {
    vaultFiles.set(path, new TFile(path));
  }
  for (const path of Object.values(destinations)) {
    if (path !== null && !vaultFiles.has(path)) {
      vaultFiles.set(path, new TFile(path));
    }
  }
  const activeFile = vaultFiles.get(activePath) ?? null;
  const resolutionCalls = [];
  const app = {
    workspace: {
      getActiveFile: () => activeFile,
      getActiveViewOfType: () => null
    },
    vault: {
      getAbstractFileByPath: (path) => vaultFiles.get(path) ?? null
    },
    metadataCache: {
      resolvedLinks,
      getFileCache: (file) => caches[file.path] ?? null,
      getFirstLinkpathDest: (linkPath, sourcePath) => {
        resolutionCalls.push([linkPath, sourcePath]);
        const path = destinations[`${sourcePath}|${linkPath}`]
          ?? destinations[linkPath]
          ?? null;
        return path === null ? null : vaultFiles.get(path) ?? null;
      }
    }
  };
  return { app, activeFile, vaultFiles, resolutionCalls };
}

function note(vaultPath) {
  return { kind: "vault_note", vaultPath };
}

// A — a note exposes one resolved outgoing wikilink through the exact API path.
{
  const fixture = makeFixture({
    files: ["A.md", "Folder/B.md"],
    caches: { "A.md": { links: [reference("B")] } },
    destinations: { "A.md|B": "Folder/B.md" }
  });
  const provider = createObsidianActivationAdjacencyProvider(fixture.app);
  assert.deepEqual(plain(provider.getAdjacent(note("A.md"))), [{
    type: "outgoing_link",
    target: { kind: "vault_note", vaultPath: "Folder/B.md" }
  }]);
  assert.deepEqual(plain(fixture.resolutionCalls), [["B", "A.md"]]);
}

// B — two outgoing links are deterministic regardless of cache order.
{
  const fixture = makeFixture({
    files: ["A.md", "B.md", "C.md"],
    caches: { "A.md": { links: [reference("C"), reference("B")] } },
    destinations: { B: "B.md", C: "C.md" }
  });
  const edges = createObsidianActivationAdjacencyProvider(fixture.app)
    .getAdjacent(note("A.md"));
  assert.deepEqual(plain(edges.map((edge) => edge.target.vaultPath)), [
    "B.md",
    "C.md"
  ]);
}

// C — real A -> B -> C adjacency decays 1 / 0.5 / 0.25.
{
  const fixture = makeFixture({
    files: ["A.md", "B.md", "C.md"],
    caches: {
      "A.md": { links: [reference("B")] },
      "B.md": { links: [reference("C")] }
    },
    destinations: { "A.md|B": "B.md", "B.md|C": "C.md" }
  });
  const result = traverseObsidianActivation(fixture.app);
  assert.equal(resultFor(result, "note:A.md").activation, 1);
  assert.equal(resultFor(result, "note:B.md").activation, 0.5);
  assert.equal(resultFor(result, "note:C.md").activation, 0.25);
  assert.deepEqual(plain(resultFor(result, "note:C.md").trace.hops
    .map((hop) => hop.type)), ["outgoing_link", "outgoing_link"]);
}

// D — heading-only traversal uses containing_note before outgoing_link.
{
  const fixture = makeFixture({
    files: ["A.md", "B.md"],
    caches: { "A.md": { links: [reference("B")] } },
    destinations: { B: "B.md" }
  });
  const roots = createActivationSeedSet([
    createActiveHeadingSeed("A.md", "#Section")
  ]);
  const result = traverseBoundedActivation(
    roots,
    createObsidianActivationAdjacencyProvider(fixture.app)
  );
  assert.equal(resultFor(result, "subpath:A.md#Section").activation, 1);
  assert.equal(resultFor(result, "note:A.md").activation, 0.5);
  assert.equal(resultFor(result, "note:B.md").activation, 0.25);
  assert.deepEqual(plain(resultFor(result, "note:B.md").trace.hops
    .map((hop) => hop.type)), ["containing_note", "outgoing_link"]);
}

// E — reverse resolvedLinks lookup produces distinct backlink neighbors.
{
  const fixture = makeFixture({
    files: ["A.md", "B.md", "C.md"],
    resolvedLinks: {
      "C.md": { "A.md": 1 },
      "B.md": { "A.md": 1 }
    }
  });
  const result = traverseObsidianActivation(fixture.app);
  assert.equal(resultFor(result, "note:B.md").activation, 0.5);
  assert.equal(resultFor(result, "note:C.md").activation, 0.5);
  assert.equal(resultFor(result, "note:B.md").trace.hops[0].type, "backlink");
}

// F — backlink counts and duplicate outgoing references do not amplify edges.
{
  const fixture = makeFixture({
    files: ["A.md", "B.md", "C.md"],
    caches: {
      "A.md": { links: [reference("B"), reference("B")] }
    },
    destinations: { B: "B.md" },
    resolvedLinks: { "C.md": { "A.md": 9 } }
  });
  const edges = createObsidianActivationAdjacencyProvider(fixture.app)
    .getAdjacent(note("A.md"));
  assert.equal(edges.length, 2);
  assert.deepEqual(plain(edges.map((edge) => edge.type)), [
    "backlink",
    "outgoing_link"
  ]);
}

// G — same basenames remain distinct through full-path Obsidian resolution.
{
  const fixture = makeFixture({
    files: ["A.md", "Area A/Shared.md", "Area B/Shared.md"],
    caches: { "A.md": { links: [reference("Shared")] } },
    destinations: { "A.md|Shared": "Area B/Shared.md" }
  });
  const edges = createObsidianActivationAdjacencyProvider(fixture.app)
    .getAdjacent(note("A.md"));
  assert.equal(edges[0].target.vaultPath, "Area B/Shared.md");
}

// H — resolved heading links preserve their explicit vault subpath.
{
  const fixture = makeFixture({
    files: ["A.md", "B.md"],
    caches: { "A.md": { links: [reference("B#Part")] } },
    destinations: { B: "B.md" }
  });
  const edges = createObsidianActivationAdjacencyProvider(fixture.app)
    .getAdjacent(note("A.md"));
  assert.deepEqual(plain(edges[0]), {
    type: "outgoing_link",
    target: { kind: "vault_subpath", vaultPath: "B.md", subpath: "#Part" }
  });
}

// I — unresolved links create no surface or vault adjacency edge.
{
  const fixture = makeFixture({
    caches: { "A.md": { links: [reference("Unresolved future")] } }
  });
  assert.equal(
    createObsidianActivationAdjacencyProvider(fixture.app)
      .getAdjacent(note("A.md")).length,
    0
  );
}

// J — surfaces and semantic episodes have no invented adjacency.
{
  const fixture = makeFixture();
  const provider = createObsidianActivationAdjacencyProvider(fixture.app);
  assert.deepEqual(plain(provider.getAdjacent({ kind: "surface", text: "A" })), []);
  assert.deepEqual(plain(provider.getAdjacent({
    kind: "semantic_episode",
    episodeId: "episode-A"
  })), []);
}

// K — missing and non-Markdown files safely produce empty adjacency.
{
  const fixture = makeFixture({ files: ["A.md", "Asset.png"] });
  const provider = createObsidianActivationAdjacencyProvider(fixture.app);
  assert.equal(provider.getAdjacent(note("Missing.md")).length, 0);
  assert.equal(provider.getAdjacent(note("Asset.png")).length, 0);
  assert.equal(provider.getAdjacent({
    kind: "vault_subpath",
    vaultPath: "Missing.md",
    subpath: "#Part"
  }).length, 0);
}

// L — provider ordering differences cannot change Stage 3 results or traces.
{
  const fixtureForward = makeFixture({
    files: ["A.md", "B.md", "C.md"],
    caches: { "A.md": { links: [reference("B"), reference("C")] } },
    destinations: { B: "B.md", C: "C.md" }
  });
  const fixtureReverse = makeFixture({
    files: ["A.md", "B.md", "C.md"],
    caches: { "A.md": { links: [reference("C"), reference("B")] } },
    destinations: { B: "B.md", C: "C.md" }
  });
  assert.deepEqual(
    plain(traverseObsidianActivation(fixtureForward.app)),
    plain(traverseObsidianActivation(fixtureReverse.app))
  );
}

// M — Stage 2A active note and a caller utterance remain independent roots.
{
  const fixture = makeFixture();
  const utterance = createCurrentUtteranceSeed("current thought", "message-1");
  assert.notEqual(utterance, undefined);
  const result = traverseObsidianActivation(fixture.app, {
    extraSeeds: [utterance]
  });
  assert.equal(resultFor(result, "note:A.md").activation, 1);
  assert.equal(resultFor(result, "surface:current thought").activation, 1);
}

// N — an explicit semantic episode remains a root and gains no neighbors.
{
  const fixture = makeFixture();
  const episodeSeed = createSemanticPriorEpisodeSeed({ id: "episode-explicit" });
  const result = traverseObsidianActivation(fixture.app, {
    extraSeeds: [episodeSeed]
  });
  const episode = resultFor(result, "episode:episode-explicit");
  assert.equal(episode.activation, 1);
  assert.equal(episode.depth, 0);
  assert.equal(result.results.some((item) =>
    item.target.kind === "semantic_episode" && item.depth > 0
  ), false);
}

// O — adjacency neighbors are not promoted to roots by the helper.
{
  const fixture = makeFixture({
    files: ["A.md", "B.md"],
    caches: { "A.md": { links: [reference("B")] } },
    destinations: { B: "B.md" }
  });
  const result = traverseObsidianActivation(fixture.app);
  const neighbor = resultFor(result, "note:B.md");
  assert.equal(neighbor.activation, 0.5);
  assert.equal(neighbor.depth, 1);
  assert.equal(neighbor.trace.hops[0].type, "outgoing_link");
}

console.log("OBSIDIAN-ACTIVATION-ADJACENCY PASS: 15 read-only Stage 4A scenarios");
