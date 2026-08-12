import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: "export * from './src/ActivationSeed';",
    resolveDir: process.cwd(),
    sourcefile: "activation-seed-entry.ts",
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
  activationTargetKey,
  activationSeedSourceKey,
  mergeActivationSeeds,
  createActivationSeedSet,
  createCurrentUtteranceSeed,
  createActiveNoteSeed,
  createActiveHeadingSeed,
  createSelectedTextSeed,
  createSemanticQuerySurfaceSeeds,
  createSemanticPriorEpisodeSeed
} = module.exports;

function requireSeed(seed) {
  assert.notEqual(seed, undefined);
  return seed;
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

// A — current utterance preserves exact text and message provenance.
{
  const text = "  任意实数 Ａ\n  加零还是它自己。  ";
  const seed = requireSeed(createCurrentUtteranceSeed(text, "message-17"));

  assert.deepEqual(plain(seed.target), { kind: "surface", text });
  assert.deepEqual(plain(seed.sources), [{
    origin: "current_utterance",
    provenance: { kind: "message", messageId: "message-17" }
  }]);
  assertDeepFrozen(seed);
}

// B — active note, active heading, and selection coexist.
{
  const note = createActiveNoteSeed("Knowledge\\Analysis.md");
  const heading = createActiveHeadingSeed(
    "Knowledge/Analysis.md",
    "  # Key   idea "
  );
  const selection = requireSeed(createSelectedTextSeed(
    "selected sentence",
    "Knowledge/Analysis.md",
    "# Key idea"
  ));
  const set = createActivationSeedSet([note, heading, selection]);

  assert.equal(set.seeds.length, 3);
  assert.deepEqual(plain(set.seeds.map((seed) => seed.target.kind)), [
    "vault_note",
    "vault_subpath",
    "surface"
  ]);
  assert.equal(set.seeds[0].target.vaultPath, "Knowledge/Analysis.md");
  assert.equal(set.seeds[1].target.subpath, "# Key idea");
  assertDeepFrozen(set);
}

// C — equal targets merge distinct sources in first-occurrence order.
{
  const utterance = requireSeed(createCurrentUtteranceSeed("same target", "m1"));
  const selected = requireSeed(createSelectedTextSeed(
    "same target",
    "Notes/Source.md"
  ));
  const merged = mergeActivationSeeds([utterance, selected]);

  assert.equal(merged.length, 1);
  assert.deepEqual(plain(merged[0].sources.map((source) => source.origin)), [
    "current_utterance",
    "selected_text"
  ]);
}

// D — exact repeated sources collapse.
{
  const first = requireSeed(createCurrentUtteranceSeed("repeat", "m-repeat"));
  const duplicate = requireSeed(createCurrentUtteranceSeed("repeat", "m-repeat"));
  const merged = mergeActivationSeeds([first, duplicate, first]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].sources.length, 1);
  assert.equal(
    activationSeedSourceKey(merged[0].sources[0]),
    activationSeedSourceKey(first.sources[0])
  );
}

// E — full vault paths are identity; equal basenames do not collapse.
{
  const left = createActiveNoteSeed("Area A/Index.md");
  const right = createActiveNoteSeed("Area B/Index.md");
  const merged = mergeActivationSeeds([left, right]);

  assert.equal(merged.length, 2);
  assert.notEqual(
    activationTargetKey(merged[0].target),
    activationTargetKey(merged[1].target)
  );
}

// F — a whole note and one of its headings remain distinct targets.
{
  const note = createActiveNoteSeed("Notes/Topic.md");
  const heading = createActiveHeadingSeed("Notes/Topic.md", "# Detail");
  const merged = mergeActivationSeeds([note, heading]);

  assert.equal(merged.length, 2);
  assert.deepEqual(plain(merged.map((seed) => seed.target.kind)), [
    "vault_note",
    "vault_subpath"
  ]);
}

// G — NFKC and whitespace variants compare equal without rewriting first text.
{
  const retainedText = "  Full-width Ａ\n  and   spaces  ";
  const first = requireSeed(createCurrentUtteranceSeed(retainedText, "m1"));
  const second = requireSeed(createSelectedTextSeed(
    "Full-width A and spaces",
    "Notes/Source.md"
  ));
  const merged = mergeActivationSeeds([first, second]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].target.text, retainedText);
  assert.equal(merged[0].sources.length, 2);
}

// H — surface comparison remains case-sensitive.
{
  const upper = requireSeed(createCurrentUtteranceSeed("Vector R", "m1"));
  const lower = requireSeed(createCurrentUtteranceSeed("Vector r", "m2"));

  assert.equal(mergeActivationSeeds([upper, lower]).length, 2);
}

// I — semantic query is additive and cannot replace current utterance.
{
  const current = requireSeed(createCurrentUtteranceSeed(
    "Cauchy Schwarz",
    "m-query"
  ));
  const querySeeds = createSemanticQuerySurfaceSeeds({
    seedSurfaces: ["Cauchy   Schwarz", "inner product"]
  }, "m-query");
  const set = createActivationSeedSet([current, ...querySeeds]);

  assert.equal(set.seeds.length, 2);
  assert.equal(set.seeds[0].target.text, "Cauchy Schwarz");
  assert.deepEqual(plain(set.seeds[0].sources.map((source) => source.origin)), [
    "current_utterance",
    "semantic_query"
  ]);
  assert.equal(set.seeds[1].target.text, "inner product");
}

// J — empty semantic-query surfaces are ignored and input is not mutated.
{
  const surfaces = Object.freeze(["", "  \n\t ", "kept"]);
  const query = Object.freeze({ seedSurfaces: surfaces });
  const before = JSON.stringify(query);
  const seeds = createSemanticQuerySurfaceSeeds(query, "m-empty");

  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].target.text, "kept");
  assert.equal(JSON.stringify(query), before);
}

// K — semantic-prior seed stores only the exact ID and never rewrites episode.
{
  const episode = Object.freeze({
    id: "episode-exact-42",
    createdAt: 123,
    evidenceRefs: Object.freeze([Object.freeze({
      sourceKind: "message_span",
      messageId: "m-prior",
      snapshot: "exact user evidence",
      actor: "user"
    })]),
    anchors: Object.freeze(["unchanged anchor"]),
    semanticSpec: Object.freeze({ id: "spec-must-not-be-copied" }),
    semanticSessionId: "semantic-session",
    semanticRevision: 4
  });
  const before = JSON.stringify(episode);
  const seed = createSemanticPriorEpisodeSeed(episode);

  assert.deepEqual(plain(seed), {
    target: { kind: "semantic_episode", episodeId: "episode-exact-42" },
    sources: [{
      origin: "semantic_prior",
      provenance: {
        kind: "semantic_episode",
        episodeId: "episode-exact-42"
      }
    }]
  });
  assert.equal(JSON.stringify(episode), before);
  const serializedSeed = JSON.stringify(seed);
  assert.equal(serializedSeed.includes("unchanged anchor"), false);
  assert.equal(serializedSeed.includes("exact user evidence"), false);
  assert.equal(serializedSeed.includes("spec-must-not-be-copied"), false);
}

// L — Stage 1 outputs expose no scoring, authority, or persistence state.
{
  const set = createActivationSeedSet([
    requireSeed(createCurrentUtteranceSeed("ephemeral context", "m-fields")),
    createActiveNoteSeed("Notes/Ephemeral.md")
  ]);
  const forbiddenFields = new Set([
    "id",
    "initialActivation",
    "weight",
    "confidence",
    "authority",
    "truth",
    "endorsement",
    "createdAt",
    "updatedAt",
    "persisted",
    "score",
    "depth",
    "edges"
  ]);

  function inspect(value) {
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(forbiddenFields.has(key), false, `forbidden field: ${key}`);
      inspect(nested);
    }
  }

  inspect(set);
}

// M — target and source ordering are deterministic by first occurrence.
{
  const betaCurrent = requireSeed(createCurrentUtteranceSeed("beta", "m1"));
  const alpha = requireSeed(createCurrentUtteranceSeed("alpha", "m2"));
  const betaSelected = requireSeed(createSelectedTextSeed(
    "beta",
    "Notes/Beta.md"
  ));
  const betaQuery = createSemanticQuerySurfaceSeeds({
    seedSurfaces: ["beta"]
  }, "m1")[0];
  const input = Object.freeze([
    betaCurrent,
    alpha,
    betaSelected,
    betaQuery,
    betaCurrent
  ]);
  const first = createActivationSeedSet(input);
  const second = createActivationSeedSet(input);

  assert.deepEqual(plain(first), plain(second));
  assert.deepEqual(plain(first.seeds.map((seed) => seed.target.text)), [
    "beta",
    "alpha"
  ]);
  assert.deepEqual(plain(first.seeds[0].sources.map((source) => source.origin)), [
    "current_utterance",
    "selected_text",
    "semantic_query"
  ]);
}

console.log("ACTIVATION-SEED PASS: 13 deterministic Stage 1 invariants");
