import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const calls = [];
const built = await esbuild.build({
  entryPoints: ["src/VoiceIntentServices.ts"], bundle: true,
  platform: "node", format: "cjs", write: false,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian", namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js", contents: `exports.requestUrl = async (options) => {
          globalThis.__calls.push({ url: options.url, body: JSON.parse(options.body) });
          if (options.url.includes('typesafe.ai')) return {
            status: 200, json: { answers: { intent: { type: 'choice',
              choice: 'command', probabilities: { command: 0.95,
                text: 0.02, uncertain: 0.03 } } } }
          };
          return { json: { choices: [{ message: { content:
            '\\x60\\x60\\x60json\\n{"cleanedText":"删除第二行。","possibleMacro":true,"candidateText":"remove line 2"}\\n\\x60\\x60\\x60'
          } }] } };
        };`
      }));
    }
  }]
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports,
  require: createRequire(import.meta.url), __calls: calls
});
const { createVoiceIntentServices } = module.exports;
const services = createVoiceIntentServices(() => "deepseek-key", () => "jev-key");
const result = await services.clean("删除第 2 行", ["remove line {n}"]);
assert.equal(result.cleanedText, "删除第二行。");
assert.equal(result.candidateText, "remove line 2");
assert.equal(calls[0].body.messages[1].content.includes("remove line {n}"), true);
assert.equal(await services.classify("Cut.", "Cut.", "ka"), "command");
assert.equal(calls[1].body.questions.intent.type, "choice");
assert.equal(calls[1].body.model, "jev-latest");
console.log("Voice intent services tests passed.");
