import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/LainBrainChatPanel.ts", import.meta.url),
  "utf8"
);

// The narrow-sidebar fix must let the toolbar wrap instead of clipping
// Clear Chat, and must keep the note label shrinkable/wrappable.
assert.match(source, /toolbar\.style\.flexWrap\s*=\s*"wrap"/);
assert.match(source, /this\.noteLabel\.style\.minWidth\s*=\s*"0"/);
assert.match(source, /this\.noteLabel\.style\.overflowWrap\s*=\s*"anywhere"/);

// Clear Chat must remain in the DOM and must not be hidden to solve overflow.
assert.match(source, /text:\s*"Clear Chat"/);
assert.doesNotMatch(
  source,
  /this\.clearButton\.style\.display\s*=\s*"none"/
);

console.log("narrow-sidebar-ui: ok");
