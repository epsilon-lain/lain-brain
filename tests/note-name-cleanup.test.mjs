import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export { LainBrainSession } from "./src/LainBrainSession";
      export {
        applyNoteNameCleanup,
        discoverNoteNameCleanupReview
      } from "./src/NoteNameCleanup";
      export { discoverCandidateParents } from "./src/CandidateParentDiscovery";
      export {
        normalizeCandidatePrimaryConcept,
        normalizeCandidateTitle
      } from "./src/CandidateNoteRelations";
    `,
    resolveDir: process.cwd(),
    sourcefile: "note-name-cleanup-entry.ts",
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
  module, exports: module.exports, require, console, setTimeout, clearTimeout
});
const {
  LainBrainSession,
  applyNoteNameCleanup,
  discoverCandidateParents,
  discoverNoteNameCleanupReview,
  normalizeCandidatePrimaryConcept,
  normalizeCandidateTitle
} = module.exports;

const legacyPath =
  "Lain Brain/Notes/I am building one parent knowledge node named -Inner Product Spaces-.md";
const cleanPath = "Lain Brain/Notes/Inner Product Spaces.md";
const childTitles = [
  "Adjoint Operator",
  "Self-adjoint Operators",
  "Normal Operators",
  "Unitary Operators",
  "Orthogonal Projections",
  "Positive Operators"
];
const unrelatedPath =
  "Lain Brain/Notes/Please rename this unrelated personal journal entry because it is intentionally very long.md";

function makeFile(path, content = "") {
  return {
    file: {
      path,
      basename: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "")
    },
    content
  };
}

function makeFixture(includeCollision = false) {
  const legacyMarkdown = [
    "# Inner Product Spaces",
    "",
    "## Child notes",
    "",
    ...childTitles.map((title) => `- [[${title}]]`),
    ""
  ].join("\n");
  const entries = [
    makeFile(legacyPath, legacyMarkdown),
    ...childTitles.map((title, index) => makeFile(
      `Lain Brain/Notes/${title}.md`,
      [
        `# ${title}`,
        "",
        `Parent: [[${legacyPath.replace(/\.md$/i, "")}|Inner Product Spaces]]`,
        index === 0
          ? "[[Please create a missing knowledge node with an extremely long unresolved target that should only be reviewed later]]"
          : ""
      ].join("\n")
    )),
    makeFile(unrelatedPath, "# Personal journal\n")
  ];

  if (includeCollision) {
    entries.push(makeFile(cleanPath, "# Existing collision\n"));
  }

  const files = new Map(entries.map((entry) => [entry.file.path, entry]));
  const folders = new Set(["Lain Brain", "Lain Brain/Notes"]);
  const renameCalls = [];
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
    create: async () => { throw new Error("create must not be called"); },
    modify: async () => { throw new Error("modify must not be called"); },
    trash: async () => { throw new Error("trash must not be called"); }
  };
  const fileManager = {
    renameFile: async (file, targetPath) => {
      renameCalls.push({ sourcePath: file.path, targetPath });
      const sourcePath = file.path;
      const entry = files.get(sourcePath);
      files.delete(sourcePath);
      const oldTarget = sourcePath.replace(/\.md$/i, "");
      const newTarget = targetPath.replace(/\.md$/i, "");
      file.path = targetPath;
      file.basename = targetPath
        .slice(targetPath.lastIndexOf("/") + 1)
        .replace(/\.md$/i, "");
      files.set(targetPath, entry);

      for (const stored of files.values()) {
        stored.content = stored.content
          .split(`[[${oldTarget}`)
          .join(`[[${newTarget}`);
      }
    }
  };
  return {
    app: {
      vault,
      fileManager,
      metadataCache: { getFirstLinkpathDest: resolve },
      workspace: { getLeaf: () => ({ openFile: async () => {} }) }
    },
    files,
    renameCalls
  };
}

const fixture = makeFixture();
const session = new LainBrainSession(fixture.app, () => "unused");
session.candidateGroups = [{
  id: "legacy-parent-qx9dsz",
  title: "Inner Product Spaces",
  sourceMessageIds: [],
  candidateIds: [],
  revision: 0,
  createdVaultPath: legacyPath,
  parentVaultPath: legacyPath,
  parentDisplayTitle: "Inner Product Spaces"
}];
session.candidates = [{
  id: "session-child",
  title: "Adjoint Operator",
  primaryConcept: { name: "Adjoint Operator", aliases: [] },
  markdown: "# Adjoint Operator",
  sourceMessageIds: [],
  viewMode: "preview",
  userEdited: false,
  revision: 0,
  createdVaultPath: "Lain Brain/Notes/Adjoint Operator.md",
  parentGroupId: "legacy-parent-qx9dsz",
  parentVaultPath: legacyPath
}];

const review = await discoverNoteNameCleanupReview(fixture.app, session);
assert.equal(review.proposals.length, 1);
assert.deepEqual(
  JSON.parse(JSON.stringify(review.proposals[0])),
  {
    sourcePath: legacyPath,
    currentFileName:
      "I am building one parent knowledge node named -Inner Product Spaces-.md",
    suggestedFileName: "Inner Product Spaces.md",
    reason: "Filename contains instruction boilerplate"
  }
);
assert.equal(
  review.proposals.some((proposal) => proposal.sourcePath === unrelatedPath),
  false
);
assert.equal(review.futureReviewItems.length, 1);

const uncheckedResult = await applyNoteNameCleanup(
  fixture.app,
  session,
  []
);
assert.equal(uncheckedResult.length, 0);
assert.equal(fixture.renameCalls.length, 0);
assert.equal(fixture.files.has(legacyPath), true);

const renameResult = await applyNoteNameCleanup(
  fixture.app,
  session,
  [{ sourcePath: legacyPath, targetFileName: "Inner Product Spaces.md" }]
);
assert.equal(renameResult[0].ok, true);
assert.equal(fixture.renameCalls.length, 1);
assert.equal(fixture.files.has(legacyPath), false);
assert.equal(fixture.files.has(cleanPath), true);
assert.equal(fixture.files.has(unrelatedPath), true);
assert.equal(session.candidateGroups[0].parentVaultPath, cleanPath);
assert.equal(session.candidates[0].parentVaultPath, cleanPath);

const expectedParentLine =
  "Parent: [[Lain Brain/Notes/Inner Product Spaces|Inner Product Spaces]]";
for (const title of childTitles) {
  assert.equal(
    fixture.files.get(`Lain Brain/Notes/${title}.md`).content
      .includes(expectedParentLine),
    true
  );
}
const rediscovered = await discoverCandidateParents(fixture.app);
assert.equal(rediscovered.length, 1);
assert.equal(rediscovered[0].parentVaultPath, cleanPath);
assert.equal(rediscovered[0].parentDisplayTitle, "Inner Product Spaces");

const collisionFixture = makeFixture(true);
const collisionSession = new LainBrainSession(
  collisionFixture.app,
  () => "unused"
);
const collisionResult = await applyNoteNameCleanup(
  collisionFixture.app,
  collisionSession,
  [{ sourcePath: legacyPath, targetFileName: "Inner Product Spaces.md" }]
);
assert.equal(collisionResult[0].ok, false);
assert.equal(collisionResult[0].message, "Target note already exists");
assert.equal(collisionFixture.renameCalls.length, 0);
assert.equal(collisionFixture.files.has(legacyPath), true);

const longTitle = normalizeCandidateTitle(
  "A generated candidate title that is intentionally much longer than seventy characters and must never become a long graph label"
);
assert.equal(longTitle.length <= 70, true);
const concept = normalizeCandidatePrimaryConcept({
  name: "A very long primary concept sentence that explains far too much and should never become a graph label because it exceeds the limit",
  aliases: []
}, "Cauchy–Schwarz Inequality");
assert.equal(concept.name.length <= 60, true);
assert.equal(concept.name, "Cauchy–Schwarz Inequality");

console.log(JSON.stringify({
  proposedRename: review.proposals[0],
  uncheckedRenameCalls: 0,
  collisionBlocked: true,
  childLinksUpdated: childTitles.length,
  parentDiscoverableAfterReload: true,
  unrelatedNotesTouched: 0,
  candidateTitleLength: longTitle.length,
  primaryConceptLength: concept.name.length,
  futureReviewItems: review.futureReviewItems.length,
  result: "PASS"
}, null, 2));
