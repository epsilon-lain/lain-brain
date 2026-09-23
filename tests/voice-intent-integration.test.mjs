import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  entryPoints: ["src/LainBrainSession.ts"], bundle: true,
  platform: "node", format: "cjs", write: false,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian", namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: "exports.requestUrl = async () => { throw Error('unexpected network'); };"
      }));
    }
  }]
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports, require, URL, URLSearchParams,
  DOMMatrix: class { constructor() {} },
  crypto: { randomUUID: () => "intent-test" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  setTimeout, clearTimeout, console
});
const { LainBrainSession } = module.exports;

function makeSession() {
  const app = {
    vault: { cachedRead: async () => "", getMarkdownFiles: () => [],
      getFileByPath: () => null, getAbstractFileByPath: () => null },
    metadataCache: { getFirstLinkpathDest: () => null },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) }
  };
  const session = new LainBrainSession(app, () => "deepseek-key", () => null,
    undefined, async () => "response");
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  return session;
}

const session = makeSession();
let jevCalls = 0;
session.setVoiceIntentServices({
  clean: async (raw) => ({ cleanedText:
    raw === "erase second" ? "remove line 2" :
      raw === "an idea uh" ? "an idea." : raw,
    possibleMacro: raw === "Cut. Cut." }),
  classify: async () => { jevCalls++; return "command"; }
});
assert.equal((await session.ingestVoiceTurnWithIntent("an idea uh", undefined, "a:1")).kind, "appended");
assert.equal(session.getChatSpaceText(), "an idea.");
assert.equal(jevCalls, 0);
assert.equal((await session.ingestVoiceTurnWithIntent("ka", undefined, "a:2")).kind, "executed");
await session.submitChatSpace();
assert.equal(jevCalls, 0, "exact macro needs no classifier");
assert.equal(session.getChatTranscriptMessages()
  .filter((message) => message.role === "user")[0].content, "an idea.");

session.appendKeyboardChatSpaceText("draft");
assert.equal((await session.ingestVoiceTurnWithIntent("Cut. Cut.", undefined, "a:3")).kind, "executed");
await session.submitChatSpace();
assert.equal(jevCalls, 1);
assert.equal(session.getChatTranscriptMessages()
  .filter((message) => message.role === "user")[1].content, "draft");
assert.equal((await session.ingestVoiceTurnWithIntent("Cut. Cut.", undefined, "a:3")).kind, "ignored");

session.setVoiceIntentServices({
  clean: async (raw) => ({ cleanedText: raw, possibleMacro: true }),
  classify: async () => "uncertain"
});
assert.equal((await session.ingestVoiceTurnWithIntent("cut", undefined, "a:4")).kind, "review");
assert.equal(session.getChatSpaceText(), "");
assert.equal(session.getVoiceSubmitReview().commandText, "ka");
assert.equal(session.resolveVoiceSubmitReview("keep"), true);
assert.equal(session.getChatSpaceText(), "cut");

session.clearChat();
session.appendKeyboardChatSpaceText("reviewed draft");
assert.equal((await session.ingestVoiceTurnWithIntent("cut", undefined, "a:review-submit")).kind, "review");
assert.equal(session.resolveVoiceSubmitReview("submit"), true);
await session.submitChatSpace();
assert.equal(session.getChatTranscriptMessages()
  .filter((message) => message.role === "user").at(-1).content,
  "reviewed draft");

const custom = makeSession();
custom.setMacroRegistry({ schemaVersion: 1, definitionPhrase: "定义宏", macros: [{
  id: "remove-line", name: "Remove line",
  patterns: [{ kind: "parameterized", template: "remove line {n}",
    parameters: [{ name: "n", type: "integer", min: 1 }] }],
  parameters: [{ name: "n", type: "integer", min: 1 }],
  actions: [{ kind: "delete_segment", line: { parameter: "n" } }],
  writesToChat: false, undoable: true,
  confirmation: { kind: "never" }, enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1
}] });
custom.appendKeyboardChatSpaceText("first");
custom.appendKeyboardChatSpaceText("second");
custom.setVoiceIntentServices({
  clean: async (raw) => ({ cleanedText: raw, possibleMacro: true,
    candidateText: "remove line 2" }),
  classify: async () => "command"
});
assert.equal((await custom.ingestVoiceTurnWithIntent("delete the second line", undefined, "m:1")).kind, "executed");
assert.equal(custom.getChatSpaceText(), "first");
custom.setVoiceIntentServices({
  clean: async (raw) => ({ cleanedText: raw, possibleMacro: true,
    candidateText: "run shell command" }),
  classify: async () => { throw Error("unregistered candidate reached Jev"); }
});
assert.equal((await custom.ingestVoiceTurnWithIntent("ordinary line", undefined, "m:2")).kind, "appended");
assert.equal(custom.getChatSpaceText(), "first\nordinary line");

const overlapping = makeSession();
let finishAnswer;
overlapping.askText = () => new Promise((resolve) => {
  finishAnswer = resolve;
});
overlapping.setVoiceIntentServices({
  clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
  classify: async () => "text"
});
overlapping.appendKeyboardChatSpaceText("send this");
await overlapping.ingestVoiceTurnWithIntent("ka", undefined, "o:1");
assert.equal((await overlapping.ingestVoiceTurnWithIntent("next thought", undefined, "o:2")).kind, "ignored");
finishAnswer("answer");
await overlapping.submitChatSpace();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(overlapping.getChatSpaceText(), "next thought",
  "a later voice turn must survive an in-flight Brain send");

let resolveCleaning;
session.setVoiceIntentServices({
  clean: () => new Promise((resolve) => { resolveCleaning = resolve; }),
  classify: async () => "text"
});
const delayed = session.ingestVoiceTurnWithIntent("old thought", undefined, "a:5");
session.clearChat();
resolveCleaning({ cleanedText: "old thought", possibleMacro: false });
assert.equal((await delayed).kind, "ignored");
assert.equal(session.getChatSpaceText(), "");
console.log("Voice intent integration tests passed.");
