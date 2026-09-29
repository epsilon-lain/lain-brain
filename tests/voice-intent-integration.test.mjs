import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  entryPoints: ["src/LainBrainSession.ts"], bundle: true,
  platform: "node", format: "cjs", write: false,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian", namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: "exports.requestUrl = async () => { throw Error('unexpected network'); };"
      }));
    }
  }]
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports, require, URL, URLSearchParams,
  DOMMatrix: class { constructor() {} },
  crypto: { randomUUID: () => "intent-test" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  setTimeout, clearTimeout, console
});
const { LainBrainSession } = module.exports;

function makeSession() {
  const app = {
    vault: { cachedRead: async () => "", getMarkdownFiles: () => [],
      getFileByPath: () => null, getAbstractFileByPath: () => null },
    metadataCache: { getFirstLinkpathDest: () => null },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) }
  };
  const session = new LainBrainSession(app, () => "deepseek-key", () => null,
    undefined, async () => "response");
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  return session;
}

function toneSamples(frequency, durationMs, rate = 16000) {
  const length = Math.floor((durationMs / 1000) * rate);
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / rate);
  }
  return samples;
}

function burstSamples(frequency, durationMs, rate = 16000) {
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

async function waitHold() {
  await new Promise((resolve) => setTimeout(resolve, 1300));
}

function calibrateVoice(session, macroId = "builtin-ka") {
  session.addVoiceCalibrationSample(macroId, "positive", burstSamples(520, 240));
  session.addVoiceCalibrationSample(macroId, "positive", burstSamples(480, 260));
  session.addVoiceCalibrationSample(macroId, "positive", burstSamples(540, 250));
  session.addVoiceCalibrationSample(macroId, "negative", toneSamples(170, 500));
  session.addVoiceCalibrationSample(macroId, "negative", toneSamples(190, 460));
  session.addVoiceCalibrationSample(macroId, "negative", toneSamples(200, 480));
  assert.equal(session.getVoiceCalibrationStatus(macroId).calibrated, true);
  return burstSamples(500, 250);
}

const session = makeSession();
const kaSample = calibrateVoice(session);
let jevCalls = 0;
session.setVoiceIntentServices({
  clean: async (raw) => ({ cleanedText:
    raw === "erase second" ? "remove line 2" :
      raw === "an idea uh" ? "an idea." : raw,
    possibleMacro: raw === "Cut. Cut.",
    candidateText: raw === "Cut. Cut." ? "ka" : null }),
  classify: async () => { jevCalls++; return "command"; }
});
assert.equal((await session.ingestVoiceTurnWithIntent("an idea uh", undefined, "a:1")).kind, "appended");
assert.equal(session.getChatSpaceText(), "an idea.");
assert.equal(jevCalls, 0);
assert.equal((await session.ingestVoiceTurnWithIntent("ka", undefined, "a:2", undefined, kaSample)).kind, "executed");
assert.equal(session.getAccurateVoiceMacroExecutionCount(), 1);
await session.submitChatSpace();
assert.equal(jevCalls, 0, "exact macro needs no classifier");
assert.equal(session.getChatTranscriptMessages()
  .filter((message) => message.role === "user")[0].content, "an idea.");

session.appendKeyboardChatSpaceText("draft");
assert.equal((await session.ingestVoiceTurnWithIntent("Cut. Cut.", undefined, "a:3", undefined, kaSample)).kind, "executed");
await session.submitChatSpace();
assert.equal(jevCalls, 1);
assert.equal(session.getChatTranscriptMessages()
  .filter((message) => message.role === "user")[1].content, "draft");
assert.equal((await session.ingestVoiceTurnWithIntent("Cut. Cut.", undefined, "a:3")).kind, "ignored");

session.clearChat();
session.setVoiceIntentServices({
  clean: async (raw) => ({ cleanedText: raw, possibleMacro: true }),
  classify: async () => "uncertain"
});
// Uncertain Jev result must remain ordinary text; no manual confirmation UI.
assert.equal((await session.ingestVoiceTurnWithIntent("cut", undefined, "a:4")).kind, "appended");
assert.equal(session.getChatSpaceText(), "cut");

const custom = makeSession();
custom.setMacroRegistry({ schemaVersion: 1, definitionPhrase: "定义宏", macros: [{
  id: "remove-line", name: "Remove line",
  patterns: [{ kind: "parameterized", template: "remove line {n}",
    parameters: [{ name: "n", type: "integer", min: 1 }] }],
  parameters: [{ name: "n", type: "integer", min: 1 }],
  actions: [{ kind: "delete_segment", line: { parameter: "n" } }],
  writesToChat: false, undoable: true,
  confirmation: { kind: "never" }, enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1
}] });
custom.appendKeyboardChatSpaceText("first");
custom.appendKeyboardChatSpaceText("second");
const removeSample = calibrateVoice(custom, "remove-line");
custom.setVoiceIntentServices({
  clean: async (raw) => ({ cleanedText: raw, possibleMacro: true,
    candidateText: "remove line 2" }),
  classify: async () => "command"
});
assert.equal((await custom.ingestVoiceTurnWithIntent(
  "delete the second line", undefined, "m:1", undefined, removeSample
)).kind, "ignored");
await waitHold();
assert.equal(custom.getChatSpaceText(), "first\nsecond\ndelete the second line");
custom.setVoiceIntentServices({
  clean: async (raw) => ({ cleanedText: raw, possibleMacro: true,
    candidateText: "run shell command" }),
  classify: async () => { throw Error("unregistered candidate reached Jev"); }
});
assert.equal((await custom.ingestVoiceTurnWithIntent("ordinary line", undefined, "m:2")).kind, "ignored");
await waitHold();
assert.equal(custom.getChatSpaceText(), "first\nsecond\ndelete the second line\nordinary line");

// High-confidence standalone ASR variant "咔" becomes the registered ka macro.
{
  const high = makeSession();
  const highSample = calibrateVoice(high);
  high.setVoiceIntentServices({
    clean: async (raw) => raw === "咔"
      ? { cleanedText: "咔", possibleMacro: true, candidateText: "ka" }
      : { cleanedText: raw, possibleMacro: false },
    classify: async () => "command"
  });
  assert.equal((await high.ingestVoiceTurnWithIntent(
    "咔", undefined, "k:high", undefined, highSample
  )).kind, "executed");
}

// Low-confidence "咔" stays as ordinary text.
{
  const low = makeSession();
  low.setVoiceIntentServices({
    clean: async (raw) => raw === "咔"
      ? { cleanedText: "咔", possibleMacro: true, candidateText: "ka" }
      : { cleanedText: raw, possibleMacro: false },
    classify: async () => "uncertain"
  });
  assert.equal((await low.ingestVoiceTurnWithIntent("咔", undefined, "k:low")).kind, "appended");
  assert.equal(low.getChatSpaceText(), "咔");
}

// A longer utterance containing "咔" or "cut" is not guessed into a command.
{
  const body = makeSession();
  let classifyCalls = 0;
  body.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => { classifyCalls += 1; return "command"; }
  });
  assert.equal((await body.ingestVoiceTurnWithIntent("正文里提到咔", undefined, "body:ka")).kind, "appended");
  assert.equal((await body.ingestVoiceTurnWithIntent("ordinary cut", undefined, "body:cut")).kind, "appended");
  assert.equal(classifyCalls, 0);
  assert.equal(body.getChatSpaceText(), "正文里提到咔\nordinary cut");
}

// Jev failure falls back to the original final transcript as text.
{
  const failed = makeSession();
  failed.setVoiceIntentServices({
    clean: async (raw) => raw === "咔"
      ? { cleanedText: "咔", possibleMacro: true, candidateText: "ka" }
      : { cleanedText: raw, possibleMacro: false },
    classify: async () => { throw new Error("jev down"); }
  });
  assert.equal((await failed.ingestVoiceTurnWithIntent("咔", undefined, "k:fail")).kind, "appended");
  assert.equal(failed.getChatSpaceText(), "咔");
}

// Standalone "Car." and "K.A." are considered ka candidates only after Jev.
{
  const carHigh = makeSession();
  const carHighSample = calibrateVoice(carHigh);
  carHigh.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => "command"
  });
  assert.equal((await carHigh.ingestVoiceTurnWithIntent(
    "Car.", undefined, "car:high", undefined, carHighSample
  )).kind, "appended");
  assert.equal(carHigh.getChatSpaceText(), "Car.");

  const carLow = makeSession();
  carLow.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => "uncertain"
  });
  assert.equal((await carLow.ingestVoiceTurnWithIntent("Car.", undefined, "car:low")).kind, "appended");
  assert.equal(carLow.getChatSpaceText(), "Car.");

  const kaHigh = makeSession();
  const kaHighSample = calibrateVoice(kaHigh);
  kaHigh.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => "command"
  });
  assert.equal((await kaHigh.ingestVoiceTurnWithIntent(
    "K.A.", undefined, "ka:high", undefined, kaHighSample
  )).kind, "appended");
  assert.equal(kaHigh.getChatSpaceText(), "K.A.");

  const bodyCar = makeSession();
  bodyCar.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => "command"
  });
  assert.equal((await bodyCar.ingestVoiceTurnWithIntent("正文 Car.", undefined, "car:body")).kind, "appended");
  assert.equal(bodyCar.getChatSpaceText(), "正文 Car.");
}

// Cross-language standalone mistranscriptions use audio, not a spelling table.
{
  const jpHigh = makeSession();
  const jpHighSample = calibrateVoice(jpHigh);
  jpHigh.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => "command"
  });
  assert.equal((await jpHigh.ingestVoiceTurnWithIntent(
    "カ", undefined, "jp:high", undefined, jpHighSample
  )).kind, "appended");
  assert.equal(jpHigh.getChatSpaceText(), "カ");

  const jpLow = makeSession();
  jpLow.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => "text"
  });
  assert.equal((await jpLow.ingestVoiceTurnWithIntent(
    "カ", undefined, "jp:low"
  )).kind, "appended");
  assert.equal(jpLow.getChatSpaceText(), "カ");
}

// clean can produce no candidate; short-voice HOLD still asks the intent model.
{
  const commandSession = makeSession();
  commandSession.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => "command"
  });
  assert.equal((await commandSession.ingestVoiceTurnWithIntent(
    "Okay.", undefined, "hold:command"
  )).kind, "appended");
  assert.equal(commandSession.getChatSpaceText(), "Okay.");

  const textSession = makeSession();
  textSession.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => "text"
  });
  assert.equal((await textSession.ingestVoiceTurnWithIntent(
    "Okay.", undefined, "hold:text"
  )).kind, "appended");
  assert.equal(textSession.getChatSpaceText(), "Okay.");
}

// Existing numbered voice paragraphs + empty input line must still submit.
{
  const manualEnter = makeSession();
  manualEnter.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => "text"
  });
  await manualEnter.ingestVoiceTurnWithIntent("voice one", undefined, "enter:1");
  await manualEnter.ingestVoiceTurnWithIntent("voice two", undefined, "enter:2");
  assert.equal(manualEnter.getChatSpaceText(), "voice one\nvoice two");
  assert.equal(manualEnter.submitChatSpaceIfNotEmpty(), true);
  // The submitted paragraphs are hidden immediately, so a second empty-input
  // Enter has nothing new to submit and must not duplicate the request.
  assert.equal(manualEnter.submitChatSpaceIfNotEmpty(), false);
  await manualEnter.submitChatSpace();
  assert.equal(manualEnter.getChatSpace().length, 0);
  assert.equal(
    manualEnter.getChatTranscriptMessages()
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n"),
    "voice one\nvoice two"
  );
  assert.equal(manualEnter.submitChatSpaceIfNotEmpty(), false);
}

// A failed Brain send keeps the numbered voice paragraphs retryable.
{
  let sendCalls = 0;
  const retry = makeSession();
  retry.askText = async () => {
    sendCalls += 1;
    if (sendCalls === 1) throw new Error("provider down");
    return "answer";
  };
  retry.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => "text"
  });
  await retry.ingestVoiceTurnWithIntent("keep me", undefined, "retry:1");
  assert.equal(retry.submitChatSpaceIfNotEmpty(), true);
  assert.equal(await retry.submitChatSpace(), "failed");
  assert.equal(retry.getChatSpaceText(), "keep me");
  assert.equal(await retry.submitChatSpace(), "sent");
  assert.equal(sendCalls, 2);
  assert.deepEqual(
    [...retry.getChatTranscriptMessages()
      .filter((message) => message.role === "user")
      .map((message) => message.content)],
    ["keep me"]
  );
}

// Calibrated but not proven on real audio must stay ordinary text.
{
  const unproven = makeSession();
  unproven.addVoiceCalibrationSample("builtin-ka", "positive", burstSamples(520, 240));
  unproven.addVoiceCalibrationSample("builtin-ka", "positive", burstSamples(480, 260));
  unproven.addVoiceCalibrationSample("builtin-ka", "positive", burstSamples(540, 250));
  unproven.addVoiceCalibrationSample("builtin-ka", "negative", toneSamples(170, 500));
  unproven.addVoiceCalibrationSample("builtin-ka", "negative", toneSamples(190, 460));
  unproven.addVoiceCalibrationSample("builtin-ka", "negative", toneSamples(200, 480));
  assert.equal(unproven.getVoiceCalibrationStatus("builtin-ka").calibrated, true);
  assert.equal(unproven.getVoiceCalibrationStatus("builtin-ka").proven, false);
  unproven.setVoiceIntentServices({
    clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
    classify: async () => "uncertain"
  });
  const outcome = await unproven.ingestVoiceTurnWithIntent(
    "Car.", undefined, "unproven:1", undefined, toneSamples(500, 220)
  );
  assert.equal(outcome.kind, "appended");
  assert.equal(unproven.getChatSpaceText(), "Car.");
}

const overlapping = makeSession();
const overlappingSample = calibrateVoice(overlapping);
let finishAnswer;
overlapping.askText = () => new Promise((resolve) => {
  finishAnswer = resolve;
});
overlapping.setVoiceIntentServices({
  clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
  classify: async () => "text"
});
overlapping.appendKeyboardChatSpaceText("send this");
await overlapping.ingestVoiceTurnWithIntent("ka", undefined, "o:1", undefined, overlappingSample);
assert.equal((await overlapping.ingestVoiceTurnWithIntent("next thought", undefined, "o:2")).kind, "ignored");
finishAnswer("answer");
await overlapping.submitChatSpace();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(overlapping.getChatSpaceText(), "next thought",
  "a later voice turn must survive an in-flight Brain send");

let resolveCleaning;
session.setVoiceIntentServices({
  clean: () => new Promise((resolve) => { resolveCleaning = resolve; }),
  classify: async () => "text"
});
const delayed = session.ingestVoiceTurnWithIntent("old thought", undefined, "a:5");
session.clearChat();
resolveCleaning({ cleanedText: "old thought", possibleMacro: false });
assert.equal((await delayed).kind, "ignored");
assert.equal(session.getChatSpaceText(), "");

// A failed macro definition must not consume subsequent ordinary speech.
const failedDefinition = makeSession();
failedDefinition.handleMacroDefinitionInput("定义宏");
failedDefinition.setVoiceIntentServices({
  clean: async (raw) => ({ cleanedText: raw, possibleMacro: false }),
  classify: async () => "text"
});
await failedDefinition.submitMacroDefinitionDescription("bad definition");
assert.equal(failedDefinition.getMacroDefinitionState().kind, "error");
assert.equal(failedDefinition.handleMacroDefinitionInput("ordinary message", "f:1"), false);
assert.equal((await failedDefinition.ingestVoiceTurnWithIntent("ordinary message", undefined, "f:1")).kind, "appended");
assert.equal(failedDefinition.getChatSpaceText(), "ordinary message");
failedDefinition.getVoiceInput().callbacks.onFinalizedTurn({
  sessionId: "failed-macro", turnOrder: 2, turnId: "f:2",
  transcript: "第二句普通语音。"
});
await failedDefinition.voiceIntentQueue;
assert.equal(failedDefinition.getChatSpaceText(), "ordinary message\n第二句普通语音。");
assert.equal(failedDefinition.handleMacroDefinitionInput("定义宏", "f:3"), true);
assert.equal(failedDefinition.getMacroDefinitionState().kind, "awaiting_description");

// A final turn remains visible while cleanup is pending and becomes a segment.
const live = makeSession();
let finishCleaning;
live.setVoiceIntentServices({
  clean: () => new Promise((resolve) => { finishCleaning = resolve; }),
  classify: async () => "text"
});
const callbacks = live.getVoiceInput().callbacks;
callbacks.onPartialTranscript("你好，今天测试语音输入");
callbacks.onFinalizedTurn({
  sessionId: "live", turnOrder: 1, turnId: "live:1",
  transcript: "你好，今天测试语音输入。"
});
assert.equal(live.getChatSpacePartialVoiceText(), "");
assert.equal(live.getChatSpaceText(), "");
finishCleaning({ cleanedText: "你好，今天测试语音输入。", possibleMacro: false });
await live.voiceIntentQueue;
assert.equal(live.getChatSpacePartialVoiceText(), "");
assert.equal(live.getChatSpaceText(), "你好，今天测试语音输入。");
console.log("Voice intent integration tests passed.");
