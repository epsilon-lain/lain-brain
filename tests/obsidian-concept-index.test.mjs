import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/BrainGrowth";
      export * from "./src/BrainGrowthIndex";
      export * from "./src/BrainGrowthPersistence";
      export * from "./src/ObsidianConceptIndex";
    `,
    resolveDir: process.cwd(),
    sourcefile: "obsidian-concept-index-entry.ts",
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
        contents: "module.exports = {};"
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
  JSON,
  encodeURIComponent,
  decodeURIComponent
});
const {
  createConceptNode,
  loadObsidianConceptIndex,
  lookupConceptByExactTitle,
  lookupConceptById,
  serializeConceptNodeIntoMarkdown
} = module.exports;

const createdAt = "2026-08-15T02:00:00.000Z";
const makeConcept = (id, title, alias) => createConceptNode({
  id,
  title,
  aliases: [alias],
  createdAt
});
const conceptA = makeConcept("concept-a", "Shared title", "alpha");
const conceptB = makeConcept("concept-b", "Shared title", "beta");
const persist = (candidateId, concept) => serializeConceptNodeIntoMarkdown(
  `# ${concept.title}\n\nReadable body.`,
  concept,
  { candidateId, candidateRevision: 0, approvedAt: createdAt }
);

const entries = [
  {
    file: { path: "Z/Ordinary.md" },
    markdown: "# Ordinary Markdown"
  },
  {
    // A renamed file still reloads its original stable identity.
    file: { path: "Lain Brain/Notes/Renamed A.md" },
    markdown: persist("candidate-a", conceptA)
  },
  {
    file: { path: "Lain Brain/Notes/B.md" },
    markdown: persist("candidate-b", conceptB)
  },
  {
    file: { path: "Lain Brain/Notes/Future.md" },
    markdown: persist("candidate-future", conceptA).replace(
      "lain-brain-concept-data:v1:",
      "lain-brain-concept-data:v9:"
    )
  },
  {
    file: { path: "Lain Brain/Notes/Unreadable.md" },
    markdown: "unreadable",
    unreadable: true
  }
];
const before = JSON.stringify(entries);
let reads = 0;
let writes = 0;
const app = {
  vault: {
    getMarkdownFiles: () => entries.map((entry) => entry.file).reverse(),
    cachedRead: async (file) => {
      reads += 1;
      const entry = entries.find((candidate) => candidate.file === file);
      if (entry.unreadable) {
        throw new Error("simulated read failure");
      }
      return entry.markdown;
    },
    create: async () => { writes += 1; throw new Error("unexpected write"); },
    modify: async () => { writes += 1; throw new Error("unexpected write"); },
    trash: async () => { writes += 1; throw new Error("unexpected write"); }
  }
};

const loaded = await loadObsidianConceptIndex(app);
assert.equal(loaded.scannedMarkdownFiles, entries.length);
assert.equal(reads, entries.length);
assert.equal(writes, 0);
assert.equal(loaded.records.length, 2);
assert.deepEqual(
  JSON.parse(JSON.stringify(
    loaded.records.map((record) => record.vaultPath)
  )),
  ["Lain Brain/Notes/B.md", "Lain Brain/Notes/Renamed A.md"]
);
assert.equal(
  lookupConceptById(loaded.index, "concept-a").match.concept.id,
  "concept-a"
);
assert.equal(
  lookupConceptByExactTitle(loaded.index, "Shared title").kind,
  "ambiguous_matches"
);
assert.deepEqual(
  JSON.parse(JSON.stringify(loaded.issues.map((item) => item.code))),
  ["unsupported_schema_version", "read_failed"]
);
assert.equal(JSON.stringify(entries), before);

console.log(JSON.stringify({
  scannedMarkdownFiles: loaded.scannedMarkdownFiles,
  loadedConcepts: loaded.records.length,
  ordinaryNotesIgnored: 1,
  renamedIdentityPreserved: true,
  ambiguousTitlePreserved: true,
  issues: loaded.issues.map((item) => item.code),
  vaultReads: reads,
  vaultWrites: writes,
  result: "PASS"
}, null, 2));
