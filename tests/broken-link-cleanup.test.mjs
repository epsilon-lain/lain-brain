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
        applyBrokenLinkCleanup,
        discoverBrokenLinkCleanupReview
      } from "./src/BrokenLinkCleanup";
    `,
    resolveDir: process.cwd(),
    sourcefile: "broken-link-cleanup-entry.ts",
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
  applyBrokenLinkCleanup,
  discoverBrokenLinkCleanupReview
} = module.exports;

const parentPath = "Lain Brain/Notes/Inner Product Spaces.md";
const childPath = "Lain Brain/Notes/Normal Operators.md";
const secondChildPath = "Lain Brain/Notes/Adjoint Operator.md";
const unrelatedPath = "Lain Brain/Notes/Unrelated Journal.md";
const longSentence =
  "A normal operator commutes with its adjoint: TT* = T*T, which characterizes unitarily diagonalizable operators.";
const longLink = `[[${longSentence}]]`;
const aliasTarget =
  "Please create a concept note from this very long instruction-like sentence because it is not a real node";
const aliasLink = `[[${aliasTarget}|Keep this visible label]]`;
const codeLink =
  "[[This very long wikilink is inside fenced code and must never be changed by cleanup]]";
const mathLink =
  "[[This very long wikilink is inside display math and must never be changed by cleanup]]";
const bracketMathLink =
  "[[This very long wikilink is inside bracket display math and must remain unchanged]]";

function makeFile(path, content = "") {
  return {
    file: {
      path,
      basename: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "")
    },
    content
  };
}

function makeFixture() {
  const parentMarkdown = [
    "# Inner Product Spaces",
    "",
    "## Child notes",
    "",
    "- [[Normal Operators]]",
    "- [[Adjoint Operator]]",
    ""
  ].join("\n");
  const childMarkdown = [
    "# Normal Operators",
    "",
    "中文前文保持不变。",
    `Parent: [[${parentPath.replace(/\.md$/i, "")}|Inner Product Spaces]]`,
    "Related: [[Adjoint Operator]]",
    "Intentional future node: [[Future Concept]]",
    `Broken: ${longLink}`,
    `Alias broken: ${aliasLink}`,
    "",
    "```text",
    codeLink,
    "```",
    "",
    "$$",
    mathLink,
    "$$",
    "",
    "\\[",
    bracketMathLink,
    "\\]",
    "",
    "LaTeX outside links stays byte-for-byte: $T^{\\mathsf{T}}T$.",
    "中文后文保持不变。",
    ""
  ].join("\n");
  const unrelatedMarkdown = `# Unrelated\n\n${longLink}\n`;
  const entries = [
    makeFile(parentPath, parentMarkdown),
    makeFile(childPath, childMarkdown),
    makeFile(secondChildPath, "# Adjoint Operator\n"),
    makeFile(unrelatedPath, unrelatedMarkdown)
  ];
  const files = new Map(entries.map((entry) => [entry.file.path, entry]));
  const modifyCalls = [];
  const resolve = (target, sourcePath) => {
    const linkPath = target.split("#", 1)[0];
    const markdownPath = linkPath.toLowerCase().endsWith(".md")
      ? linkPath
      : `${linkPath}.md`;
    const folder = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
    return files.get(markdownPath)?.file ??
      files.get(`${folder}/${markdownPath}`)?.file ?? null;
  };
  const vault = {
    getMarkdownFiles: () => [...files.values()].map((entry) => entry.file),
    getFileByPath: (path) => files.get(path)?.file ?? null,
    getAbstractFileByPath: (path) => files.get(path)?.file ?? null,
    cachedRead: async (file) => files.get(file.path).content,
    modify: async (file, content) => {
      modifyCalls.push({ path: file.path, content });
      files.get(file.path).content = content;
    },
    create: async () => { throw new Error("create must not be called"); },
    createFolder: async () => { throw new Error("createFolder must not be called"); },
    trash: async () => { throw new Error("trash must not be called"); }
  };
  return {
    app: {
      vault,
      metadataCache: { getFirstLinkpathDest: resolve },
      fileManager: {
        renameFile: async () => { throw new Error("renameFile must not be called"); }
      },
      workspace: { getLeaf: () => ({ openFile: async () => {} }) }
    },
    files,
    modifyCalls,
    originalChildMarkdown: childMarkdown
  };
}

const fixture = makeFixture();
const session = new LainBrainSession(fixture.app, () => "unused");
const proposals = await discoverBrokenLinkCleanupReview(
  fixture.app,
  session
);
assert.equal(proposals.length, 2);
assert.equal(
  proposals.every((proposal) => proposal.sourcePath === childPath),
  true
);
const sentenceProposal = proposals.find(
  (proposal) => proposal.currentWikiLink === longLink
);
const aliasProposal = proposals.find(
  (proposal) => proposal.currentWikiLink === aliasLink
);
assert.ok(sentenceProposal);
assert.ok(aliasProposal);
assert.equal(sentenceProposal.proposedReplacement, longSentence);
assert.equal(aliasProposal.proposedReplacement, "Keep this visible label");
assert.equal(
  proposals.some((proposal) => proposal.currentWikiLink === codeLink),
  false
);
assert.equal(
  proposals.some((proposal) => proposal.currentWikiLink === mathLink),
  false
);
assert.equal(
  proposals.some((proposal) => proposal.currentWikiLink === bracketMathLink),
  false
);

const unchecked = await applyBrokenLinkCleanup(fixture.app, session, []);
assert.equal(unchecked.length, 0);
assert.equal(fixture.modifyCalls.length, 0);
assert.equal(fixture.files.get(childPath).content, fixture.originalChildMarkdown);

const expectedAfter =
  fixture.originalChildMarkdown.slice(0, sentenceProposal.startOffset) +
  longSentence +
  fixture.originalChildMarkdown.slice(sentenceProposal.endOffset);
const result = await applyBrokenLinkCleanup(
  fixture.app,
  session,
  [{
    id: sentenceProposal.id,
    sourcePath: sentenceProposal.sourcePath,
    startOffset: sentenceProposal.startOffset,
    endOffset: sentenceProposal.endOffset,
    currentWikiLink: sentenceProposal.currentWikiLink,
    replacement: sentenceProposal.proposedReplacement
  }]
);
assert.equal(result[0].ok, true);
assert.equal(fixture.modifyCalls.length, 1);
assert.equal(fixture.files.get(childPath).content, expectedAfter);
assert.equal(fixture.files.get(childPath).content.includes(longSentence), true);
assert.equal(fixture.files.get(childPath).content.includes(longLink), false);
assert.equal(fixture.files.get(childPath).content.includes(aliasLink), true);
assert.equal(fixture.files.get(childPath).content.includes("[[Future Concept]]"), true);
assert.equal(fixture.files.get(childPath).content.includes(codeLink), true);
assert.equal(fixture.files.get(childPath).content.includes(mathLink), true);
assert.equal(fixture.files.get(childPath).content.includes(bracketMathLink), true);
assert.equal(
  fixture.files.get(childPath).content.includes(
    `Parent: [[${parentPath.replace(/\.md$/i, "")}|Inner Product Spaces]]`
  ),
  true
);
assert.equal(
  fixture.files.get(childPath).content.includes("Related: [[Adjoint Operator]]"),
  true
);
assert.equal(
  fixture.files.get(unrelatedPath).content,
  `# Unrelated\n\n${longLink}\n`
);

const staleFixture = makeFixture();
const staleSession = new LainBrainSession(staleFixture.app, () => "unused");
const staleProposal = (await discoverBrokenLinkCleanupReview(
  staleFixture.app,
  staleSession
)).find((proposal) => proposal.currentWikiLink === longLink);
assert.ok(staleProposal);
staleFixture.files.get(childPath).content =
  "Manual edit before review application.\n" +
  staleFixture.files.get(childPath).content;
const staleResult = await applyBrokenLinkCleanup(
  staleFixture.app,
  staleSession,
  [{
    id: staleProposal.id,
    sourcePath: staleProposal.sourcePath,
    startOffset: staleProposal.startOffset,
    endOffset: staleProposal.endOffset,
    currentWikiLink: staleProposal.currentWikiLink,
    replacement: staleProposal.proposedReplacement
  }]
);
assert.equal(staleResult[0].ok, false);
assert.equal(staleResult[0].message, "Source content changed; repair skipped");
assert.equal(staleFixture.modifyCalls.length, 0);
assert.equal(staleFixture.files.get(childPath).content.includes(longLink), true);

console.log(JSON.stringify({
  detectedProposals: proposals.length,
  approvedLongLinkBecamePlainText: true,
  visibleSentencePreserved: true,
  uncheckedRowsModified: 0,
  validLinksChanged: 0,
  shortUnresolvedLinksChanged: 0,
  protectedCodeOrMathLinksChanged: 0,
  unrelatedNotesChanged: 0,
  staleContentOverwritten: false,
  result: "PASS"
}, null, 2));
