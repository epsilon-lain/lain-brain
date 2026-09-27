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
const speechSynthesis = {
  cancel() {},
  speak(utterance) { spoken.push(utterance.text); },
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

console.log("speech-read-aloud: ok");
