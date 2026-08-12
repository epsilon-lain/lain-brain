import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: "export * from './src/ObsidianActivationContext';",
    resolveDir: process.cwd(),
    sourcefile: "obsidian-activation-context-entry.ts",
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
          "exports.MarkdownView = class MarkdownView {};",
          "exports.normalizePath = (value) => value",
          "  .replace(/\\\\/g, '/')",
          "  .replace(/\\/{2,}/g, '/')",
          "  .replace(/^\\.\\//, '')",
          "  .replace(/\\/$/, '');"
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
  collectObsidianActivationContext,
  createObsidianContextSeedSet,
  collectObsidianActivationSeeds
} = module.exports;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function heading(text, level, line, col = 0) {
  return {
    heading: text,
    level,
    position: {
      start: { line, col, offset: line * 100 + col },
      end: { line, col: col + text.length, offset: line * 100 + col + text.length }
    }
  };
}

function makeFixture({
  activeFile = { path: "Notes/Current.md", extension: "md" },
  view = null,
  headings = []
} = {}) {
  let requestedViewType;
  let fileCacheCalls = 0;
  const app = {
    workspace: {
      getActiveFile: () => activeFile,
      getActiveViewOfType: (viewType) => {
        requestedViewType = viewType;
        return view;
      }
    },
    metadataCache: {
      getFileCache: (file) => {
        fileCacheCalls += 1;
        assert.equal(file, activeFile);
        return { headings };
      }
    }
  };

  return {
    app,
    getRequestedViewType: () => requestedViewType,
    getFileCacheCalls: () => fileCacheCalls
  };
}

function makeEditorView({
  path = "Notes/Current.md",
  selection = "",
  cursorLine = 0,
  mode = "source"
} = {}) {
  return {
    file: { path, extension: "md" },
    getMode: () => mode,
    editor: {
      getSelection: () => selection,
      getCursor: () => ({ line: cursorLine, ch: 0 })
    }
  };
}

function seedSummary(set) {
  return plain(set.seeds.map((seed) => ({
    target: seed.target,
    origin: seed.sources[0].origin,
    provenance: seed.sources[0].provenance
  })));
}

// A — an active Markdown file produces an active-note seed without an editor.
{
  const fixture = makeFixture();
  const context = collectObsidianActivationContext(fixture.app);
  const set = createObsidianContextSeedSet(context);

  assert.deepEqual(plain(context), { activeFilePath: "Notes/Current.md" });
  assert.deepEqual(seedSummary(set), [{
    target: { kind: "vault_note", vaultPath: "Notes/Current.md" },
    origin: "active_note",
    provenance: { kind: "vault_location", vaultPath: "Notes/Current.md" }
  }]);
  assert.equal(fixture.getFileCacheCalls(), 0);
}

// B — cursor on/after a heading produces a separate subpath seed.
{
  const view = makeEditorView({ cursorLine: 4 });
  const fixture = makeFixture({
    view,
    headings: [heading("Current section", 2, 4)]
  });
  const set = collectObsidianActivationSeeds(fixture.app);

  assert.deepEqual(seedSummary(set).map((item) => item.origin), [
    "active_note",
    "active_heading"
  ]);
  assert.deepEqual(seedSummary(set)[1].target, {
    kind: "vault_subpath",
    vaultPath: "Notes/Current.md",
    subpath: "#Current section"
  });
}

// C — a real editor selection is an exact surface seed.
{
  const selection = "  exact selected text\nwith spacing  ";
  const fixture = makeFixture({
    view: makeEditorView({ selection, cursorLine: 1 })
  });
  const set = collectObsidianActivationSeeds(fixture.app);
  const summary = seedSummary(set);

  assert.equal(summary.length, 2);
  assert.equal(summary[1].origin, "selected_text");
  assert.equal(summary[1].target.text, selection);
  assert.deepEqual(summary[1].provenance, {
    kind: "vault_location",
    vaultPath: "Notes/Current.md"
  });
}

// D — note, heading, and selected text coexist; selection keeps heading provenance.
{
  const fixture = makeFixture({
    view: makeEditorView({ selection: "local idea", cursorLine: 12 }),
    headings: [heading("Parent", 1, 2), heading("Nested", 3, 10)]
  });
  const summary = seedSummary(collectObsidianActivationSeeds(fixture.app));

  assert.deepEqual(summary.map((item) => item.origin), [
    "active_note",
    "active_heading",
    "selected_text"
  ]);
  assert.equal(summary[1].target.subpath, "#Nested");
  assert.equal(summary[2].provenance.subpath, "#Nested");
}

// E — editor unavailable still preserves the active note.
{
  const fixture = makeFixture({ view: null });
  const set = collectObsidianActivationSeeds(fixture.app);

  assert.deepEqual(seedSummary(set).map((item) => item.origin), ["active_note"]);
  assert.equal(fixture.getRequestedViewType().name, "MarkdownView");
}

// F — empty or whitespace-only selection produces no surface seed.
{
  const fixture = makeFixture({
    view: makeEditorView({ selection: " \n\t ", cursorLine: 3 })
  });
  const summary = seedSummary(collectObsidianActivationSeeds(fixture.app));

  assert.deepEqual(summary.map((item) => item.origin), ["active_note"]);
}

// G — cursor before the first heading produces no heading seed.
{
  const fixture = makeFixture({
    view: makeEditorView({ cursorLine: 2 }),
    headings: [heading("Later", 1, 3)]
  });
  const summary = seedSummary(collectObsidianActivationSeeds(fixture.app));

  assert.deepEqual(summary.map((item) => item.origin), ["active_note"]);
}

// H — unsorted nested/multiple headings choose the nearest preceding heading.
{
  const fixture = makeFixture({
    view: makeEditorView({ cursorLine: 18 }),
    headings: [
      heading("Future", 1, 22),
      heading("Root", 1, 1),
      heading("Nearest nested", 4, 17),
      heading("Earlier sibling", 2, 9)
    ]
  });
  const context = collectObsidianActivationContext(fixture.app);

  assert.equal(context.editor.cursorLine, 18);
  assert.equal(context.editor.headingSubpath, "#Nearest nested");
}

// I — a missing/mismatched/non-source MarkdownView never leaks stale editor state.
{
  let staleReads = 0;
  const staleEditor = {
    getSelection: () => {
      staleReads += 1;
      return "stale selection";
    },
    getCursor: () => {
      staleReads += 1;
      return { line: 99, ch: 0 };
    }
  };
  const mismatched = makeFixture({
    view: {
      file: { path: "Notes/Old.md", extension: "md" },
      getMode: () => "source",
      editor: staleEditor
    },
    headings: [heading("Stale heading", 1, 90)]
  });
  const preview = makeFixture({
    view: {
      file: { path: "Notes/Current.md", extension: "md" },
      getMode: () => "preview",
      editor: staleEditor
    }
  });

  for (const fixture of [mismatched, preview]) {
    const context = collectObsidianActivationContext(fixture.app);
    assert.deepEqual(plain(context), { activeFilePath: "Notes/Current.md" });
    assert.deepEqual(
      seedSummary(createObsidianContextSeedSet(context)).map((item) => item.origin),
      ["active_note"]
    );
    assert.equal(fixture.getFileCacheCalls(), 0);
  }
  assert.equal(staleReads, 0);
}

console.log("OBSIDIAN-ACTIVATION-CONTEXT PASS: 9 read-only Stage 2A scenarios");
