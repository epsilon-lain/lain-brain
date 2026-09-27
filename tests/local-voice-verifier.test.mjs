import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: {
    contents: `
      export { LocalVoiceVerifier } from "./src/LocalVoiceVerifier";
      export { VoiceAudioRingBuffer } from "./src/VoiceAudioRingBuffer";
    `,
    resolveDir: process.cwd(),
    sourcefile: "local-voice-verifier-entry.ts",
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
const { LocalVoiceVerifier, VoiceAudioRingBuffer } = module.exports;

function tone(frequency, durationMs, rate = 16000) {
  const length = Math.floor((durationMs / 1000) * rate);
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / rate);
  }
  return samples;
}

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

const verifier = new LocalVoiceVerifier();
assert.equal(verifier.status("m1").calibrated, false);
verifier.addSample("m1", "positive", burst(520, 240));
verifier.addSample("m1", "positive", burst(480, 260));
verifier.addSample("m1", "positive", burst(540, 250));
assert.equal(verifier.status("m1").calibrated, false);
verifier.addSample("m1", "negative", tone(170, 500));
verifier.addSample("m1", "negative", tone(190, 460));
verifier.addSample("m1", "negative", tone(200, 480));
assert.equal(verifier.status("m1").calibrated, true);
assert.equal(verifier.verify("m1", burst(500, 250)).decision, "uncertain");
verifier.markProven("m1", {
  falsePositiveCount: 0,
  falseNegativeCount: 0,
  totalCount: 10,
  passed: true,
  reason: "synthetic gate test"
});
assert.equal(verifier.verify("m1", burst(500, 250)).decision, "command");
assert.equal(verifier.verify("m1", tone(180, 420)).decision, "uncertain");

const identified = verifier.identifyBest(burst(510, 240), ["missing", "m1"]);
assert.equal(identified?.macroId, "m1");

const buffer = new VoiceAudioRingBuffer();
const chunk = tone(500, 1000);
buffer.append(chunk);
const slice = buffer.slice(100, 500);
assert.ok(slice !== null && slice.length === Math.floor(400 / 1000 * 16000));
assert.equal(buffer.slice(-10, 100), null);
buffer.clear();
assert.equal(buffer.availableMs, 0);

console.log("local-voice-verifier: ok");
