import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: {
    contents: `export { LainBrainSession } from "./src/LainBrainSession";`,
    resolveDir: process.cwd(),
    sourcefile: "speech-read-aloud-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian", namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: `exports.requestUrl = async () => { throw Error("unexpected network"); };`
      }));
    }
  }]
});

const spoken = [];
const utterances = [];
let cancels = 0;
const speechSynthesis = {
  cancel() { cancels += 1; },
  speak(utterance) { spoken.push(utterance.text); utterances.push(utterance); },
  getVoices() { return []; }
};
class SpeechSynthesisUtterance {
  constructor(text) { this.text = text; }
}

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require: createRequire(import.meta.url),
  setTimeout,
  clearTimeout,
  speechSynthesis,
  SpeechSynthesisUtterance,
  DOMMatrix: class {},
  console
});

const { LainBrainSession } = module.exports;
function makeApp() {
  return {
    vault: { cachedRead: async () => "", getMarkdownFiles: () => [],
      getFileByPath: () => null, getAbstractFileByPath: () => null },
    metadataCache: { getFirstLinkpathDest: () => null },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) }
  };
}
function makeSession() {
  const session = new LainBrainSession(makeApp(), () => "key", () => null,
    undefined, async () => "answer");
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  session.setVoiceAnswerReadAloudEnabled(true);
  return session;
}

// Voice ka triggers read aloud exactly once.
{
  const session = makeSession();
  session.appendKeyboardChatSpaceText("question");
  session.ingestFinalizedVoiceTurn("ka", undefined, "v:1");
  await session.submitChatSpace();
  assert.equal(spoken.at(-1), "answer");
}

// Keyboard ka does not read aloud.
{
  spoken.length = 0;
  const session = makeSession();
  session.appendKeyboardChatSpaceText("question");
  session.ingestKeyboardChatSpaceTurn("ka");
  await session.submitChatSpace();
  assert.equal(spoken.length, 0);
}

// Speaking while Brain reads stops playback before the turn is finalized.
{
  const session = makeSession();
  session.appendKeyboardChatSpaceText("question");
  session.ingestFinalizedVoiceTurn("ka", undefined, "v:2");
  await session.submitChatSpace();
  const before = cancels;
  session.getVoiceInput().callbacks.onPartialTranscript("我要说话");
  assert.equal(cancels, before + 1);
  assert.equal(session.getSpeechReadAloudStatus(), "stopped");
  utterances.at(-1).onend();
  assert.equal(session.getSpeechReadAloudStatus(), "stopped");
  session.getVoiceInput().callbacks.onFinalizedTurn({
    sessionId: "v", turnOrder: 3, turnId: "v:3", transcript: "我要说话。继续思考"
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.getChatSpace().some((segment) => segment.text === "我要说话"), false);
  assert.equal(session.getChatSpace().some((segment) => segment.text === "继续思考"), true);
}

console.log("speech-read-aloud: ok");
