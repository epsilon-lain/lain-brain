import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";
import { readFileSync } from "node:fs";

const built = await esbuild.build({
  stdin: {
    contents: `export { LainBrainSession } from "./src/LainBrainSession";
               export { transcribeRecordingFile } from "./src/AssemblyAIFileTranscription";`,
    resolveDir: process.cwd(),
    sourcefile: "import-recording-entry.ts",
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
  crypto: { randomUUID: () => "import-recording" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  TextEncoder, TextDecoder,
  setTimeout, clearTimeout, console
});
const {
  LainBrainSession,
  transcribeRecordingFile
} = module.exports;

// ── UI wiring: selecting a file enters runImport → session.importRecording ──
{
  const source = readFileSync(
    new URL("../src/ImportRecordingModal.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /fileInput\.files\?\.\[0\]/);
  assert.match(source, /fileInput\.value = ""/);
  assert.match(source, /void this\.runImport\(file\)/);
  assert.match(source, /this\.session\.importRecording\(/);
}

function makeApp(askText, created = new Map(), opened = []) {
  const vault = {
    created,
    async cachedRead(file) {
      return created.get(file?.path) ?? "";
    },
    getMarkdownFiles: () => [],
    getFileByPath: (path) => created.has(path)
      ? { path, basename: path.split("/").pop().replace(/\.md$/u, ""), extension: "md" }
      : null,
    getAbstractFileByPath: () => null,
    getFolderByPath: () => null,
    async createFolder() {},
    async create(path, content) {
      created.set(path, content);
      return { path, basename: path.split("/").pop(), extension: "md" };
    },
    async modify() {}
  };
  return {
    vault,
    metadataCache: { getFirstLinkpathDest: () => null },
    workspace: {
      getLeaf: () => ({ openFile: async (file) => { opened.push(file.path); } })
    }
  };
}

function makeSession(askText, created, opened) {
  const session = new LainBrainSession(
    makeApp(askText, created, opened),
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

const transcriptFixture = {
  text: "ka 删除第二行。 这是会议内容。",
  utterances: [
    { speaker: "A", startMs: 0, endMs: 2000, text: "ka 删除第二行。" },
    { speaker: "B", startMs: 2500, endMs: 5000, text: "这是会议内容。" }
  ],
  speakerCount: 2
};

// ── The upload sends raw file bytes as the body, never multipart ────────────
{
  const calls = [];
  const fileBytes = new Uint8Array([1, 2, 3, 4, 5]);
  const stages = [];
  const request = async (options) => {
    calls.push(options);
    if (options.url.endsWith("/upload")) {
      return { status: 200, json: { upload_url: "https://example.com/a.mp3" } };
    }
    if (options.url.endsWith("/transcript") && options.method === "POST") {
      return { status: 200, json: { id: "tr-1" } };
    }
    return {
      status: 200,
      json: {
        status: "completed",
        text: "hello world",
        utterances: [
          { speaker: "A", start: 100, end: 900, text: "hello" },
          { speaker: "B", start: 1000, end: 1800, text: "world" }
        ]
      }
    };
  };
  const result = await transcribeRecordingFile(
    "key",
    { name: "meeting.mp3", data: fileBytes.buffer },
    {
      request,
      pollIntervalMs: 1,
      onStage: (stage) => stages.push(stage)
    }
  );
  assert.equal(result.text, "hello world");
  assert.equal(result.speakerCount, 2);
  assert.equal(result.utterances.length, 2);

  const uploadCall = calls.find((c) => c.url.endsWith("/upload"));
  assert.ok(uploadCall, "upload endpoint was called");
  assert.deepEqual(
    [...new Uint8Array(uploadCall.body)],
    [1, 2, 3, 4, 5],
    "upload body is exactly the raw file bytes"
  );
  assert.equal(
    /multipart|boundary/.test(uploadCall.headers["Content-Type"] ?? ""),
    false,
    "upload does not use multipart"
  );
  assert.equal(uploadCall.headers["Content-Type"], "audio/mpeg");
  assert.equal(calls.some((c) => c.url.endsWith("/transcript")), true);
  assert.equal(calls.some((c) => c.url.includes("/transcript/tr-1")), true);
  const submitCall = calls.find(
    (c) => c.url.endsWith("/transcript") && c.method === "POST"
  );
  const submitBody = JSON.parse(submitCall.body);
  assert.equal(
    "speech_model" in submitBody,
    false,
    "pre-recorded submit must not send speech_model"
  );
  assert.deepEqual(
    submitBody.speech_models,
    ["universal-3-5-pro", "universal-2"]
  );
  assert.equal(submitBody.audio_url, "https://example.com/a.mp3");
  assert.equal(submitBody.speaker_labels, true);
  assert.deepEqual(
    stages.map((stage) => stage.name),
    ["uploading", "submitting", "polling"]
  );
}

// ── Successful import builds a preview without touching Chat Space or Brain ──
{
  const created = new Map();
  let askCalls = 0;
  const session = makeSession(async () => { askCalls += 1; return "answer"; }, created);
  session.setRecordingTranscriber(async () => transcriptFixture);
  const result = await session.importRecording({ name: "m.mp3", data: new ArrayBuffer(0) });
  assert.equal(result.kind, "preview");
  assert.equal(session.getChatSpace().length, 0);
  assert.equal(session.getChatTranscriptMessages().length, 0);
  assert.equal(askCalls, 0, "import does not submit to Brain");
  assert.equal(session.getAccurateVoiceMacroExecutionCount(), 0);
}

// ── Saving writes a source-attributed, timestamped note and no macro runs ──
{
  const created = new Map();
  let askCalls = 0;
  const session = makeSession(async () => { askCalls += 1; return "answer"; }, created);
  const save = await session.createImportedRecordingNote({
    title: "Team sync",
    sourceFileName: "meeting.mp3",
    transcript: transcriptFixture
  });
  assert.equal(save.ok, true);
  const markdown = created.get(save.path);
  assert.ok(markdown.includes("# Team sync"));
  assert.ok(markdown.includes("> Source: meeting.mp3 (transcribed from audio)"));
  assert.ok(markdown.includes("## Summary"));
  assert.ok(markdown.includes("No summary generated."));
  assert.ok(markdown.includes("## Transcript"));
  assert.ok(markdown.includes("**[00:00] A:** ka 删除第二行。"));
  assert.ok(markdown.includes("**[00:02] B:** 这是会议内容。"));
  assert.equal(session.getChatSpace().length, 0);
  assert.equal(session.getAccurateVoiceMacroExecutionCount(), 0);
  assert.equal(askCalls, 0, "save never submits to Brain");
  assert.equal(session.getChatTranscriptMessages().length, 0);
}

// ── Saving opens the created note so the user does not search the file tree ─
{
  const created = new Map();
  const opened = [];
  const session = makeSession(async () => "answer", created, opened);
  const save = await session.createImportedRecordingNote({
    title: "Team sync",
    sourceFileName: "meeting.mp3",
    transcript: transcriptFixture
  });
  assert.equal(save.ok, true);
  assert.deepEqual(opened, [save.path], "saved note is opened");
}

// ── Selecting a file reaches the import path and reports stages ─────────────
{
  const stages = [];
  const session = makeSession(async () => "answer");
  session.setRecordingTranscriber(async (file, onStage) => {
    onStage?.({ name: "uploading", detail: `${file.name} (${file.data.byteLength} bytes)` });
    onStage?.({ name: "submitting" });
    onStage?.({ name: "polling", detail: "tr-1" });
    return transcriptFixture;
  });
  const result = await session.importRecording(
    { name: "m.mp3", data: new Uint8Array([9, 8, 7]).buffer },
    (stage) => stages.push(stage)
  );
  assert.equal(result.kind, "preview");
  assert.deepEqual(
    stages.map((stage) => stage.name),
    ["uploading", "submitting", "polling"]
  );
  assert.match(stages[0].detail, /m\.mp3 \(3 bytes\)/);
}

// ── Summary is included when provided and omitted as "No summary generated" ──
{
  const session = makeSession(async () => "answer");
  const withSummary = session.buildRecordingNoteMarkdown({
    title: "T", sourceFileName: "m.mp3", transcript: transcriptFixture,
    summary: "摘要内容"
  });
  assert.ok(withSummary.includes("摘要内容"));
  assert.ok(withSummary.includes("## Summary"));
  assert.equal(withSummary.includes("No summary generated."), false);
}

// ── No DeepSeek key still saves a transcript note ──────────────────────────
{
  const created = new Map();
  const session = new LainBrainSession(
    makeApp(async () => "answer", created),
    () => "",
    () => null,
    undefined,
    async () => "answer"
  );
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  const summary = await session.generateRecordingSummary("some transcript");
  assert.equal(summary, null);
  const save = await session.createImportedRecordingNote({
    title: "No key", sourceFileName: "m.wav", transcript: transcriptFixture
  });
  assert.equal(save.ok, true);
  assert.ok(created.get(save.path).includes("No summary generated."));
}

// ── Cancel after a late transcription response never saves ─────────────────
{
  const created = new Map();
  let resolveTranscribe;
  const session = makeSession(async () => "answer", created);
  session.setRecordingTranscriber(() => new Promise((resolve) => {
    resolveTranscribe = resolve;
  }));
  const pending = session.importRecording({ name: "m.mp3", data: new ArrayBuffer(0) });
  session.cancelRecordingImport();
  resolveTranscribe(transcriptFixture);
  const result = await pending;
  assert.equal(result.kind, "cancelled");
  assert.equal(created.size, 0);
}

// ── Only an explicit question sends the note into the Brain request ────────
{
  const created = new Map();
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  }, created);
  const save = await session.createImportedRecordingNote({
    title: "Ask me", sourceFileName: "m.mp3", transcript: transcriptFixture
  });
  assert.equal(save.ok, true);
  assert.equal(requests.length, 0, "no Brain request after saving");

  session.appendKeyboardChatSpaceText("总结这个会议");
  await session.submitChatSpace();
  assert.equal(requests.length, 1);
  const noteContext = requests[0][2];
  assert.ok(noteContext !== undefined && noteContext !== null);
  assert.match(noteContext.content, /这是会议内容/);
}

// ── Imported note is read as the Brain note context, and switching notes ──
//    stops reading the old note.
{
  const created = new Map();
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  }, created);

  const save = await session.createImportedRecordingNote({
    title: "Meeting note",
    sourceFileName: "meeting.mp3",
    transcript: {
      text: "MEETING_NOTE_927 这是导入会议内容。",
      utterances: [{
        speaker: "A",
        startMs: 0,
        endMs: 1000,
        text: "MEETING_NOTE_927 这是导入会议内容。"
      }],
      speakerCount: 1
    }
  });
  assert.equal(save.ok, true);

  // Switch back to Chat Space (nothing pending) and ask.
  session.appendKeyboardChatSpaceText("总结这个会议");
  await session.submitChatSpace();
  assert.equal(requests.length, 1);
  const firstNote = requests[0][2];
  assert.ok(firstNote !== undefined && firstNote !== null);
  assert.match(firstNote.content, /MEETING_NOTE_927/);

  // Switch to a different note; the old imported note must not linger.
  await session.setActiveFile({
    path: "Lain Brain/Notes/Other.md",
    basename: "Other",
    extension: "md"
  });
  session.appendKeyboardChatSpaceText("再问一个问题");
  await session.submitChatSpace();
  assert.equal(requests.length, 2);
  const secondNote = requests[1][2];
  assert.ok(secondNote !== undefined && secondNote !== null);
  assert.equal(secondNote.content.includes("MEETING_NOTE_927"), false);
}

// ── The activated-context branch must still pass the active note ───────────
{
  const source = readFileSync(
    new URL("../src/LainBrainSession.ts", import.meta.url),
    "utf8"
  );
  // In the foreground "activated" branch the legacy note is suppressed (the
  // note arrives via the activated foreground context), while a ready recording
  // forces the legacy branch where noteContext carries the recording.
  assert.match(
    source,
    /foregroundContext\.mode === "activated"\s*\?\s*await this\.askText\(\s*apiKey,\s*providerHistory,\s*undefined,\s*undefined,\s*foregroundContext/
  );
  assert.match(
    source,
    /await this\.askText\(\s*apiKey,\s*providerHistory,\s*effectiveNoteContext,\s*priorContext/
  );
}

// ── With a real activated context, the imported note still reaches Brain ────
{
  const created = new Map();
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  }, created);

  const save = await session.createImportedRecordingNote({
    title: "Meeting note",
    sourceFileName: "meeting.mp3",
    transcript: {
      text: "MEETING_NOTE_927 这是导入会议内容。",
      utterances: [{
        speaker: "A",
        startMs: 0,
        endMs: 1000,
        text: "MEETING_NOTE_927 这是导入会议内容。"
      }],
      speakerCount: 1
    }
  });
  assert.equal(save.ok, true);

  // Force the "activated" foreground branch to be taken.
  session.setForegroundContextPreparer(async () => ({
    traversal: {},
    contextBundle: {},
    promptSection: {
      items: [{ text: "ACTIVATED_CONTEXT" }],
      serializedText: "ACTIVATED_CONTEXT"
    }
  }));

  session.appendKeyboardChatSpaceText("总结这个会议");
  await session.submitChatSpace();
  assert.equal(requests.length, 1);
  const noteContext = requests[0][2];
  // In the activated branch the legacy note is suppressed; the note arrives
  // through the activated foreground context instead.
  assert.equal(noteContext, undefined);
  const foreground = requests[0][4];
  assert.equal(foreground.mode, "activated");
  assert.equal(foreground.activatedContext, "ACTIVATED_CONTEXT");
}

// ── Save & analyze: question reaches Brain with the note body, no macros ──
{
  const created = new Map();
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  }, created);

  const save = await session.createImportedRecordingNote({
    title: "Meeting note",
    sourceFileName: "meeting.mp3",
    transcript: {
      text: "MEETING_NOTE_927 ka 删除第二行。",
      utterances: [{
        speaker: "A",
        startMs: 0,
        endMs: 1000,
        text: "MEETING_NOTE_927 ka 删除第二行。"
      }],
      speakerCount: 1
    }
  });
  assert.equal(save.ok, true);

  const result = await session.analyzeActiveNote(
    "Summarize this recording"
  );
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);

  const noteContext = requests[0][2];
  assert.ok(noteContext !== undefined && noteContext !== null);
  assert.match(noteContext.content, /MEETING_NOTE_927/);
  // The recording's "ka"/"删除第二行" words must not be treated as macros.
  assert.equal(session.getAccurateVoiceMacroExecutionCount(), 0);
  assert.equal(session.getChatSpace().length, 0);

  // The transcript is never copied into Chat Space; only the question appears.
  const userMessages = session.getChatTranscriptMessages()
    .filter((m) => m.role === "user");
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0].content, "Summarize this recording");
}

// ── Save & analyze in the activated branch still carries the note body ─────
{
  const created = new Map();
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  }, created);

  const save = await session.createImportedRecordingNote({
    title: "Meeting note",
    sourceFileName: "meeting.mp3",
    transcript: {
      text: "MEETING_NOTE_927 内容",
      utterances: [{ speaker: "A", startMs: 0, endMs: 1000, text: "MEETING_NOTE_927 内容" }],
      speakerCount: 1
    }
  });
  assert.equal(save.ok, true);

  session.setForegroundContextPreparer(async () => ({
    traversal: {},
    contextBundle: {},
    promptSection: { items: [{ text: "ACTIVATED" }], serializedText: "ACTIVATED" }
  }));

  const result = await session.analyzeActiveNote("Summarize this recording");
  assert.equal(result.ok, true);
  assert.equal(requests[0][4].mode, "activated");
  assert.equal(requests[0][2], undefined);
  assert.equal(requests[0][4].activatedContext, "ACTIVATED");
}

// ── analyzeActiveNote is blocked without an active, readable note ──────────
{
  const created = new Map();
  const requests = [];
  const session = makeSession(async (...args) => {
    requests.push(args);
    return "answer";
  }, created);

  // No note is active.
  assert.equal((await session.analyzeActiveNote("question")).ok, false);
  assert.equal(requests.length, 0);

  // An active note with empty content is blocked, not reported as analyzed.
  await session.setActiveFile({
    path: "Lain Brain/Notes/Empty.md",
    basename: "Empty",
    extension: "md"
  });
  assert.equal((await session.analyzeActiveNote("question")).ok, false);
  assert.equal(requests.length, 0);
}

// ── Modal wiring: Save & analyze calls analyzeActiveNote and dedups ────────
{
  const modalSource = readFileSync(
    new URL("../src/ImportRecordingModal.ts", import.meta.url),
    "utf8"
  );
  assert.match(modalSource, /text:\s*"Save & analyze with Brain"/);
  assert.match(modalSource, /this\.session\.analyzeActiveNote\(/);
  assert.match(modalSource, /Summarize this recording's main points/);
  assert.match(modalSource, /private busy = false/);
  assert.match(modalSource, /if \(this\.transcript === null \|\| this\.busy\) return/);
}

// ── analyzeActiveNote must not overwrite, send, or clear the user's draft ──
{
  const created = new Map();
  let resolveAsk;
  const requests = [];
  const session = makeSession((...args) => {
    requests.push(args);
    return new Promise((resolve) => { resolveAsk = resolve; });
  }, created);

  const save = await session.createImportedRecordingNote({
    title: "Meeting note",
    sourceFileName: "meeting.mp3",
    transcript: {
      text: "MEETING_NOTE_927 ka 删除第二行。",
      utterances: [{
        speaker: "A", startMs: 0, endMs: 1000,
        text: "MEETING_NOTE_927 ka 删除第二行。"
      }],
      speakerCount: 1
    }
  });
  assert.equal(save.ok, true);

  session.setDraft("my existing draft");
  const pending = session.analyzeActiveNote(
    "Summarize this recording's main points"
  );

  // While the request is in flight the draft stays untouched.
  await waitFor(() => requests.length === 1);
  assert.equal(session.draft, "my existing draft");

  // New input during the request is preserved too.
  session.setDraft("my existing draft + more");
  assert.equal(session.draft, "my existing draft + more");

  resolveAsk("answer");
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(session.draft, "my existing draft + more");

  // The analysis question and the note body reached Brain, not the draft.
  const providerHistory = requests[0][1];
  const userTexts = Array.from(providerHistory)
    .filter((m) => m.role === "user")
    .map((m) => m.content);
  assert.equal(userTexts.includes("Summarize this recording's main points"), true);
  assert.equal(userTexts.includes("my existing draft"), false);
  assert.match(requests[0][2].content, /MEETING_NOTE_927/);

  // No Chat Space pollution, no macro execution.
  assert.equal(session.getChatSpace().length, 0);
  assert.equal(session.getAccurateVoiceMacroExecutionCount(), 0);
}

// ── A failed analysis also preserves the draft ─────────────────────────────
{
  const created = new Map();
  const session = makeSession(async () => {
    throw new Error("provider down");
  }, created);

  const save = await session.createImportedRecordingNote({
    title: "Meeting note",
    sourceFileName: "meeting.mp3",
    transcript: {
      text: "MEETING_NOTE_927 内容",
      utterances: [{ speaker: "A", startMs: 0, endMs: 1000, text: "MEETING_NOTE_927 内容" }],
      speakerCount: 1
    }
  });
  assert.equal(save.ok, true);

  session.setDraft("keep me");
  const result = await session.analyzeActiveNote("Summarize this recording");
  assert.equal(result.ok, false);
  assert.match(result.reason, /Brain request failed/);
  assert.equal(session.draft, "keep me");
}

console.log("import-recording: ok");
