import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const project = process.cwd().replace(/\\/g, "/");
const built = await esbuild.build({
  entryPoints: [`${project}/src/CreateCandidateNoteModal.ts`],
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  write: false,
  plugins: [{
    name: "obsidian-ui-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian",
        namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: `
          class MockElement {
            constructor() {
              this.children = [];
              this.settings = [];
              this.style = {};
              this.text = "";
            }
            empty() { this.children = []; this.settings = []; }
            createEl(_tag, options = {}) {
              const child = new MockElement();
              child.text = options.text || "";
              this.children.push(child);
              return child;
            }
            createDiv() { return this.createEl("div"); }
            setText(value) { this.text = value; }
            addEventListener() {}
            addClass() {}
          }
          class Modal {
            constructor(app) {
              this.app = app;
              this.contentEl = new MockElement();
            }
            setTitle(value) { this.title = value; }
            close() { this.closed = true; }
          }
          class FuzzySuggestModal extends Modal {
            setPlaceholder(value) { this.placeholder = value; }
            open() { this.opened = true; }
          }
          class Setting {
            constructor(container) {
              this.descEl = new MockElement();
              container.settings.push(this);
            }
            setName(value) { this.name = value; return this; }
            setDesc(value) { this.description = value; return this; }
            addText(callback) {
              const control = {
                inputEl: {},
                setValue(value) { this.value = value; return this; },
                onChange(handler) { this.change = handler; return this; }
              };
              callback(control);
              this.textControl = control;
              return this;
            }
            addDropdown(callback) {
              const control = {
                options: new Map(),
                addOption(value, label) { this.options.set(value, label); return this; },
                setValue(value) { this.value = value; return this; },
                onChange(handler) { this.change = handler; return this; }
              };
              callback(control);
              this.dropdown = control;
              return this;
            }
          }
          exports.Modal = Modal;
          exports.FuzzySuggestModal = FuzzySuggestModal;
          exports.Setting = Setting;
          exports.normalizePath = (value) => value.replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");
        `
      }));
    }
  }]
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  DOMMatrix: class { constructor(){} },
  module,
  exports: module.exports,
  require,
  console
});
const { CreateCandidateNoteModal } = module.exports;
const originalMarkdown = "# The Cauchy–Schwarz Inequality\n\nOriginal body.";
const candidate = {
  id: "candidate-1",
  title: "The Cauchy–Schwarz Inequality",
  markdown: originalMarkdown
};
const parentPath =
  "Lain Brain/Notes/I am building one parent knowledge node named -Inner Product Spaces-.md";
const group = {
  id: "legacy-parent-qx9dsz",
  title: "legacy raw title",
  parentDisplayTitle: "Inner Product Spaces",
  parentVaultPath: parentPath
};
let createArguments;
const session = {
  getCandidateNotes: () => [candidate],
  getAvailableCandidateParentGroups: () => [group],
  getCandidateGroup: (id) => id === group.id ? group : undefined,
  discoverCandidateParentGroups: async () => [group],
  getExistingMarkdownParentFiles: () => [{ path: parentPath }],
  registerExistingNoteParent: () => group,
  createCandidateNote: async (...args) => {
    createArguments = args;
    return { ok: false, error: "test-stop" };
  }
};

const modal = new CreateCandidateNoteModal(
  {}, session, candidate.id, candidate.title
);
modal.onOpen();
const parentSetting = modal.contentEl.settings.find(
  (setting) => setting.name === "Parent note (optional)"
);

assert.ok(parentSetting, "Parent selector must be visibly rendered");
assert.equal(parentSetting.dropdown.options.get(""), "No parent");
assert.equal(
  parentSetting.dropdown.options.get(group.id),
  "Inner Product Spaces"
);
assert.equal(
  parentSetting.dropdown.options.get("__choose_existing_note__"),
  "Choose an existing note…"
);
parentSetting.dropdown.change(group.id);
assert.deepEqual(
  { ...modal.parentSelection },
  { groupId: group.id, parentVaultPath: parentPath }
);
assert.equal(candidate.markdown, originalMarkdown);
await modal.createNote();
assert.deepEqual(
  { ...createArguments[3] },
  { groupId: group.id, parentVaultPath: parentPath }
);

const noParentsSession = {
  getCandidateNotes: () => [candidate],
  getAvailableCandidateParentGroups: () => [],
  getCandidateGroup: () => undefined,
  discoverCandidateParentGroups: async () => [],
  getExistingMarkdownParentFiles: () => [],
  registerExistingNoteParent: () => undefined,
  createCandidateNote: async () => ({ ok: false, error: "test-stop" })
};
const noParentsModal = new CreateCandidateNoteModal(
  {}, noParentsSession, candidate.id, candidate.title
);
noParentsModal.onOpen();
const alwaysVisibleParentSetting =
  noParentsModal.contentEl.settings.find(
    (setting) => setting.name === "Parent note (optional)"
  );
assert.ok(
  alwaysVisibleParentSetting,
  "Parent selector must render even when no parents are available"
);
assert.equal(
  alwaysVisibleParentSetting.dropdown.options.get(""),
  "No parent"
);
assert.equal(alwaysVisibleParentSetting.dropdown.options.size, 1);

console.log(JSON.stringify({
  dropdownOptions: [
    { value: "", label: "No parent" },
    {
      value: group.id,
      label: "Inner Product Spaces",
      parentVaultPath: parentPath
    },
    {
      value: "__choose_existing_note__",
      label: "Choose an existing note…"
    }
  ],
  result: "PASS"
}, null, 2));
