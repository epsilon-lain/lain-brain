import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

class FakeStyle {
  setProperty(name, value) { this[name] = value; }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = new FakeStyle();
    this.classList = {
      add: (...names) => this.addClass(...names),
      remove: () => {},
      contains: (name) => (this.attributes.get("class") ?? "")
        .split(/\s+/)
        .includes(name)
    };
    this.textContent = "";
    this.value = "";
    this.type = "";
    this.files = null;
  }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  createEl(tagName, options = {}) {
    const child = this.appendChild(new FakeElement(tagName));
    if (typeof options.text === "string") child.textContent = options.text;
    if (typeof options.type === "string") child.type = options.type;
    if (typeof options.cls === "string") child.addClass(options.cls);
    return child;
  }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  addClass(...names) {
    const existing = this.attributes.get("class") ?? "";
    this.attributes.set("class", [existing, ...names].filter(Boolean).join(" "));
  }
  setAttr(name, value) { this.attributes.set(name, String(value)); }
  setAttribute(name, value) { this.setAttr(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setText(value) { this.textContent = String(value); }
  empty() { this.children = []; this.textContent = ""; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ currentTarget: this, target: this, preventDefault() {} });
    }
  }
  click() { this.dispatch("click"); }
  focus() {}
  findButton(text) {
    let found = null;
    const visit = (element) => {
      for (const child of element.children) {
        if (child.tagName === "BUTTON" && child.textContent === text) {
          found = child;
          return;
        }
        visit(child);
        if (found !== null) return;
      }
    };
    visit(this);
    return found;
  }
}

class FakeModal {
  constructor(app) {
    this.app = app;
    this.contentEl = new FakeElement("div");
    this.titleEl = new FakeElement("div");
  }
  open() { this.onOpen?.(); }
  close() { this.onClose?.(); }
}

class FakeNotice {
  constructor() {}
}

const built = await esbuild.build({
  stdin: {
    contents: [
      "export { ImportRecordingModal } from './src/ImportRecordingModal';",
      "export { LainBrainSession } from './src/LainBrainSession';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "import-recording-modal-ux-entry.ts",
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
        path: "obsidian",
        namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: [
          "exports.Modal = globalThis.__FakeModal;",
          "exports.Notice = globalThis.__FakeNotice;",
          "exports.normalizePath = (p) => String(p).replace(/\\\\/g, '/').replace(/^\\.[\\/]/, '').replace(/\\/+$/g, '');",
          "exports.requestUrl = async () => { throw Error('unexpected network'); };"
        ].join("\n")
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
  DOMMatrix: class {},
  crypto: { randomUUID: () => "import-ux-" + Math.random().toString(36).slice(2, 8) },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout,
  console,
  __FakeModal: FakeModal,
  __FakeNotice: FakeNotice
});

const { ImportRecordingModal, LainBrainSession } = module.exports;

const DEFAULT_QUESTION =
  "Summarize this recording's main points, decisions, and action items. " +
  "If a category is absent, say so.";

function makeApp(created, opened) {
  return {
    vault: {
      cachedRead: async (file) => created.get(file?.path) ?? "",
      getMarkdownFiles: () => [],
      getFileByPath: (path) => created.has(path)
        ? { path, basename: path.split("/").pop().replace(/\.md$/u, ""), extension: "md" }
        : null,
      getAbstractFileByPath: () => null,
      getFolderByPath: () => null,
      createFolder: async () => {},
      create: async (path, content) => {
        created.set(path, content);
        return { path, basename: path.split("/").pop(), extension: "md" };
      },
      modify: async () => {}
    },
    metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
    workspace: {
      getActiveFile: () => null,
      getLeaf: () => ({ openFile: async (file) => { opened.push(file.path); } })
    }
  };
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
  text: "MEETING_NOTE_927 ka 删除第二行。",
  utterances: [{ speaker: "A", startMs: 0, endMs: 1000, text: "MEETING_NOTE_927 ka 删除第二行。" }],
  speakerCount: 1
};

{
  const created = new Map();
  const opened = [];
  const requests = [];
  const app = makeApp(created, opened);
  const session = new LainBrainSession(
    app,
    () => "deepseek-key",
    () => null,
    undefined,
    async (...args) => { requests.push(args); return "answer"; }
  );
  session.setChatSemanticDeltaAnalysisEnabledProvider(() => false);
  session.setRecordingTranscriber(async () => transcriptFixture);

  const modal = new ImportRecordingModal(app, session);
  modal.open();
  await modal.runImport({
    name: "meeting.mp3",
    arrayBuffer: async () => new ArrayBuffer(0)
  });

  const button = modal.contentEl.findButton("Save & analyze with Brain");
  assert.ok(button, "Save & analyze button is rendered");
  button.click();

  await waitFor(() => requests.length === 1);

  const providerHistory = requests[0][1];
  assert.equal(
    Array.from(providerHistory).some(
      (m) => m.role === "user" && m.content === DEFAULT_QUESTION
    ),
    true,
    "the default analysis question reached Brain"
  );
  assert.match(requests[0][2].content, /MEETING_NOTE_927/);

  // The chat transcript shows the question and the answer.
  const messages = session.getChatTranscriptMessages();
  assert.equal(
    messages.some((m) => m.role === "user" && m.content === DEFAULT_QUESTION),
    true
  );
  assert.equal(
    messages.some((m) => m.role === "assistant" && m.content === "answer"),
    true
  );

  // No Chat Space pollution, no macro execution.
  assert.equal(session.getChatSpace().length, 0);
  assert.equal(session.getAccurateVoiceMacroExecutionCount(), 0);
  assert.deepEqual(opened, ["Lain Brain/Notes/meeting.md"]);
}

console.log("import-recording-modal-ux: ok");
