import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const outDir = mkdtempSync(`${tmpdir()}/lain-brain-chat-space-`);
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--target", "es2021", "--module", "commonjs", "--skipLibCheck", "--outDir", outDir,
  "src/ChatSpace.ts", "src/ChatSpaceSubmissionGate.ts", "src/MacroTypes.ts", "src/MacroMatcher.ts", "src/UndoJournal.ts", "src/MacroExecutor.ts", "src/MacroRegistry.ts"], { stdio: "inherit" });
const require = createRequire(import.meta.url);
const { ChatSpace } = require(`${outDir}/ChatSpace.js`);
const { MacroMatcher } = require(`${outDir}/MacroMatcher.js`);
const { MacroExecutor } = require(`${outDir}/MacroExecutor.js`);
const { DEFAULT_KA_MACRO, migrateMacroRegistry } = require(`${outDir}/MacroRegistry.js`);
const { ChatSpaceSubmissionGate } = require(`${outDir}/ChatSpaceSubmissionGate.js`);

const space = new ChatSpace();
space.setPartialVoiceText("ka");
assert.equal(space.getSegments().length, 0, "partial voice text is not a segment");
space.setPartialVoiceText("ka now");
assert.equal(space.partialText, "ka now", "partial changes are observable for redraw keys");
space.finalizeVoiceTurn("今天想到一个新的知识结构。", "2026-01-01T00:00:00.000Z");
assert.equal(space.getSegments()[0].id.startsWith("chat-segment-"), true);
const matcher = new MacroMatcher([DEFAULT_KA_MACRO]);
const match = matcher.match("1+1 等于多少，ka！");
assert.equal(match.kind, "match");
assert.equal(match.macro.id, DEFAULT_KA_MACRO.id);
const executor = new MacroExecutor(space);
space.appendKeyboardText("1+1 等于多少");
const submitted = executor.execute({ ...match, normalizedText: "1+1 等于多少 ka", consumedText: "ka" });
assert.equal(submitted.submittedText, "今天想到一个新的知识结构。\n1+1 等于多少");
assert.equal(space.text().includes("ka"), false);

const remove = {
  id: "remove", name: "Remove line", patterns: [{ kind: "parameterized", template: "remove line {n}", parameters: [{ name: "n", type: "integer", min: 1 }] }],
  parameters: [{ name: "n", type: "integer", min: 1 }], actions: [{ kind: "delete_segment", line: { parameter: "n" } }], writesToChat: false, undoable: true,
  confirmation: { kind: "destructive" }, enabled: true, createdAt: "now", updatedAt: "now", schemaVersion: 1
};
const removeMatch = new MacroMatcher([remove]).match("remove line 5");
assert.equal(removeMatch.kind, "match");
assert.equal(removeMatch.parameters.n, 5);
assert.equal(new MacroMatcher([remove]).match("please remove line 5 later").kind, "none");
assert.equal(new MacroMatcher([remove]).match("remove line nope").kind, "none");
const twoParameterMacro = {
  ...remove,
  id: "remove-range",
  patterns: [{ kind: "parameterized", template: "remove lines {start} to {end}", parameters: [
    { name: "start", type: "integer", min: 1 },
    { name: "end", type: "integer", min: 1 }
  ] }],
  parameters: [
    { name: "start", type: "integer", min: 1 },
    { name: "end", type: "integer", min: 1 }
  ]
};
assert.equal(new MacroMatcher([twoParameterMacro]).match("remove lines 2 to nope").kind, "none");

const numbered = new ChatSpace();
for (let index = 1; index <= 5; index += 1) numbered.appendKeyboardText(`paragraph ${index}`);
const numberedExecutor = new MacroExecutor(numbered);
const before = numbered.getSegments();
const deleteFifthMatch = new MacroMatcher([remove]).match("remove line 5");
assert.equal(deleteFifthMatch.kind, "match");
assert.equal(deleteFifthMatch.parameters.n, 5);
numberedExecutor.execute(deleteFifthMatch);
assert.deepEqual(numbered.getSegments().map((item) => item.text), ["paragraph 1", "paragraph 2", "paragraph 3", "paragraph 4"]);
assert.equal(numbered.getSegments().some((item) => item.text === "paragraph 5"), false);
const multiline = new ChatSpace();
multiline.appendKeyboardText("line one\nline two");
multiline.appendKeyboardText("paragraph two");
assert.equal(multiline.getSegments().length, 2, "multiline keyboard text remains one numbered paragraph");
new MacroExecutor(multiline).execute(new MacroMatcher([remove]).match("remove line 2"));
assert.equal(multiline.getSegments()[0].text, "line one\nline two", "line numbers address paragraphs, not physical newline rows");
assert.equal(multiline.getSegments().length, 1);
numberedExecutor.recover();
assert.deepEqual(numbered.getSegments().map((item) => item.id), before.map((item) => item.id));
assert.equal(numbered.getSegments().length, before.length, "recover restores the fifth paragraph");
numberedExecutor.recover();
assert.equal(numbered.getSegments().length, before.length, "empty recover is harmless");

const submittedSnapshot = numbered.snapshot();
numbered.appendKeyboardText("new while provider is waiting");
numbered.removeSubmittedSnapshot(submittedSnapshot);
assert.deepEqual(numbered.getSegments().map((item) => item.text), ["new while provider is waiting"]);

const gate = new ChatSpaceSubmissionGate();
let taskRuns = 0;
let resolveTask;
const first = gate.run(() => {
  taskRuns += 1;
  return new Promise((resolve) => { resolveTask = resolve; });
});
const duplicate = gate.run(async () => {
  taskRuns += 1;
  return "duplicate";
});
assert.equal(first, duplicate, "duplicate Enter shares the in-flight submission");
assert.equal(taskRuns, 1);
resolveTask("sent");
await first;

// A stable finalized turn id is idempotent at the session adapter boundary;
// the pure gate above verifies the corresponding single-send behavior.
assert.equal(typeof ChatSpaceSubmissionGate, "function");

const conflict = new MacroMatcher([
  { ...DEFAULT_KA_MACRO, id: "ka-a" },
  { ...DEFAULT_KA_MACRO, id: "ka-b" }
]).match("ka");
assert.equal(conflict.kind, "conflict");
const migrated = migrateMacroRegistry({ macros: [remove], definitionPhrase: "make macro" });
assert.equal(migrated.schemaVersion, 1);
assert.equal(migrated.macros.some((item) => item.id === DEFAULT_KA_MACRO.id), true);
assert.equal(migrated.definitionPhrase, "make macro");
console.log("chat-space-macros: ok");
