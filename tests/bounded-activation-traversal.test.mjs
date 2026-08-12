import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/BoundedActivationTraversal';",
      "export {",
      "  createActivationSeedSet,",
      "  createCurrentUtteranceSeed,",
      "  createActiveNoteSeed,",
      "  createActiveHeadingSeed,",
      "  createSelectedTextSeed,",
      "  createSemanticPriorEpisodeSeed",
      "} from './src/ActivationSeed';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "bounded-activation-traversal-entry.ts",
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
  DEFAULT_ACTIVATION_TRAVERSAL_BUDGET,
  resolveActivationTraversalBudget,
  traverseBoundedActivation,
  createActivationSeedSet,
  createCurrentUtteranceSeed,
  createActiveNoteSeed,
  createActiveHeadingSeed,
  createSelectedTextSeed,
  createSemanticPriorEpisodeSeed
} = module.exports;

function surface(text) {
  return Object.freeze({ kind: "surface", text });
}

function note(vaultPath) {
  return Object.freeze({ kind: "vault_note", vaultPath });
}

function subpath(vaultPath, path) {
  return Object.freeze({ kind: "vault_subpath", vaultPath, subpath: path });
}

function episode(episodeId) {
  return Object.freeze({ kind: "semantic_episode", episodeId });
}

function edge(type, target) {
  return Object.freeze({ type, target });
}

function key(target) {
  switch (target.kind) {
    case "surface": return `surface:${target.text}`;
    case "vault_note": return `note:${target.vaultPath}`;
    case "vault_subpath": return `subpath:${target.vaultPath}${target.subpath}`;
    case "semantic_episode": return `episode:${target.episodeId}`;
  }
}

function provider(graph, options = {}) {
  const calls = [];
  return {
    calls,
    getAdjacent(target) {
      calls.push(key(target));
      const edges = graph[key(target)] ?? [];
      return options.reverse === true ? [...edges].reverse() : edges;
    }
  };
}

function seedForSurface(text, messageId = `message-${text}`) {
  const seed = createCurrentUtteranceSeed(text, messageId);
  assert.notEqual(seed, undefined);
  return seed;
}

function resultFor(result, targetKey) {
  const found = result.results.find((item) => key(item.target) === targetKey);
  assert.notEqual(found, undefined, `missing result ${targetKey}`);
  return found;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      if (nested !== null && typeof nested === "object") {
        assertDeepFrozen(nested);
      }
    }
  }
}

// Budget defaults and validation are explicit and deterministic.
{
  assert.deepEqual(plain(DEFAULT_ACTIVATION_TRAVERSAL_BUDGET), {
    maxHops: 2,
    hopRetention: 0.5,
    minActivation: 0.25,
    maxVisitedTargets: 128,
    maxExpandedTargets: 32,
    maxEdgesPerTarget: 32,
    maxReturnedTargets: 48,
    maxReturnedNotes: 24,
    maxReturnedEpisodes: 8,
    maxReturnedSurfaces: 16
  });
  assert.throws(
    () => resolveActivationTraversalBudget({ maxHops: -1 }),
    /maxHops/
  );
  assert.throws(
    () => resolveActivationTraversalBudget({ hopRetention: 1.1 }),
    /hopRetention/
  );
  assert.throws(
    () => resolveActivationTraversalBudget({ minActivation: 0 }),
    /minActivation/
  );
}

// A — A -> B gives B activation 0.5 at depth 1.
{
  const graph = {
    "surface:A": [edge("outgoing_link", surface("B"))]
  };
  const result = traverseBoundedActivation(
    createActivationSeedSet([seedForSurface("A")]),
    provider(graph)
  );
  const b = resultFor(result, "surface:B");

  assert.equal(b.activation, 0.5);
  assert.equal(b.depth, 1);
  assert.deepEqual(plain(b.trace.hops), [{
    type: "outgoing_link",
    from: { kind: "surface", text: "A" },
    to: { kind: "surface", text: "B" }
  }]);
}

// B — A -> B -> C gives C activation 0.25 at depth 2.
{
  const graph = {
    "surface:A": [edge("outgoing_link", surface("B"))],
    "surface:B": [edge("backlink", surface("C"))]
  };
  const result = traverseBoundedActivation(
    createActivationSeedSet([seedForSurface("A")]),
    provider(graph)
  );
  const c = resultFor(result, "surface:C");

  assert.equal(c.activation, 0.25);
  assert.equal(c.depth, 2);
  assert.equal(c.trace.hops.length, 2);
}

// C — A -> B -> A cycle terminates without requeueing equal/weaker A.
{
  const graph = {
    "surface:A": [edge("outgoing_link", surface("B"))],
    "surface:B": [edge("backlink", surface("A"))]
  };
  const adjacency = provider(graph);
  const result = traverseBoundedActivation(
    createActivationSeedSet([seedForSurface("A")]),
    adjacency
  );

  assert.equal(result.visitedTargets, 2);
  assert.deepEqual(plain(adjacency.calls), ["surface:A", "surface:B"]);
  assert.equal(resultFor(result, "surface:A").activation, 1);
}

// D — duplicate paths produce one D at max 0.25, never a sum.
{
  const graph = {
    "surface:A": [
      edge("outgoing_link", surface("C")),
      edge("outgoing_link", surface("B"))
    ],
    "surface:B": [edge("outgoing_link", surface("D"))],
    "surface:C": [edge("backlink", surface("D"))]
  };
  const result = traverseBoundedActivation(
    createActivationSeedSet([seedForSurface("A")]),
    provider(graph)
  );
  const matches = result.results.filter((item) => key(item.target) === "surface:D");

  assert.equal(matches.length, 1);
  assert.equal(matches[0].activation, 0.25);
  assert.equal(matches[0].trace.hops[0].to.text, "B");
}

// E — when paths differ in length, the stronger shorter path owns the trace.
{
  const graph = {
    "surface:A": [
      edge("outgoing_link", surface("D")),
      edge("outgoing_link", surface("B"))
    ],
    "surface:B": [edge("outgoing_link", surface("D"))]
  };
  const result = traverseBoundedActivation(
    createActivationSeedSet([seedForSurface("A")]),
    provider(graph)
  );
  const d = resultFor(result, "surface:D");

  assert.equal(d.activation, 0.5);
  assert.equal(d.depth, 1);
  assert.equal(d.trace.hops.length, 1);
  assert.equal(d.trace.hops[0].from.text, "A");
}

// F — multiple provenance sources on one root do not amplify activation.
{
  const current = seedForSurface("shared", "message-shared");
  const selected = createSelectedTextSeed(
    "shared",
    "Notes/Current.md",
    "#Section"
  );
  assert.notEqual(selected, undefined);
  const result = traverseBoundedActivation(
    createActivationSeedSet([current, selected]),
    provider({})
  );
  const root = resultFor(result, "surface:shared");

  assert.equal(root.activation, 1);
  assert.equal(root.trace.seedSources.length, 2);
}

// G — a large shuffled hub obeys sorted maxEdgesPerTarget cutoff.
{
  const hubEdges = ["Z", "D", "A", "C", "B", "Y"].map((name) =>
    edge("outgoing_link", note(`Notes/${name}.md`))
  );
  const result = traverseBoundedActivation(
    createActivationSeedSet([seedForSurface("Hub")]),
    provider({ "surface:Hub": hubEdges }),
    { maxEdgesPerTarget: 3 }
  );

  assert.equal(result.truncated, true);
  assert.deepEqual(
    plain(result.results.filter((item) => item.depth === 1)
      .map((item) => item.target.vaultPath)),
    ["Notes/A.md", "Notes/B.md", "Notes/C.md"]
  );
}

// H — visited and expanded budgets terminate a dense cyclic graph.
{
  const names = ["A", "B", "C", "D", "E", "F"];
  const graph = Object.fromEntries(names.map((name) => [
    `surface:${name}`,
    names.filter((other) => other !== name).map((other) =>
      edge("backlink", surface(other))
    )
  ]));
  const result = traverseBoundedActivation(
    createActivationSeedSet([seedForSurface("A")]),
    provider(graph),
    {
      maxHops: 4,
      minActivation: 0.01,
      maxVisitedTargets: 4,
      maxExpandedTargets: 2
    }
  );

  assert.equal(result.visitedTargets, 4);
  assert.equal(result.expandedTargets, 2);
  assert.equal(result.truncated, true);
}

// I — a threshold above 0.25 excludes the depth-two result.
{
  const graph = {
    "surface:A": [edge("outgoing_link", surface("B"))],
    "surface:B": [edge("outgoing_link", surface("C"))]
  };
  const result = traverseBoundedActivation(
    createActivationSeedSet([seedForSurface("A")]),
    provider(graph),
    { minActivation: 0.26 }
  );

  assert.equal(result.results.some((item) => key(item.target) === "surface:C"), false);
}

// J — shuffled provider edge order produces identical output and traces.
{
  const graph = {
    "surface:A": [
      edge("backlink", surface("D")),
      edge("outgoing_link", surface("C")),
      edge("outgoing_link", surface("B")),
      edge("outgoing_link", surface("B"))
    ],
    "surface:B": [edge("outgoing_link", surface("E"))],
    "surface:C": [edge("backlink", surface("E"))]
  };
  const seeds = createActivationSeedSet([seedForSurface("A")]);
  const forward = traverseBoundedActivation(seeds, provider(graph));
  const reversed = traverseBoundedActivation(seeds, provider(graph, { reverse: true }));

  assert.deepEqual(plain(forward), plain(reversed));
}

// K — note and explicitly supplied semantic episode roots coexist at 1.
{
  const semanticEpisode = Object.freeze({
    id: "episode-explicit",
    createdAt: 1,
    evidenceRefs: Object.freeze([]),
    anchors: Object.freeze(["not copied"]),
    semanticSpec: Object.freeze({ id: "not-copied" }),
    semanticSessionId: "session",
    semanticRevision: 9
  });
  const noteSeed = createActiveNoteSeed("Notes/Root.md");
  const episodeSeed = createSemanticPriorEpisodeSeed(semanticEpisode);
  const adjacency = provider({
    "note:Notes/Root.md": [edge("outgoing_link", note("Notes/Child.md"))]
  });
  const result = traverseBoundedActivation(
    createActivationSeedSet([noteSeed, episodeSeed]),
    adjacency
  );

  assert.equal(resultFor(result, "note:Notes/Root.md").activation, 1);
  assert.equal(resultFor(result, "episode:episode-explicit").activation, 1);
  assert.equal(adjacency.calls.includes("episode:episode-explicit"), true);
  assert.equal(
    result.results.some((item) =>
      item.target.kind === "semantic_episode" && item.depth > 0
    ),
    false
  );
}

// L — vault_subpath -> containing vault_note works as one explicit hop.
{
  const heading = createActiveHeadingSeed("Notes/Topic.md", "#Detail");
  const graph = {
    "subpath:Notes/Topic.md#Detail": [
      edge("containing_note", note("Notes/Topic.md"))
    ]
  };
  const result = traverseBoundedActivation(
    createActivationSeedSet([heading]),
    provider(graph)
  );
  const containing = resultFor(result, "note:Notes/Topic.md");

  assert.equal(containing.activation, 0.5);
  assert.equal(containing.depth, 1);
  assert.equal(containing.trace.hops[0].type, "containing_note");
  assert.equal(result.visitedTargets, 2);
}

// M — frozen seeds, targets, edges, and provider arrays remain unchanged.
{
  const seed = seedForSurface("immutable");
  const target = note("Notes/Immutable.md");
  const frozenEdge = edge("outgoing_link", target);
  const frozenEdges = Object.freeze([frozenEdge]);
  const seeds = createActivationSeedSet([seed]);
  const beforeSeeds = JSON.stringify(seeds);
  const beforeEdges = JSON.stringify(frozenEdges);

  const result = traverseBoundedActivation(seeds, {
    getAdjacent: () => frozenEdges
  });

  assert.equal(JSON.stringify(seeds), beforeSeeds);
  assert.equal(JSON.stringify(frozenEdges), beforeEdges);
  assertDeepFrozen(result);
}

// N — traversal results expose no epistemic, proof, or recency fields.
{
  const result = traverseBoundedActivation(
    createActivationSeedSet([seedForSurface("fields")]),
    provider({
      "surface:fields": [edge("outgoing_link", note("Notes/Fields.md"))]
    })
  );
  const forbidden = new Set([
    "confidence",
    "truth",
    "authority",
    "endorsement",
    "proof",
    "proofStatus",
    "recency",
    "semanticRevision",
    "correctness",
    "canonicalId"
  ]);

  function inspect(value) {
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [field, nested] of Object.entries(value)) {
      assert.equal(forbidden.has(field), false, `forbidden field: ${field}`);
      inspect(nested);
    }
  }
  inspect(result);
}

// O — a stale/wrong episode is only an explicit relevance identity at 1.
{
  const wrongEpisode = Object.freeze({
    id: "episode-stale-wrong",
    createdAt: 0,
    evidenceRefs: Object.freeze([Object.freeze({
      snapshot: "wrong historical claim",
      actor: "user"
    })]),
    anchors: Object.freeze(["wrong anchor"]),
    semanticSpec: Object.freeze({
      description: "incorrect assistant hypothesis"
    }),
    semanticSessionId: "old-session",
    semanticRevision: 1
  });
  const result = traverseBoundedActivation(
    createActivationSeedSet([
      createSemanticPriorEpisodeSeed(wrongEpisode)
    ]),
    provider({})
  );
  const serialized = JSON.stringify(result);

  assert.equal(result.results[0].activation, 1);
  assert.equal(result.results[0].target.episodeId, "episode-stale-wrong");
  assert.equal(serialized.includes("wrong historical claim"), false);
  assert.equal(serialized.includes("wrong anchor"), false);
  assert.equal(serialized.includes("incorrect assistant hypothesis"), false);
}

// P — note, episode, surface, and total quotas are deterministic.
{
  const seeds = createActivationSeedSet([
    seedForSurface("surface-B"),
    seedForSurface("surface-A"),
    createActiveNoteSeed("Notes/B.md"),
    createActiveHeadingSeed("Notes/A.md", "#Part"),
    createSemanticPriorEpisodeSeed({ id: "episode-B" }),
    createSemanticPriorEpisodeSeed({ id: "episode-A" })
  ]);
  const result = traverseBoundedActivation(seeds, provider({}), {
    maxReturnedTargets: 4,
    maxReturnedNotes: 1,
    maxReturnedEpisodes: 1,
    maxReturnedSurfaces: 1
  });

  assert.equal(result.truncated, true);
  assert.deepEqual(plain(result.results.map((item) => key(item.target))), [
    "episode:episode-A",
    "surface:surface-A",
    "note:Notes/B.md"
  ]);

  const totalLimited = traverseBoundedActivation(seeds, provider({}), {
    maxReturnedTargets: 2,
    maxReturnedNotes: 4,
    maxReturnedEpisodes: 4,
    maxReturnedSurfaces: 4
  });
  assert.equal(totalLimited.truncated, true);
  assert.deepEqual(
    plain(totalLimited.results.map((item) => key(item.target))),
    ["episode:episode-A", "episode:episode-B"]
  );
}

// Q — root overflow preserves deterministic Stage 1 order and marks truncation.
{
  const seeds = createActivationSeedSet([
    seedForSurface("zeta-first"),
    seedForSurface("alpha-second"),
    seedForSurface("middle-third")
  ]);
  const result = traverseBoundedActivation(seeds, provider({}), {
    maxVisitedTargets: 2
  });

  assert.equal(result.truncated, true);
  assert.equal(result.visitedTargets, 2);
  assert.deepEqual(plain(result.results.map((item) => item.target.text)), [
    "alpha-second",
    "zeta-first"
  ]);
  assert.equal(
    result.results.some((item) => item.target.text === "middle-third"),
    false
  );
}

console.log("BOUNDED-ACTIVATION-TRAVERSAL PASS: 17 pure Stage 3 scenarios");
