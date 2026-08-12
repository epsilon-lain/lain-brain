import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: [
      "export { TFile } from 'obsidian';",
      "export * from './src/ObsidianActivationTopology';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "obsidian-activation-topology-entry.ts",
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
          "};",
          "exports.getAllTags = (cache) => cache.__allTags ?? null;"
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
  collectObsidianTopologySeedsForFile,
  collectObsidianActivationSeedsWithTopology
} = module.exports;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function reference(link) {
  return { link, original: `[[${link}]]` };
}

function makeFixture({
  activePath = "Notes/Current.md",
  cache = {},
  resolvedLinks = {},
  destinations = {},
  vaultPaths = []
} = {}) {
  const files = new Map();
  const addFile = (path) => {
    if (!files.has(path)) {
      files.set(path, new TFile(path));
    }
    return files.get(path);
  };
  const activeFile = addFile(activePath);
  for (const path of vaultPaths) {
    addFile(path);
  }
  for (const path of Object.values(destinations)) {
    if (path !== null) {
      addFile(path);
    }
  }

  const resolutionCalls = [];
  const app = {
    workspace: {
      getActiveFile: () => activeFile,
      getActiveViewOfType: () => null
    },
    vault: {
      getAbstractFileByPath: (path) => files.get(path) ?? null
    },
    metadataCache: {
      resolvedLinks,
      getFileCache: (file) => file.path === activePath ? cache : null,
      getFirstLinkpathDest: (linkPath, sourcePath) => {
        resolutionCalls.push([linkPath, sourcePath]);
        const resolved = destinations[`${sourcePath}|${linkPath}`]
          ?? destinations[linkPath]
          ?? null;
        return resolved === null ? null : files.get(resolved) ?? null;
      }
    }
  };

  return { app, activeFile, resolutionCalls };
}

function summary(set) {
  return plain(set.seeds.map((seed) => ({
    target: seed.target,
    sources: seed.sources
  })));
}

function origins(set) {
  return summary(set).map((seed) => seed.sources[0].origin);
}

// A — one resolved outgoing link uses Obsidian resolution and full path.
{
  const fixture = makeFixture({
    cache: { links: [reference("Target")] },
    destinations: { Target: "Knowledge/Target.md" }
  });
  const set = collectObsidianTopologySeedsForFile(
    fixture.app,
    fixture.activeFile
  );

  assert.deepEqual(summary(set), [{
    target: { kind: "vault_note", vaultPath: "Knowledge/Target.md" },
    sources: [{
      origin: "wikilink",
      provenance: { kind: "vault_location", vaultPath: "Notes/Current.md" }
    }]
  }]);
  assert.deepEqual(plain(fixture.resolutionCalls), [["Target", "Notes/Current.md"]]);
}

// B — multiple links preserve cached first-occurrence order.
{
  const fixture = makeFixture({
    cache: { links: [reference("Second"), reference("First")] },
    destinations: {
      First: "A/First.md",
      Second: "B/Second.md"
    }
  });
  const set = collectObsidianTopologySeedsForFile(fixture.app, fixture.activeFile);

  assert.deepEqual(summary(set).map((seed) => seed.target.vaultPath), [
    "B/Second.md",
    "A/First.md"
  ]);
}

// C — duplicate outgoing links from the same source collapse.
{
  const fixture = makeFixture({
    cache: { links: [reference("Target"), reference("Target")] },
    destinations: { Target: "Knowledge/Target.md" }
  });
  const set = collectObsidianTopologySeedsForFile(fixture.app, fixture.activeFile);

  assert.equal(set.seeds.length, 1);
  assert.equal(set.seeds[0].sources.length, 1);
}

// D — same basename resolution preserves the exact API-selected path.
{
  const fixture = makeFixture({
    cache: { links: [reference("Shared")] },
    destinations: {
      "Notes/Current.md|Shared": "Area B/Shared.md"
    },
    vaultPaths: ["Area A/Shared.md"]
  });
  const set = collectObsidianTopologySeedsForFile(fixture.app, fixture.activeFile);

  assert.equal(set.seeds[0].target.vaultPath, "Area B/Shared.md");
}

// E — unresolved links stay surface-only and never become fake vault notes.
{
  const fixture = makeFixture({
    cache: { links: [reference("Future concept")] }
  });
  const set = collectObsidianTopologySeedsForFile(fixture.app, fixture.activeFile);

  assert.deepEqual(plain(set.seeds[0].target), {
    kind: "surface",
    text: "Future concept"
  });
  assert.equal(set.seeds.some((seed) => seed.target.kind === "vault_note"), false);
}

// F — a resolved link subpath remains a distinct vault_subpath target.
{
  const fixture = makeFixture({
    cache: { links: [reference("Target#Exact heading")] },
    destinations: { Target: "Knowledge/Target.md" }
  });
  const set = collectObsidianTopologySeedsForFile(fixture.app, fixture.activeFile);

  assert.deepEqual(plain(set.seeds[0].target), {
    kind: "vault_subpath",
    vaultPath: "Knowledge/Target.md",
    subpath: "#Exact heading"
  });
}

// G — resolved embeds and frontmatter links use the same resolution rules.
{
  const fixture = makeFixture({
    cache: {
      embeds: [reference("Diagram")],
      frontmatterLinks: [{ ...reference("Owner"), key: "owner" }]
    },
    destinations: {
      Diagram: "Assets/Diagram.md",
      Owner: "People/Owner.md"
    }
  });
  const set = collectObsidianTopologySeedsForFile(fixture.app, fixture.activeFile);

  assert.deepEqual(summary(set).map((seed) => seed.target.vaultPath), [
    "Assets/Diagram.md",
    "People/Owner.md"
  ]);
  assert.deepEqual(origins(set), ["wikilink", "wikilink"]);
}

// H — backlinks are a sorted reverse lookup over resolvedLinks.
{
  const fixture = makeFixture({
    resolvedLinks: {
      "Z/Backlink.md": { "Notes/Current.md": 1 },
      "A/Backlink.md": { "Notes/Current.md": 2 },
      "Other/Irrelevant.md": { "Elsewhere.md": 4 }
    },
    vaultPaths: ["Z/Backlink.md", "A/Backlink.md", "Other/Irrelevant.md"]
  });
  const set = collectObsidianTopologySeedsForFile(fixture.app, fixture.activeFile);

  assert.deepEqual(summary(set).map((seed) => seed.target.vaultPath), [
    "A/Backlink.md",
    "Z/Backlink.md"
  ]);
  assert.deepEqual(origins(set), ["backlink", "backlink"]);
}

// I — backlink link counts do not multiply the source seed.
{
  const fixture = makeFixture({
    resolvedLinks: {
      "Source/Many-links.md": { "Notes/Current.md": 9 }
    },
    vaultPaths: ["Source/Many-links.md"]
  });
  const set = collectObsidianTopologySeedsForFile(fixture.app, fixture.activeFile);

  assert.equal(set.seeds.length, 1);
  assert.equal(set.seeds[0].sources.length, 1);
}

// J — tags are exact surface seeds owned by the active note.
{
  const fixture = makeFixture({
    cache: { __allTags: ["#math/linear-algebra", "#中文标签"] }
  });
  const set = collectObsidianTopologySeedsForFile(fixture.app, fixture.activeFile);

  assert.deepEqual(summary(set).map((seed) => seed.target.text), [
    "#math/linear-algebra",
    "#中文标签"
  ]);
  assert.deepEqual(origins(set), ["note_metadata", "note_metadata"]);
}

// K — duplicate exact tags collapse through Stage 1 deduplication.
{
  const fixture = makeFixture({
    cache: { __allTags: ["#same", "#same", "#Same"] }
  });
  const set = collectObsidianTopologySeedsForFile(fixture.app, fixture.activeFile);

  assert.deepEqual(summary(set).map((seed) => seed.target.text), [
    "#same",
    "#Same"
  ]);
}

// L — the active note coexists with direct topology in the combined API.
{
  const fixture = makeFixture({
    cache: {
      links: [reference("Target")],
      __allTags: ["#active"]
    },
    destinations: { Target: "Knowledge/Target.md" }
  });
  const set = collectObsidianActivationSeedsWithTopology(fixture.app);

  assert.deepEqual(origins(set), [
    "active_note",
    "wikilink",
    "note_metadata"
  ]);
}

// M — frontmatter is opt-in and limited to safe selected primitives.
{
  const longArray = Array.from({ length: 13 }, (_, index) => index);
  const fixture = makeFixture({
    cache: {
      frontmatter: {
        status: "draft",
        priority: 2,
        reviewed: false,
        aliases: ["one", "two"],
        object: { nested: "ignored" },
        nested: [["ignored"]],
        longArray,
        unselected: "hidden"
      }
    }
  });
  const defaultSet = collectObsidianTopologySeedsForFile(
    fixture.app,
    fixture.activeFile
  );
  const selectedSet = collectObsidianTopologySeedsForFile(
    fixture.app,
    fixture.activeFile,
    {
      frontmatterKeys: [
        "status",
        "priority",
        "reviewed",
        "aliases",
        "object",
        "nested",
        "longArray"
      ]
    }
  );

  assert.equal(defaultSet.seeds.length, 0);
  assert.deepEqual(summary(selectedSet).map((seed) => seed.target.text), [
    "status: draft",
    "priority: 2",
    "reviewed: false",
    "aliases: one",
    "aliases: two"
  ]);
}

// N — outputs contain no weights, authority, traversal, or persistence fields.
{
  const fixture = makeFixture({
    cache: { links: [reference("Target")], __allTags: ["#tag"] },
    destinations: { Target: "Knowledge/Target.md" },
    resolvedLinks: { "Source.md": { "Notes/Current.md": 3 } },
    vaultPaths: ["Source.md"]
  });
  const set = collectObsidianActivationSeedsWithTopology(fixture.app);
  const forbidden = new Set([
    "initialActivation",
    "weight",
    "score",
    "confidence",
    "authority",
    "truth",
    "importance",
    "depth",
    "edges",
    "persisted"
  ]);

  function inspect(value) {
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `forbidden field: ${key}`);
      inspect(nested);
    }
  }
  inspect(set);
}

console.log("OBSIDIAN-ACTIVATION-TOPOLOGY PASS: 14 read-only Stage 2B scenarios");
