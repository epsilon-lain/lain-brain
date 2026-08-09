import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { askDeepSeek, createNormalChatSystemPrompt } from './src/DeepSeekClient';",
      "export { LainBrainSession } from './src/LainBrainSession';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "chat-workflow-entry.ts",
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
          "exports.normalizePath = (value) => value;",
          "exports.requestUrl = async (options) => {",
          "  const body = JSON.parse(options.body);",
          "  globalThis.__lainBrainRequests.push(body);",
          "  const system = body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\\n');",
          "  let content = 'A natural conversational reply.';",
          "  if (system.includes('Extract every substantive, mutually independent discussion topic')) {",
          "    content = JSON.stringify({ topics: [{",
          "      title: 'Separation of Concerns',",
          "      conversationTopic: 'separation of concerns',",
          "      primaryConcept: 'separation of concerns',",
          "      aliases: ['separation of concerns'],",
          "      sourceMessageIds: ['message-1', 'message-2', 'message-3', 'message-4'],",
          "      activeNoteRelevant: false",
          "    }] });",
          "  } else if (system.includes('Your task is not ordinary question answering')) {",
          "    content = '# Separation of Concerns\\n\\nThe discussion separates responsibilities without adding external claims.';",
          "  }",
          "  return { json: { choices: [{ message: { content } }] } };",
          "};"
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
const requestLog = [];
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console,
  URL,
  Blob,
  crypto: { randomUUID: () => "test-id" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  setTimeout,
  clearTimeout,
  __lainBrainRequests: requestLog
});
const {
  askDeepSeek,
  createNormalChatSystemPrompt,
  LainBrainSession
} = module.exports;

const normalPrompt = createNormalChatSystemPrompt();
assert.match(normalPrompt, /ordinary Lain Brain conversation/);
assert.match(normalPrompt, /not candidate-note generation/);
assert.match(normalPrompt, /Do not automatically summarize/);
assert.match(normalPrompt, /Organize into Candidate Notes/);
assert.match(normalPrompt, /treat it as ordinary material to discuss/);

await askDeepSeek("test-key", [{
  role: "user",
  content: "Discuss this freely."
}]);
assert.equal(requestLog.length, 1);
assert.match(
  requestLog[0].messages[0].content,
  /ordinary Lain Brain conversation/
);
assert.doesNotMatch(
  requestLog[0].messages[0].content,
  /Extract every substantive, mutually independent discussion topic/
);
requestLog.length = 0;

const vaultWrites = [];
let markdownVaultScans = 0;
const app = {
  vault: {
    cachedRead: async () => "",
    getMarkdownFiles: () => {
      markdownVaultScans += 1;
      return [];
    },
    getFileByPath: () => null,
    getAbstractFileByPath: () => null,
    getFolderByPath: () => null,
    createFolder: async (path) => {
      vaultWrites.push({ operation: "createFolder", path });
    },
    create: async (path, content) => {
      vaultWrites.push({ operation: "create", path, content });
      return { path, basename: path.replace(/^.*\//, "").replace(/\.md$/i, "") };
    },
    modify: async (file, content) => {
      vaultWrites.push({ operation: "modify", path: file.path, content });
    },
    trash: async (file) => {
      vaultWrites.push({ operation: "trash", path: file.path });
    }
  },
  metadataCache: {
    getFirstLinkpathDest: () => null
  },
  workspace: {
    getLeaf: () => ({ openFile: async () => {} })
  }
};
const session = new LainBrainSession(
  app,
  () => "configured-key",
  () => null,
  { analyzeImage: async () => { throw new Error("Vision not expected"); } }
);
const loadingStates = [];
session.subscribe(() => {
  loadingStates.push({
    loadingMode: session.loadingMode,
    candidateLoading: session.candidateLoading
  });
});

session.setDraft("Let's discuss separation of concerns.");
assert.equal(await session.send(), "sent");
assert.equal(session.candidateCount, 0);
assert.equal(session.getCandidateNotes().length, 0);
assert.equal(session.getChatTranscriptMessages().some(
  (message) => message.content.includes("Organizing candidate notes...")
), false);
assert.equal(loadingStates.some((state) => state.candidateLoading), false);
assert.equal(vaultWrites.length, 0);
assert.equal(requestLog.length, 1);
assert.match(
  requestLog[0].messages[0].content,
  /ordinary Lain Brain conversation/
);

session.setDraft([
  "# ????",
  "",
  "## ????",
  "Please discuss this pasted Markdown as material."
].join("\n"));
assert.equal(await session.send(), "sent");
assert.equal(session.candidateCount, 0);
assert.equal(session.getCandidateNotes().length, 0);
assert.equal(vaultWrites.length, 0);
assert.equal(markdownVaultScans, 0);
assert.equal(requestLog.length, 2);
assert.equal(requestLog.some((request) =>
  request.messages.some((message) =>
    message.content.includes("Classify atomic claims")
  )
), false);
assert.match(
  requestLog[1].messages[0].content,
  /ordinary Lain Brain conversation/
);
assert.equal(
  session.getCandidateNotes().flatMap((candidate) => candidate.claims).length,
  0
);

loadingStates.length = 0;
requestLog.length = 0;
const organizeResult = await session.generateOrUpdateCandidateNotes();
assert.equal(organizeResult, "success");
assert.equal(session.candidateCount, 1);
assert.equal(session.getCandidateNotes()[0].claims.length, 0);
assert.equal(
  loadingStates.some((state) => state.candidateLoading),
  true
);
assert.equal(vaultWrites.length, 0);
const organizePrompts = requestLog.flatMap((request) =>
  request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
);
assert.equal(
  organizePrompts.some((prompt) =>
    prompt.includes(
      "Extract every substantive, mutually independent discussion topic"
    )
  ),
  true
);
assert.equal(
  organizePrompts.some((prompt) =>
    prompt.includes("Your task is not ordinary question answering")
  ),
  true
);

const viewSource = await import("node:fs/promises").then((fs) =>
  fs.readFile("src/LainBrainView.ts", "utf8")
);
const chatPanelSource = await import("node:fs/promises").then((fs) =>
  fs.readFile("src/LainBrainChatPanel.ts", "utf8")
);
const largeViewSource = await import("node:fs/promises").then((fs) =>
  fs.readFile("src/LainBrainLargeView.ts", "utf8")
);
assert.match(viewSource, /text: "Organize into Candidate Notes"/);
assert.match(
  viewSource,
  /generateOrUpdateCandidateNotes\(false\)/
);
assert.doesNotMatch(chatPanelSource, /classifyCandidateClaims|Review Claims/);
assert.match(largeViewSource, /text: "Review Claims"/);

console.log(JSON.stringify({
  normalChatPrompt: "PASS",
  normalSendCandidateCount: 0,
  pastedCandidateStyleCandidateCount: 0,
  normalSendClaimCount: 0,
  normalSendVaultWrites: 0,
  normalSendRelationScans: 0,
  normalSendCandidateLoadingObserved: false,
  organizeCandidateCount: session.candidateCount,
  organizeCandidatePromptObserved: true,
  organizeVaultWrites: vaultWrites.length,
  result: "PASS"
}, null, 2));
