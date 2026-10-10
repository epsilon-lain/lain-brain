import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export {
        ASSEMBLYAI_STREAMING_SAMPLE_RATE,
        DEFAULT_ASSEMBLYAI_SPEECH_MODEL,
        buildAssemblyAIStreamingUrl,
        downsampleToPcm16
      } from "./src/AssemblyAIVoiceInput";
    `,
    resolveDir: process.cwd(),
    sourcefile: "assemblyai-voice-entry.ts",
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
          exports.requestUrl = async () => {
            throw new Error("Unexpected network request");
          };
        `
      }));
    }
  }]
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  URL,
  URLSearchParams,
  console,
  setTimeout,
  clearTimeout
});
const {
  ASSEMBLYAI_STREAMING_SAMPLE_RATE,
  DEFAULT_ASSEMBLYAI_SPEECH_MODEL,
  buildAssemblyAIStreamingUrl,
  downsampleToPcm16
} = module.exports;

assert.equal(ASSEMBLYAI_STREAMING_SAMPLE_RATE, 16_000);
assert.equal(DEFAULT_ASSEMBLYAI_SPEECH_MODEL, "universal-3-5-pro");

const url = new URL(buildAssemblyAIStreamingUrl(
  "temporary secret",
  "universal-3-5-pro",
  16_000
));
assert.equal(url.protocol, "wss:");
assert.equal(url.hostname, "streaming.assemblyai.com");
assert.equal(url.pathname, "/v3/ws");
assert.equal(url.searchParams.get("token"), "temporary secret");
assert.equal(url.searchParams.get("speech_model"), "universal-3-5-pro");
assert.equal(url.searchParams.get("sample_rate"), "16000");
assert.equal(url.searchParams.get("format_turns"), "true");

const input = new Float32Array(480);
input.fill(0.5);
const buffer = downsampleToPcm16(input, 48_000, 16_000);
const samples = new Int16Array(buffer);
assert.equal(samples.length, 160);
assert.ok(samples.every((sample) => sample >= 16_382 && sample <= 16_384));

const clipped = downsampleToPcm16(
  new Float32Array([2, 2, 2, -2, -2, -2]),
  48_000,
  16_000
);
assert.deepEqual(
  Array.from(new Int16Array(clipped)),
  [32_767, -32_768]
);

assert.throws(
  () => downsampleToPcm16(
    new Float32Array([0]),
    8_000,
    16_000
  ),
  /at least the target/
);

console.log("AssemblyAI voice input tests passed.");
