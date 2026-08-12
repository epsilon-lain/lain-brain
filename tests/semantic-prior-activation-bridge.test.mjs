import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/SemanticPriorActivationBridge';",
      "export {",
      "  createActivationSeedSet,",
      "  createCurrentUtteranceSeed,",
      "  createActiveNoteSeed,",
      "  createActiveHeadingSeed,",
      "  createSelectedTextSeed",
      "} from './src/ActivationSeed';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "semantic-prior-activation-bridge-entry.ts",
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
  createSemanticPriorEpisodeSeedSet,
  createActivationSeedSet,
  createCurrentUtteranceSeed,
  createActiveNoteSeed,
  createActiveHeadingSeed,
  createSelectedTextSeed
} = module.exports;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeEpisode(id, overrides = {}) {
  return Object.freeze({
    id,
    createdAt: 100,
    evidenceRefs: Object.freeze([Object.freeze({
      sourceKind: "message_span",
      messageId: `message-${id}`,
      snapshot: `exact evidence for ${id}`,
      actor: "user"
    })]),
    anchors: Object.freeze([`anchor-${id}`]),
    semanticSpec: Object.freeze({
      id: `spec-${id}`,
      description: `description-${id}`
    }),
    semanticSessionId: `session-${id}`,
    semanticRevision: 7,
    ...overrides
  });
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

// A — one selected episode becomes exactly one semantic_episode target.
{
  const set = createSemanticPriorEpisodeSeedSet([makeEpisode("episode-1")]);

  assert.deepEqual(plain(set), {
    seeds: [{
      target: { kind: "semantic_episode", episodeId: "episode-1" },
      sources: [{
        origin: "semantic_prior",
        provenance: {
          kind: "semantic_episode",
          episodeId: "episode-1"
        }
      }]
    }]
  });
  assertDeepFrozen(set);
}

// B — distinct episode IDs remain distinct in caller-provided order.
{
  const set = createSemanticPriorEpisodeSeedSet([
    makeEpisode("episode-b"),
    makeEpisode("episode-a")
  ]);

  assert.deepEqual(plain(set.seeds.map((seed) => seed.target.episodeId)), [
    "episode-b",
    "episode-a"
  ]);
}

// C — repeated IDs collapse through existing Stage 1 target/source identity.
{
  const set = createSemanticPriorEpisodeSeedSet([
    makeEpisode("episode-same", { createdAt: 1, semanticRevision: 1 }),
    makeEpisode("episode-same", { createdAt: 999, semanticRevision: 99 }),
    makeEpisode("episode-same", { anchors: Object.freeze(["other anchor"]) })
  ]);

  assert.equal(set.seeds.length, 1);
  assert.equal(set.seeds[0].sources.length, 1);
}

// D — episodes and caller-owned arrays are never mutated.
{
  const first = makeEpisode("episode-frozen");
  const second = makeEpisode("episode-frozen-2");
  const episodes = Object.freeze([first, second]);
  const before = JSON.stringify(episodes);

  createSemanticPriorEpisodeSeedSet(episodes);

  assert.equal(JSON.stringify(episodes), before);
  assert.equal(episodes[0], first);
  assert.equal(episodes[1], second);
}

// E — evidence, anchors, specs, and descriptions are not copied into identity.
{
  const episode = makeEpisode("episode-minimal");
  const serialized = JSON.stringify(
    createSemanticPriorEpisodeSeedSet([episode])
  );

  assert.equal(serialized.includes("exact evidence"), false);
  assert.equal(serialized.includes("anchor-episode-minimal"), false);
  assert.equal(serialized.includes("spec-episode-minimal"), false);
  assert.equal(serialized.includes("description-episode-minimal"), false);
  assert.equal(serialized.includes("semanticRevision"), false);
  assert.equal(serialized.includes("createdAt"), false);
}

// F — semantic-prior origin and semantic-episode provenance remain explicit.
{
  const seed = createSemanticPriorEpisodeSeedSet([
    makeEpisode("episode-provenance")
  ]).seeds[0];

  assert.equal(seed.sources[0].origin, "semantic_prior");
  assert.deepEqual(plain(seed.sources[0].provenance), {
    kind: "semantic_episode",
    episodeId: "episode-provenance"
  });
}

// G — prior seeds compose additively with utterance and Obsidian context seeds.
{
  const utterance = createCurrentUtteranceSeed("current thought", "message-now");
  const activeNote = createActiveNoteSeed("Notes/Current.md");
  const activeHeading = createActiveHeadingSeed(
    "Notes/Current.md",
    "#Current section"
  );
  const selectedText = createSelectedTextSeed(
    "selected context",
    "Notes/Current.md",
    "#Current section"
  );
  const priors = createSemanticPriorEpisodeSeedSet([
    makeEpisode("episode-composed")
  ]);
  assert.notEqual(utterance, undefined);
  assert.notEqual(selectedText, undefined);

  const combined = createActivationSeedSet([
    utterance,
    activeNote,
    activeHeading,
    selectedText,
    ...priors.seeds
  ]);

  assert.deepEqual(plain(combined.seeds.map((seed) => seed.target.kind)), [
    "surface",
    "vault_note",
    "vault_subpath",
    "surface",
    "semantic_episode"
  ]);
  assert.equal(combined.seeds[4].target.episodeId, "episode-composed");
}

// H — no weight, authority, confidence, ranking, or persistence fields appear.
{
  const set = createSemanticPriorEpisodeSeedSet([
    makeEpisode("episode-fields")
  ]);
  const forbidden = new Set([
    "initialActivation",
    "weight",
    "score",
    "rank",
    "confidence",
    "authority",
    "truth",
    "recency",
    "anchorCount",
    "semanticRevision",
    "createdAt",
    "persisted",
    "depth",
    "edges"
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

console.log("SEMANTIC-PRIOR-ACTIVATION-BRIDGE PASS: 8 pure Stage 2C scenarios");
