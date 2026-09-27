import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: {
    contents: `
      export { LocalVoiceVerifier } from "./src/LocalVoiceVerifier";
      export {
        VoiceBlindEvaluator,
        VOICE_ACCEPTANCE_CRITERIA
      } from "./src/VoiceBlindEvaluator";
    `,
    resolveDir: process.cwd(),
    sourcefile: "voice-blind-evaluator-entry.ts",
    loader: "ts"
  },
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
const {
  LocalVoiceVerifier,
  VoiceBlindEvaluator,
  VOICE_ACCEPTANCE_CRITERIA
} = module.exports;

function burst(frequency, durationMs, rate = 16000) {
  const samples = new Float32Array(Math.floor((durationMs / 1000) * rate));
  const gap = Math.floor(30 / 1000 * rate);
  for (let index = 0; index < samples.length; index += 1) {
    const inGap = index % Math.floor(80 / 1000 * rate) >= gap;
    samples[index] = inGap
      ? Math.sin((2 * Math.PI * frequency * index) / rate)
      : 0;
  }
  return samples;
}

function tone(frequency, durationMs, rate = 16000) {
  const samples = new Float32Array(Math.floor((durationMs / 1000) * rate));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / rate);
  }
  return samples;
}

const verifier = new LocalVoiceVerifier();
verifier.addSample("m1", "positive", burst(520, 240));
verifier.addSample("m1", "positive", burst(480, 260));
verifier.addSample("m1", "positive", burst(540, 250));
verifier.addSample("m1", "negative", tone(170, 500));
verifier.addSample("m1", "negative", tone(190, 460));
verifier.addSample("m1", "negative", tone(200, 480));

const evaluator = new VoiceBlindEvaluator(verifier);
assert.equal(evaluator.evaluate("m1").waitingForRealData, true);
assert.equal(evaluator.evaluate("m1").passed, false);
assert.equal(verifier.status("m1").proven, false);

assert.equal(VOICE_ACCEPTANCE_CRITERIA.maxFalsePositiveRate, 0.05);
assert.equal(VOICE_ACCEPTANCE_CRITERIA.maxFalseNegativeRate, 0.05);
assert.equal(VOICE_ACCEPTANCE_CRITERIA.maxLatencyP95Ms, 2000);

console.log("voice-blind-evaluator: ok (waiting for real data)");
