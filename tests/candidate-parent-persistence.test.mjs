import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export { LainBrainSession } from "./src/LainBrainSession";
      export { discoverCandidateParents } from "./src/CandidateParentDiscovery";
      export {
        buildCandidateGroupParentMarkdown
      } from "./src/CandidateGroupVault";
    `,
    resolveDir: process.cwd(),
    sourcefile: "parent-persistence-entry.ts",
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
        contents: `
          exports.normalizePath = (value) => value.replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");
          exports.requestUrl = async () => { throw new Error("DeepSeek must not be called"); };
        `
      }));
    }
  }]
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  DOMMatrix: class { constructor(){} },
  module, exports: module.exports, require, console, setTimeout, clearTimeout
});
const {
  LainBrainSession,
  buildCandidateGroupParentMarkdown,
  discoverCandidateParents
} = module.exports;

function makeFile(path, content = "") {
  return {
    file: {
      path,
      basename: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "")
    },
    content
  };
}

function makeApp(entries) {
  const files = new Map(entries.map((entry) => [entry.file.path, entry]));
  const folders = new Set(["Lain Brain", "Lain Brain/Notes"]);
  const resolve = (target, sourcePath) => {
    const markdownTarget = target.toLowerCase().endsWith(".md")
      ? target
      : `${target}.md`;
    const folder = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
    return files.get(markdownTarget)?.file ??
      files.get(`${folder}/${markdownTarget}`)?.file ?? null;
  };
  const vault = {
    getMarkdownFiles: () => [...files.values()].map((entry) => entry.file),
    getFileByPath: (path) => files.get(path)?.file ?? null,
    getAbstractFileByPath: (path) =>
      files.get(path)?.file ?? (folders.has(path) ? { path } : null),
    getFolderByPath: (path) => folders.has(path) ? { path } : null,
    cachedRead: async (file) => files.get(file.path).content,
    createFolder: async (path) => folders.add(path),
    create: async (path, content) => {
      assert.equal(files.has(path), false, `unexpected overwrite: ${path}`);
      const entry = makeFile(path, content);
      files.set(path, entry);
      return entry.file;
    },
    modify: async (file, content) => { files.get(file.path).content = content; },
    trash: async (file) => files.delete(file.path)
  };
  return {
    app: {
      vault,
      metadataCache: { getFirstLinkpathDest: resolve },
      workspace: { getLeaf: () => ({ openFile: async () => {} }) }
    },
    files
  };
}

const newParentPath = "Lain Brain/Notes/Operators on Inner Product Spaces.md";
const newParentMarkdown = buildCandidateGroupParentMarkdown(
  "Operators on Inner Product Spaces",
  "stable-group-42",
  ["Adjoint Operator", "Normal Operators"]
);
assert.match(newParentMarkdown, /lain-brain-type: candidate-group-parent/);
assert.match(newParentMarkdown, /lain-brain-group-id: "stable-group-42"/);
const reloadFixture = makeApp([
  makeFile(newParentPath, newParentMarkdown),
  makeFile("Lain Brain/Notes/Adjoint Operator.md"),
  makeFile("Lain Brain/Notes/Normal Operators.md")
]);
const reloadedParents = await discoverCandidateParents(reloadFixture.app);
assert.deepEqual(
  JSON.parse(JSON.stringify(reloadedParents)),
  [{
    groupId: "stable-group-42",
    parentVaultPath: newParentPath,
    parentDisplayTitle: "Operators on Inner Product Spaces",
    legacy: false
  }]
);

const legacyParentPath =
  "Lain Brain/Notes/I am building one parent knowledge node named -Inner Product Spaces-.md";
const legacyMarkdown = [
  "# Inner Product Spaces",
  "",
  "## Child notes",
  "",
  "- [[Adjoint Operator]]",
  "- [[Self-adjoint Operators]]",
  "- [[Normal Operators]]",
  "- [[Unitary Operators]]",
  "- [[Orthogonal Projections]]",
  "- [[Positive Operators]]",
  ""
].join("\n");
const childTitles = [
  "Adjoint Operator",
  "Self-adjoint Operators",
  "Normal Operators",
  "Unitary Operators",
  "Orthogonal Projections",
  "Positive Operators"
];
const legacyFixture = makeApp([
  makeFile(legacyParentPath, legacyMarkdown),
  ...childTitles.map((title) =>
    makeFile(`Lain Brain/Notes/${title}.md`)
  )
]);
const legacyParents = await discoverCandidateParents(legacyFixture.app);
assert.equal(legacyParents.length, 1);
assert.equal(legacyParents[0].parentDisplayTitle, "Inner Product Spaces");
assert.equal(legacyParents[0].parentVaultPath, legacyParentPath);

const emptyFixture = makeApp([]);
assert.equal((await discoverCandidateParents(emptyFixture.app)).length, 0);

const session = new LainBrainSession(legacyFixture.app, () => "unused");
const availableAfterReload = await session.discoverCandidateParentGroups();
assert.equal(availableAfterReload.length, 1);
const parent = availableAfterReload[0];
const originalMarkdown = "# The Cauchy–Schwarz Inequality\n\nBody.";
const candidate = {
  id: "candidate-cauchy",
  title: "The Cauchy–Schwarz Inequality",
  primaryConcept: {
    name: "The Cauchy–Schwarz Inequality",
    aliases: ["Cauchy–Schwarz"]
  },
  markdown: originalMarkdown,
  sourceMessageIds: ["message-1"],
  viewMode: "preview",
  userEdited: false,
  revision: 0
};
session.candidates = [candidate];
session.activeCandidateId = candidate.id;
const createResult = await session.createCandidateNote(
  candidate.id,
  candidate.title,
  "Lain Brain/Notes",
  { groupId: parent.id, parentVaultPath: parent.parentVaultPath }
);
assert.equal(createResult.ok, true);
const childPath = "Lain Brain/Notes/The Cauchy–Schwarz Inequality.md";
const childMarkdown = legacyFixture.files.get(childPath).content;
const exactParentLink =
  `Parent: [[${legacyParentPath.replace(/\.md$/i, "")}|Inner Product Spaces]]`;
assert.equal(childMarkdown.includes(exactParentLink), true);
const updatedParent = legacyFixture.files.get(legacyParentPath).content;
assert.equal(
  updatedParent.split(/\r?\n/).filter((line) =>
    line.includes("The Cauchy–Schwarz Inequality")
  ).length,
  1
);
assert.equal(
  legacyFixture.files.has("Lain Brain/Notes/Inner Product Spaces.md"),
  false
);

console.log(JSON.stringify({
  durableReload: "PASS",
  legacyParent: {
    label: parent.parentDisplayTitle,
    groupId: parent.id,
    parentVaultPath: parent.parentVaultPath
  },
  emptyVaultDiscoveredParents: 0,
  graphEdgeCount: 1,
  ghostParentCreated: false,
  result: "PASS"
}, null, 2));
