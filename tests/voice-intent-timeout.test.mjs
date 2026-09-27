import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  entryPoints: ["src/VoiceIntentBuffer.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  setTimeout,
  clearTimeout
});
const { VoiceIntentBuffer } = module.exports;

// Classifier never resolves: budget expiry falls back to the original turn.
const buffer = new VoiceIntentBuffer(
  {
    clean: async () => ({
      cleanedText: "cut",
      possibleMacro: true,
      candidateText: "ka"
    }),
    classify: () => new Promise(() => {})
  },
  () => false,
  () => ({ command: "ka", candidate: "ka", body: "" }),
  () => ["ka"]
);

const decision = await buffer.interpret("cut", 1);
assert.equal(decision.kind, "text");
assert.equal(decision.text, "cut");

console.log("voice-intent-timeout: ok");
