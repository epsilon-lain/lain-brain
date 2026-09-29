import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/LainBrainChatPanel.ts", import.meta.url),
  "utf8"
);

// The toolbar no longer has a dedicated "Import Recording" button.
assert.doesNotMatch(
  source,
  /createEl\("button",\s*\{\s*text:\s*"Import Recording"\s*\}/
);

// The paperclip button now opens a native Menu with two keyboard-navigable
// items, and restores focus to the button on hide.
assert.match(source, /new Menu\(\)/);
assert.match(source, /\.setTitle\("Attach image"\)/);
assert.match(source, /\.setTitle\("Import recording"\)/);
assert.match(source, /menu\.onHide\(\(\)\s*=>\s*\{\s*this\.attachmentButton\.focus\(\);/);
assert.match(source, /menu\.showAtMouseEvent\(event\)/);

// "Attach image" keeps the existing image file input behavior.
assert.match(source, /\.setTitle\("Attach image"\)[\s\S]*?this\.fileInput\.click\(\)/);

// "Import recording" opens the recording file input (pending attachment path).
assert.match(source, /\.setTitle\("Import recording"\)[\s\S]*?this\.recordingFileInput\.click\(\)/);

// Selecting a recording starts a background attachment, not a note modal.
assert.match(source, /recordingFileInput\.addEventListener\("change"/);
assert.match(source, /this\.startRecordingAttachment\(/);
assert.match(source, /session\.startRecordingAttachment\(\{ name, data \}\)/);
assert.match(source, /Recording ready:/);
assert.match(source, /"Cancel"|"Retry"|"Remove"/);

console.log("attachment-menu: ok");
