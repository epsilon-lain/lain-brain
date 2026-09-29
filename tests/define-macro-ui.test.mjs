import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/LainBrainChatPanel.ts", import.meta.url),
  "utf8"
);

assert.match(
  source,
  /this\.session\.setMacroEnabled\(macro\.id, !macro\.enabled\)/
);
assert.doesNotMatch(source, /disableMacro\(macro\.id\)/);

console.log("define-macro-ui: ok");
