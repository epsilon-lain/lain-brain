import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: [
      "export { TFile } from 'obsidian';",
      "export * from './src/ActivatedContextMaterialization';",
      "export * from './src/ObsidianActivatedContextResolver';",
      "export * from './src/SemanticPriorActivatedContextResolver';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "activated-context-materialization-entry.ts",
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
          "exports.normalizePath = (value) => value",
          "  .replace(/\\\\/g, '/')",
          "  .replace(/\\/{2,}/g, '/')",
          "  .replace(/^\\.\\//, '')",
          "  .replace(/\\/$/, '');",
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
  DEFAULT_ACTIVATED_CONTEXT_BUDGET,
  resolveActivatedContextBudget,
  materializeActivatedContext,
  createObsidianActivatedContextResolver,
  createSemanticPriorActivatedContextResolver,
  serializeProvisionalSemanticSpec
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

function targetKey(target) {
  switch (target.kind) {
    case "surface": return `surface:${target.text}`;
    case "vault_note": return `note:${target.vaultPath}`;
    case "vault_subpath": return `subpath:${target.vaultPath}${target.subpath}`;
    case "semantic_episode": return `episode:${target.episodeId}`;
  }
}

function sourceFor(target) {
  switch (target.kind) {
    case "surface":
      return {
        origin: "current_utterance",
        provenance: { kind: "message", messageId: "message-root" }
      };
    case "semantic_episode":
      return {
        origin: "semantic_prior",
        provenance: {
          kind: "semantic_episode",
          episodeId: target.episodeId
        }
      };
    case "vault_note":
    case "vault_subpath":
      return {
        origin: "active_note",
        provenance: {
          kind: "vault_location",
          vaultPath: target.vaultPath,
          ...(target.kind === "vault_subpath"
            ? { subpath: target.subpath } : {})
        }
      };
  }
}

function result(target, activation = 1, depth = 0) {
  return deepFreeze({
    target,
    activation,
    depth,
    trace: {
      seedTarget: target,
      seedSources: [sourceFor(target)],
      hops: []
    }
  });
}

function traversal(results) {
  return deepFreeze({
    results,
    visitedTargets: results.length,
    expandedTargets: 0,
    truncated: false
  });
}

function surface(text, activation = 1, depth = 0) {
  return result({ kind: "surface", text }, activation, depth);
}

function note(path, activation = 1, depth = 0) {
  return result({ kind: "vault_note", vaultPath: path }, activation, depth);
}

function subpath(path, section, activation = 1, depth = 0) {
  return result({
    kind: "vault_subpath",
    vaultPath: path,
    subpath: section
  }, activation, depth);
}

function episode(id, activation = 1, depth = 0) {
  return result({ kind: "semantic_episode", episodeId: id }, activation, depth);
}

function createVaultFixture({ files = {}, caches = {}, failures = [] } = {}) {
  const tFiles = new Map();
  for (const path of Object.keys(files)) {
    tFiles.set(path, new TFile(path));
  }
  const reads = new Map();
  const writes = [];
  const app = {
    vault: {
      getAbstractFileByPath: (path) => tFiles.get(path) ?? null,
      cachedRead: async (file) => {
        reads.set(file.path, (reads.get(file.path) ?? 0) + 1);
        if (failures.includes(file.path)) {
          throw new Error("read failed");
        }
        const value = files[file.path];
        return typeof value === "function" ? value(reads.get(file.path)) : value;
      },
      create: (...args) => writes.push(["create", ...args]),
      modify: (...args) => writes.push(["modify", ...args])
    },
    metadataCache: {
      getFileCache: (file) => caches[file.path] ?? null
    }
  };
  return { app, reads, writes, tFiles };
}

function baseSpec(overrides = {}) {
  return {
    id: "spec-1",
    schemaVersion: 1,
    claimId: "claim-1",
    sourceRefs: [{
      id: "source-secret",
      messageId: "message-secret",
      snapshot: "must not appear in interpretation"
    }],
    symbols: [{
      id: "symbol-1",
      surface: "猫猫",
      role: "concept",
      description: "working meaning",
      userDefined: true,
      sourceRefIds: ["source-secret"]
    }],
    expressions: [{
      id: "expression-1",
      kind: "symbol_ref",
      symbolId: "symbol-1",
      label: "cat expression"
    }],
    statements: [{
      id: "statement-1",
      kind: "assertion",
      exprId: "expression-1",
      description: "provisional claim"
    }],
    ambiguities: [{
      id: "ambiguity-1",
      kind: "other",
      question: "Which cat?",
      affectedIds: ["symbol-1"],
      blocking: true,
      choices: [{ id: "choice-1", label: "猫猫" }]
    }],
    resolutions: [{
      id: "resolution-secret",
      ambiguityId: "ambiguity-1",
      answerText: "user answer must not be projected",
      actor: "user",
      createdAt: "2026-01-01"
    }],
    patches: [{
      id: "patch-secret",
      ambiguityId: "ambiguity-1",
      resolutionId: "resolution-secret",
      operations: [],
      createdAt: "2026-01-01"
    }],
    analysisStatus: "under_specified",
    reviewStatus: "pending",
    revision: 3,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
    description: "provisional model",
    futureField: "must not leak",
    ...overrides
  };
}

function makeEpisode(id, evidenceRefs, spec = baseSpec()) {
  return deepFreeze({
    id,
    createdAt: 1,
    evidenceRefs,
    anchors: ["anchor must not appear"],
    semanticSpec: spec,
    semanticSessionId: "session-secret",
    semanticRevision: 9
  });
}

function resolverFromFixture(fixture) {
  return { vault: createObsidianActivatedContextResolver(fixture.app) };
}

// Budget defaults are explicit and all inputs are validated.
{
  assert.deepEqual(plain(DEFAULT_ACTIVATED_CONTEXT_BUDGET), {
    maxItems: 12,
    maxCharactersPerItem: 4000,
    maxTotalCharacters: 12000,
    maxNoteItems: 8,
    maxSemanticEpisodeItems: 3,
    maxSurfaceItems: 4,
    maxContentPartsPerItem: 16
  });
  assert.throws(
    () => resolveActivatedContextBudget({ maxItems: -1 }),
    /maxItems/
  );
  assert.throws(
    () => resolveActivatedContextBudget({ maxTotalCharacters: 1.5 }),
    /maxTotalCharacters/
  );
}

// A — surface context is exact and surrogate-safe under prefix truncation.
{
  const exact = "  exact  text\n";
  const full = await materializeActivatedContext(
    traversal([surface(exact)]),
    {}
  );
  assert.equal(full.items[0].contentParts[0].text, exact);
  assert.equal(full.items[0].contentParts[0].sourceRole, "surface_context");

  const truncated = await materializeActivatedContext(
    traversal([surface("A😀B")]),
    {},
    { maxCharactersPerItem: 2 }
  );
  assert.equal(truncated.items[0].contentParts[0].text, "A");
  assert.equal(truncated.items[0].truncated, true);
  assert.equal(truncated.truncated, true);
}

// B — full Markdown is read exactly and mechanically bounded without repair.
{
  const fixture = createVaultFixture({
    files: { "Note.md": "# Heading\n**bold** and $x$" }
  });
  const full = await materializeActivatedContext(
    traversal([note("Note.md")]),
    resolverFromFixture(fixture)
  );
  assert.equal(full.items[0].contentParts[0].text, "# Heading\n**bold** and $x$");

  const capped = await materializeActivatedContext(
    traversal([note("Note.md")]),
    resolverFromFixture(fixture),
    { maxCharactersPerItem: 12 }
  );
  assert.equal(capped.items[0].contentParts[0].text, "# Heading\n**");
  assert.equal(capped.items[0].truncated, true);
}

// C — resolveSubpath ranges include child headings and stop at sibling heading.
{
  const markdown = "# Parent\nintro\n## Child\nchild\n# Next\nnext";
  const nextOffset = markdown.indexOf("# Next");
  const fixture = createVaultFixture({
    files: { "Sections.md": markdown },
    caches: {
      "Sections.md": {
        __subpaths: {
          "#Parent": {
            type: "heading",
            start: { line: 0, col: 0, offset: 0 },
            end: { line: 4, col: 0, offset: nextOffset }
          },
          "#^block-1": {
            type: "block",
            start: { line: 1, col: 0, offset: 9 },
            end: { line: 2, col: 0, offset: 15 }
          }
        }
      }
    }
  });
  const bundle = await materializeActivatedContext(
    traversal([
      subpath("Sections.md", "#Parent"),
      subpath("Sections.md", "#^block-1")
    ]),
    resolverFromFixture(fixture)
  );
  const heading = bundle.items[0].contentParts[0].text;
  assert.equal(heading, "# Parent\nintro\n## Child\nchild\n");
  assert.equal(heading.includes("## Child"), true);
  assert.equal(heading.includes("# Next"), false);
  assert.equal(bundle.items[1].contentParts[0].text, "intro\n");
}

// D — missing heading/block and metadata fail open without whole-note fallback.
{
  const fixture = createVaultFixture({
    files: { "Note.md": "whole note must not appear" },
    caches: { "Note.md": { __subpaths: {} } }
  });
  const noMetadata = createVaultFixture({
    files: { "NoMetadata.md": "whole note must not appear" }
  });
  const bundle = await materializeActivatedContext(
    traversal([
      subpath("Note.md", "#Missing"),
      subpath("Note.md", "#^missing"),
      subpath("NoMetadata.md", "#Missing")
    ]),
    { vault: createObsidianActivatedContextResolver({
      vault: {
        getAbstractFileByPath: (path) =>
          fixture.tFiles.get(path) ?? noMetadata.tFiles.get(path) ?? null,
        cachedRead: async (file) =>
          file.path === "Note.md"
            ? "whole note must not appear"
            : "whole note must not appear"
      },
      metadataCache: {
        getFileCache: (file) => file.path === "Note.md"
          ? { __subpaths: {} }
          : null
      }
    }) }
  );
  assert.equal(bundle.items.length, 0);
  assert.deepEqual(plain(bundle.diagnostics.map((item) => item.code)), [
    "subpath_not_found",
    "subpath_not_found",
    "metadata_unavailable"
  ]);
  assert.equal(bundle.truncated, false);
}

// E — deleted/non-Markdown/read failures do not abort later materialization.
{
  const fixture = createVaultFixture({
    files: {
      "Asset.png": "bytes",
      "Broken.md": "broken",
      "Good.md": "good markdown"
    },
    failures: ["Broken.md"]
  });
  const bundle = await materializeActivatedContext(
    traversal([
      note("Deleted.md"),
      note("Asset.png"),
      note("Broken.md"),
      note("Good.md")
    ]),
    resolverFromFixture(fixture)
  );
  assert.deepEqual(plain(bundle.diagnostics.map((item) => item.code)), [
    "target_missing",
    "not_markdown",
    "read_failed"
  ]);
  assert.equal(bundle.items.length, 1);
  assert.equal(bundle.items[0].contentParts[0].text, "good markdown");
  assert.equal(bundle.truncated, false);
}

// F — note and subpath share one consistent cached read per invocation.
{
  const fixture = createVaultFixture({
    files: {
      "Snapshot.md": (readCount) => readCount === 1
        ? "# Stable\nfirst snapshot"
        : "# Changed\nsecond snapshot"
    },
    caches: {
      "Snapshot.md": {
        __subpaths: {
          "#Stable": {
            type: "heading",
            start: { line: 0, col: 0, offset: 0 },
            end: null
          }
        }
      }
    }
  });
  const bundle = await materializeActivatedContext(
    traversal([
      note("Snapshot.md"),
      subpath("Snapshot.md", "#Stable")
    ]),
    resolverFromFixture(fixture)
  );
  assert.equal(fixture.reads.get("Snapshot.md"), 1);
  assert.equal(bundle.items[0].contentParts[0].text, "# Stable\nfirst snapshot");
  assert.equal(bundle.items[1].contentParts[0].text, "# Stable\nfirst snapshot");
  assert.notEqual(targetKey(bundle.items[0].target), targetKey(bundle.items[1].target));
}

// G — exact evidence order and valid spans remain separate from AI interpretation.
{
  const prior = makeEpisode("episode-1", [
    {
      sourceKind: "message_span",
      messageId: "message-1",
      snapshot: "prefix EXACT suffix",
      startOffset: 7,
      endOffset: 12,
      actor: "user"
    },
    {
      sourceKind: "user_edit",
      editId: "edit-1",
      snapshot: "exact later edit",
      actor: "user"
    }
  ]);
  const before = JSON.stringify(prior);
  const calls = [];
  const resolver = createSemanticPriorActivatedContextResolver((id) => {
    calls.push(id);
    return id === prior.id ? prior : undefined;
  });
  const bundle = await materializeActivatedContext(
    traversal([episode("episode-1")]),
    { semanticEpisode: resolver }
  );
  assert.deepEqual(plain(bundle.items[0].contentParts.map((part) => [
    part.sourceRole,
    part.text
  ]).slice(0, 2)), [
    ["user_evidence", "EXACT"],
    ["user_evidence", "exact later edit"]
  ]);
  assert.equal(
    bundle.items[0].contentParts[2].sourceRole,
    "provisional_semantic_interpretation"
  );
  assert.deepEqual(plain(calls), ["episode-1"]);
  assert.equal(JSON.stringify(prior), before);
}

// H — invalid/missing exact evidence is diagnosed, never reconstructed.
{
  const invalid = makeEpisode("episode-invalid", [
    {
      sourceKind: "message_span",
      messageId: "message-invalid",
      snapshot: "short",
      startOffset: 1,
      endOffset: 99,
      actor: "user"
    },
    {
      sourceKind: "message_span",
      messageId: "message-partial",
      snapshot: "whole must not substitute",
      startOffset: 1,
      actor: "user"
    }
  ]);
  const bundle = await materializeActivatedContext(
    traversal([episode(invalid.id)]),
    {
      semanticEpisode: createSemanticPriorActivatedContextResolver(
        (id) => id === invalid.id ? invalid : undefined
      )
    }
  );
  assert.deepEqual(plain(bundle.diagnostics.map((item) => item.code)), [
    "invalid_evidence",
    "invalid_evidence"
  ]);
  const texts = bundle.items[0].contentParts.map((part) => part.text).join("\n");
  assert.equal(texts.includes("whole must not substitute"), false);
  assert.equal(texts.includes("anchor must not appear"), false);
  assert.equal(bundle.items[0].contentParts.length, 1);
}

// I — explicit SemanticSpec projection is stable and excludes provenance/bookkeeping.
{
  const spec = deepFreeze(baseSpec());
  const before = JSON.stringify(spec);
  const first = serializeProvisionalSemanticSpec(spec);
  const second = serializeProvisionalSemanticSpec(spec);
  const parsed = JSON.parse(first);
  assert.equal(first, second);
  assert.equal(parsed.description, "provisional model");
  assert.equal(parsed.symbols[0].surface, "猫猫");
  assert.equal("sourceRefs" in parsed, false);
  assert.equal("sourceRefIds" in parsed.symbols[0], false);
  assert.equal("resolutions" in parsed, false);
  assert.equal("patches" in parsed, false);
  assert.equal("futureField" in parsed, false);
  assert.equal("reviewStatus" in parsed, false);
  assert.equal(first.includes("must not appear in interpretation"), false);
  assert.equal(JSON.stringify(spec), before);
}

// J — activation changes relevance metadata only, never source role/content.
{
  const bundle = await materializeActivatedContext(
    traversal([surface("same", 1, 0), surface("same", 0.5, 1)]),
    {}
  );
  assert.deepEqual(plain(bundle.items.map((item) => ({
    activation: item.activation,
    text: item.contentParts[0].text,
    sourceRole: item.contentParts[0].sourceRole
  }))), [
    { activation: 1, text: "same", sourceRole: "surface_context" },
    { activation: 0.5, text: "same", sourceRole: "surface_context" }
  ]);
}

// K — part, per-item, type, total-item, and total-character caps are deterministic.
{
  const prior = makeEpisode("episode-caps", [
    { sourceKind: "user_edit", editId: "a", snapshot: "AAAA", actor: "user" },
    { sourceKind: "user_edit", editId: "b", snapshot: "BBBB", actor: "user" }
  ]);
  const episodeResolver = createSemanticPriorActivatedContextResolver(
    (id) => id === prior.id ? prior : undefined
  );
  const partCap = await materializeActivatedContext(
    traversal([episode(prior.id)]),
    { semanticEpisode: episodeResolver },
    { maxContentPartsPerItem: 2 }
  );
  assert.equal(partCap.items[0].contentParts.length, 2);
  assert.equal(partCap.items[0].truncated, true);

  const typeQuota = await materializeActivatedContext(
    traversal([surface("A"), surface("B"), episode(prior.id)]),
    { semanticEpisode: episodeResolver },
    { maxSurfaceItems: 1, maxSemanticEpisodeItems: 1 }
  );
  assert.deepEqual(plain(typeQuota.items.map((item) => targetKey(item.target))), [
    "surface:A",
    "episode:episode-caps"
  ]);

  const itemQuota = await materializeActivatedContext(
    traversal([surface("first"), surface("second")]),
    {},
    { maxItems: 1 }
  );
  assert.equal(itemQuota.items.length, 1);
  assert.equal(itemQuota.truncated, true);

  const totalCap = await materializeActivatedContext(
    traversal([surface("1234"), surface("5678")]),
    {},
    { maxTotalCharacters: 6 }
  );
  assert.deepEqual(plain(totalCap.items.map((item) =>
    item.contentParts[0].text
  )), ["1234", "56"]);
  assert.equal(totalCap.budgetUsage.characters, 6);
  assert.equal(totalCap.items[1].truncated, true);
  assert.equal(totalCap.truncated, true);
}

// L — traversal order is preserved; failures do not abort following results.
{
  const fixture = createVaultFixture({ files: { "Good.md": "good" } });
  const bundle = await materializeActivatedContext(
    traversal([
      surface("first", 1),
      note("Missing.md", 0.5, 1),
      note("Good.md", 0.5, 1),
      surface("last", 0.25, 2)
    ]),
    resolverFromFixture(fixture)
  );
  assert.deepEqual(plain(bundle.items.map((item) => targetKey(item.target))), [
    "surface:first",
    "note:Good.md",
    "surface:last"
  ]);
  assert.equal(bundle.diagnostics[0].resultIndex, 1);
}

// M — only explicitly activated episode IDs are requested; no search occurs.
{
  const priorA = makeEpisode("episode-A", []);
  const priorB = makeEpisode("episode-B", []);
  const calls = [];
  const resolver = createSemanticPriorActivatedContextResolver((id) => {
    calls.push(id);
    return id === priorA.id ? priorA : id === priorB.id ? priorB : undefined;
  });
  await materializeActivatedContext(
    traversal([episode("episode-B")]),
    { semanticEpisode: resolver }
  );
  assert.deepEqual(plain(calls), ["episode-B"]);
}

// N — outputs are deeply immutable, deterministic, and epistemically minimal.
{
  const fixture = createVaultFixture({ files: { "Note.md": "content" } });
  const input = traversal([note("Note.md"), surface("surface")]);
  const before = JSON.stringify(input);
  const first = await materializeActivatedContext(
    input,
    resolverFromFixture(fixture)
  );
  const second = await materializeActivatedContext(
    input,
    resolverFromFixture(fixture)
  );
  assert.deepEqual(plain(first), plain(second));
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.items[0].contentParts[0]), true);

  const forbidden = new Set([
    "truth",
    "confidence",
    "authority",
    "authorityScore",
    "endorsement",
    "proof",
    "proofStatus",
    "recency",
    "semanticRevision"
  ]);
  function inspect(value) {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `forbidden field: ${key}`);
      inspect(child);
    }
  }
  inspect(first);
  assert.deepEqual(plain(fixture.writes), []);
}

console.log("ACTIVATED-CONTEXT-MATERIALIZATION PASS: 14 Stage 4B groups");
