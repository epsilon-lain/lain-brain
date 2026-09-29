import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: {
    contents: `export { LainBrainSession } from "./src/LainBrainSession";
               export { createNormalChatSystemPrompt } from "./src/DeepSeekClient";`,
    resolveDir: process.cwd(),
    sourcefile: "recording-attachment-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian", namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: [
          `exports.requestUrl = async () => { throw Error("unexpected network"); };`,
          `exports.normalizePath = (p) => String(p).replace(/\\\\/g, "/").replace(/^\\.[\\/]/, "").replace(/\\/+$/g, "");`
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports, require: createRequire(import.meta.url),
  URL, URLSearchParams,
  DOMMatrix: class {},
  crypto: { randomUUID: () => "recording-attachment" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  setTimeout, clearTimeout, console
});
const { LainBrainSession, createNormalChatSystemPrompt } = module.exports;

function makeApp() {
  return {
    vault: {
      cachedRead: async () => "",
      getMarkdownFiles: () => [],
      getFileByPath: () => null,
      getAbstractFileByPath: () => null,
      getFolderByPath: () => null,
      createFolder: async () => {},
      create: async () => ({ path: "x.md", basename: "x", extension: "md" }),
      modify: async () => {}
    },
    metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
    workspace: {
      getActiveFile: () => null,
      getLeaf: () => ({ openFile: async () => {} })
    }
  };
}

function makeSession(askText) {
  const session = new LainBrainSession(
    makeApp(),
    () => "deepseek-key",
    () => null,
    undefined,
    askText
  );
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  return session;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}

const readyTranscript = {
  text: "MEETING_NOTE_927 ka 删除第二行。",
  utterances: [{ speaker: "A", startMs: 0, endMs: 1000, text: "MEETING_NOTE_927 ka 删除第二行。" }],
  speakerCount: 1
};

// ── Selecting a file reaches ready and keeps the transcript bound ──────────
{
  const session = makeSession(async () => "answer");
  session.setRecordingTranscriber(async () => readyTranscript);
  session.startRecordingAttachment({ name: "meeting.mp3", data: new ArrayBuffer(0) });
  await waitFor(() => session.getRecordingAttachment()?.status === "ready");
  const attachment = session.getRecordingAttachment();
  assert.equal(attachment.fileName, "meeting.mp3");
  assert.match(attachment.transcript.text, /MEETING_NOTE_927/);
}

// ── Explicit remove cancels a late transcription result ────────────────────
{
  let resolveTranscribe;
  const session = makeSession(async () => "answer");
  session.setRecordingTranscriber(() => new Promise((resolve) => {
    resolveTranscribe = resolve;
  }));
  session.startRecordingAttachment({ name: "m.mp3", data: new ArrayBuffer(0) });
  session.removeRecordingAttachment();
  assert.equal(session.getRecordingAttachment(), null);
  resolveTranscribe(readyTranscript);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.getRecordingAttachment(), null);
}

// ── Submit with a ready recording sends the transcript as context ──────────
{
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  });
  session.setRecordingTranscriber(async () => readyTranscript);
  session.startRecordingAttachment({ name: "meeting.mp3", data: new ArrayBuffer(0) });
  await waitFor(() => session.getRecordingAttachment()?.status === "ready");
  session.appendKeyboardChatSpaceText("Summarize this");
  assert.equal(await session.submitChatSpace(), "sent");
  assert.equal(requests.length, 1);
  assert.match(requests[0][2].content, /MEETING_NOTE_927/);
  assert.equal(session.getChatSpace().length, 0, "question removed from Chat Space on success");
  assert.equal(session.getAccurateVoiceMacroExecutionCount(), 0);
  // The transcript stays bound for follow-up questions.
  assert.equal(session.getRecordingAttachment()?.status, "ready");
}

// ── Submit while still transcribing waits, then sends ──────────────────────
{
  let resolveTranscribe;
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  });
  session.setRecordingTranscriber(() => new Promise((resolve) => {
    resolveTranscribe = resolve;
  }));
  session.startRecordingAttachment({ name: "meeting.mp3", data: new ArrayBuffer(0) });
  assert.equal(
    session.ingestKeyboardChatSpaceTurn("Summarize this").kind,
    "appended"
  );
  const pending = session.submitChatSpace();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 0, "submit must wait for transcription");
  resolveTranscribe(readyTranscript);
  assert.equal(await pending, "sent");
  assert.equal(requests.length, 1);
  assert.match(requests[0][2].content, /MEETING_NOTE_927/);
}

// ── Failure blocks submit and Retry recovers ───────────────────────────────
{
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  });
  session.setRecordingTranscriber(async () => {
    throw new Error("boom");
  });
  session.startRecordingAttachment({ name: "meeting.mp3", data: new ArrayBuffer(0) });
  await waitFor(() => session.getRecordingAttachment()?.status === "failed");
  assert.equal(session.getRecordingAttachment().error, "boom");

  session.appendKeyboardChatSpaceText("Summarize this");
  assert.equal(await session.submitChatSpace(), "blocked");
  assert.equal(requests.length, 0);
  assert.equal(
    session.getChatSpaceText(),
    "Summarize this",
    "failed submit keeps the original question for retry"
  );

  session.setRecordingTranscriber(async () => readyTranscript);
  session.retryRecordingAttachment();
  await waitFor(() => session.getRecordingAttachment()?.status === "ready");
  assert.equal(await session.submitChatSpace(), "sent");
  assert.equal(requests.length, 1);
  assert.match(requests[0][2].content, /MEETING_NOTE_927/);
}

// ── A ready recording forces the legacy branch so its transcript is kept ──
{
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  });
  session.setRecordingTranscriber(async () => ({
    text: "CYBERPUNK_927 录音内容",
    utterances: [],
    speakerCount: 0
  }));
  session.startRecordingAttachment({ name: "rec.mp4", data: new ArrayBuffer(0) });
  await waitFor(() => session.getRecordingAttachment()?.status === "ready");
  session.setForegroundContextPreparer(async () => ({
    traversal: {},
    contextBundle: {},
    promptSection: { items: [{ text: "ACTIVATED" }], serializedText: "ACTIVATED_CONTEXT" }
  }));
  session.appendKeyboardChatSpaceText("问");
  assert.equal(await session.submitChatSpace(), "sent");
  assert.equal(requests[0][4].mode, "legacy_fallback");
  assert.match(requests[0][2].content, /CYBERPUNK_927/);
}

// ── A ready recording takes priority over an active note ───────────────────
{
  const requests = [];
  const app = makeApp();
  app.vault.cachedRead = async (file) =>
    file?.path === "old.md" ? "OLD_MEMORY_927" : "";
  const session = new LainBrainSession(
    app,
    () => "deepseek-key",
    () => null,
    undefined,
    async (...args) => { requests.push(args); return "answer"; }
  );
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  await session.setActiveFile({
    path: "old.md",
    basename: "old",
    extension: "md"
  });
  session.setRecordingTranscriber(async () => ({
    text: "CYBERPUNK_927 录音内容",
    utterances: [],
    speakerCount: 0
  }));
  session.startRecordingAttachment({ name: "rec.mp4", data: new ArrayBuffer(0) });
  await waitFor(() => session.getRecordingAttachment()?.status === "ready");

  session.ingestKeyboardChatSpaceTurn("问");
  assert.equal(await session.submitChatSpace(), "sent");
  assert.match(requests[0][2].content, /CYBERPUNK_927/);
  assert.equal(requests[0][2].content.includes("OLD_MEMORY_927"), false);
  const diagnostic = session.getLastRecordingSendDiagnostic();
  assert.equal(diagnostic.transcriptIncluded, true);
  assert.equal(diagnostic.transcriptLength > 0, true);
}

// ── A ready recording whose top-level text is empty still uses utterances ─
{
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  });
  session.setRecordingTranscriber(async () => ({
    text: "",
    utterances: [{ speaker: "A", startMs: 0, endMs: 1000, text: "CYBERPUNK_927 来自 utterances" }],
    speakerCount: 1
  }));
  session.startRecordingAttachment({ name: "rec.mp4", data: new ArrayBuffer(0) });
  await waitFor(() => session.getRecordingAttachment()?.status === "ready");
  session.ingestKeyboardChatSpaceTurn("问");
  assert.equal(await session.submitChatSpace(), "sent");
  assert.match(requests[0][2].content, /CYBERPUNK_927/);
}

// ── A ready recording with no text or utterances blocks, never falls back ──
{
  const requests = [];
  const app = makeApp();
  app.vault.cachedRead = async (file) =>
    file?.path === "old.md" ? "OLD_MEMORY_927" : "";
  const session = new LainBrainSession(
    app,
    () => "deepseek-key",
    () => null,
    undefined,
    async (...args) => { requests.push(args); return "answer"; }
  );
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  await session.setActiveFile({
    path: "old.md",
    basename: "old",
    extension: "md"
  });
  session.setRecordingTranscriber(async () => ({
    text: "",
    utterances: [],
    speakerCount: 0
  }));
  session.startRecordingAttachment({ name: "rec.mp4", data: new ArrayBuffer(0) });
  await waitFor(() => session.getRecordingAttachment()?.status === "ready");

  session.ingestKeyboardChatSpaceTurn("问");
  assert.equal(await session.submitChatSpace(), "blocked");
  assert.equal(requests.length, 0, "empty transcript must not reach Brain");
  assert.equal(
    session.getChatSpaceText(),
    "问",
    "question is kept for retry"
  );
}

// ── Removing the recording restores the normal active-note send ────────────
{
  const requests = [];
  const app = makeApp();
  app.vault.cachedRead = async (file) =>
    file?.path === "old.md" ? "OLD_MEMORY_927" : "";
  const session = new LainBrainSession(
    app,
    () => "deepseek-key",
    () => null,
    undefined,
    async (...args) => { requests.push(args); return "answer"; }
  );
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  await session.setActiveFile({
    path: "old.md",
    basename: "old",
    extension: "md"
  });
  session.setRecordingTranscriber(async () => ({
    text: "",
    utterances: [],
    speakerCount: 0
  }));
  session.startRecordingAttachment({ name: "rec.mp4", data: new ArrayBuffer(0) });
  await waitFor(() => session.getRecordingAttachment()?.status === "ready");
  session.removeRecordingAttachment();

  session.ingestKeyboardChatSpaceTurn("问");
  assert.equal(await session.submitChatSpace(), "sent");
  assert.equal(requests.length, 1);
  assert.match(requests[0][2].content, /OLD_MEMORY_927/);
}

// ── The final system prompt actually contains the recording transcript ────
{
  const prompt = createNormalChatSystemPrompt(
    { title: "rec.mp4", content: "CYBERPUNK_927 录音内容" },
    undefined,
    { mode: "legacy_fallback" }
  );
  assert.match(prompt, /CYBERPUNK_927/);
  assert.match(prompt, /Active note content:/);
}

console.log("recording-attachment: ok");
