import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/BrainGrowth";
      export * from "./src/BrainGrowthPersistence";
      export * from "./src/ObsidianConceptIndex";
      export * from "./src/BrainMaintenanceWorkspaceModal";
      export * from "./src/BrainMigrationWorkspaceModal";
      export { __openedModals } from "obsidian";
    `,
    resolveDir: process.cwd(),
    sourcefile: "brain-migration-workspace-modal-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  write: false,
  plugins: [{
    name: "obsidian-workspace-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian",
        namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: `
          const __openedModals = [];
          class MockElement {
            constructor(tag = "div", options = {}) {
              this.tag = tag;
              this.children = [];
              this.settings = [];
              this.style = {};
              this.attributes = {};
              this.events = new Map();
              this.text = options.text || "";
              this.value = "";
              this.disabled = false;
            }
            empty() { this.children = []; this.settings = []; this.text = ""; }
            createEl(tag, options = {}) {
              const child = new MockElement(tag, options);
              this.children.push(child);
              return child;
            }
            createDiv() { return this.createEl("div"); }
            setText(value) { this.text = String(value); }
            setAttr(key, value) { this.attributes[key] = String(value); }
            addClass(value) { this.className = value; }
            addEventListener(event, handler) { this.events.set(event, handler); }
            click() {
              return this.disabled
                ? undefined
                : this.events.get("click")?.({ preventDefault() {} });
            }
            input(value) {
              this.value = value;
              return this.events.get("input")?.({});
            }
          }
          class Modal {
            constructor(app) {
              this.app = app;
              this.modalEl = new MockElement("div");
              this.contentEl = new MockElement("div");
            }
            setTitle(value) { this.modalTitle = value; }
            open() {
              this.opened = true;
              __openedModals.push(this);
              this.onOpen?.();
            }
            close() { this.closed = true; this.onClose?.(); }
          }
          class Setting {
            constructor(container) {
              this.container = container;
              this.settingEl = new MockElement("setting");
              container.children.push(this.settingEl);
              container.settings.push(this);
            }
            setName(value) {
              this.name = value;
              this.settingEl.text = value;
              return this;
            }
            setDesc(value) { this.description = value; return this; }
            addText(callback) {
              const inputEl = new MockElement("input");
              this.settingEl.children.push(inputEl);
              const control = {
                inputEl,
                setValue(value) { inputEl.value = value; return this; },
                onChange(handler) { inputEl.change = handler; return this; }
              };
              callback(control);
              this.textControl = control;
              return this;
            }
            addDropdown(callback) {
              const selectEl = new MockElement("select");
              this.settingEl.children.push(selectEl);
              const control = {
                options: new Map(),
                addOption(value, label) { this.options.set(value, label); return this; },
                setValue(value) { selectEl.value = value; return this; },
                onChange(handler) { selectEl.change = handler; return this; }
              };
              callback(control);
              this.dropdown = control;
              return this;
            }
            addButton(callback) {
              const buttonEl = new MockElement("button");
              this.settingEl.children.push(buttonEl);
              const control = {
                buttonEl,
                setButtonText(value) { buttonEl.text = value; return this; },
                onClick(handler) { buttonEl.events.set("click", handler); return this; }
              };
              callback(control);
              this.button = control;
              return this;
            }
            addToggle(callback) {
              const toggleEl = new MockElement("toggle");
              this.settingEl.children.push(toggleEl);
              const control = {
                toggleEl,
                setValue(value) { toggleEl.value = value; return this; },
                onChange(handler) { toggleEl.change = handler; return this; }
              };
              callback(control);
              this.toggle = control;
              return this;
            }
          }
          exports.Modal = Modal;
          exports.Setting = Setting;
          exports.__openedModals = __openedModals;
          exports.normalizePath = (value) =>
            value.replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");
        `
      }));
    }
  }]
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console,
  Object,
  Map,
  Set,
  JSON,
  Math,
  Date,
  encodeURIComponent,
  decodeURIComponent
});
const api = module.exports;
const createdAt = "2026-08-16T01:00:00.000Z";
const ordinaryPath = "Notes/Ordinary.md";
const ordinaryMarkdown = [
  "---",
  "tags: [review-me]",
  "---",
  "# Ordinary",
  "",
  "Unclassified source material."
].join("\n");
const existingPath = "Lain Brain/Notes/Existing Ordinary.md";
const existingConcept = api.createConceptNode({
  id: "concept-existing-ordinary",
  title: "Ordinary",
  createdAt
});
const existingMarkdown = api.serializeConceptNodeIntoMarkdown(
  "# Ordinary\n\nA distinct existing concept.",
  existingConcept,
  {
    candidateId: "candidate-existing-ordinary",
    candidateRevision: 1,
    approvedAt: createdAt
  }
);
const files = new Map([
  [ordinaryPath, { path: ordinaryPath }],
  [existingPath, { path: existingPath }]
]);
const store = new Map([
  [ordinaryPath, ordinaryMarkdown],
  [existingPath, existingMarkdown]
]);
const writes = [];
let pauseNextSourceRead = false;
let releasePausedSourceRead;
const readMarkdown = async (file) => {
  if (pauseNextSourceRead && file.path === ordinaryPath) {
    pauseNextSourceRead = false;
    await new Promise((resolve) => {
      releasePausedSourceRead = resolve;
    });
  }
  return store.get(file.path);
};
const app = {
  workspace: { getActiveFile: () => files.get(ordinaryPath) },
  vault: {
    getMarkdownFiles: () => [...files.values()],
    getFileByPath: (path) => files.get(path) ?? null,
    cachedRead: readMarkdown,
    read: readMarkdown,
    modify: async (file, markdown) => {
      writes.push({ operation: "modify", path: file.path, markdown });
      store.set(file.path, markdown);
    },
    create: async (path, markdown) => {
      writes.push({ operation: "create", path, markdown });
    },
    trash: async (file) => {
      writes.push({ operation: "trash", path: file.path });
    }
  }
};

const allElements = (element) => [
  element,
  ...element.children.flatMap((child) => allElements(child))
];
const textContent = (element) => allElements(element)
  .map((item) => item.text)
  .filter(Boolean);
const findButton = (root, label) => allElements(root).find(
  (element) => element.tag === "button" && element.text === label
);
const findSetting = (root, name) => allElements(root)
  .flatMap((element) => element.settings)
  .find((setting) => setting.name === name);
const findTextarea = (root, ariaLabel) => allElements(root).find(
  (element) => element.tag === "textarea" &&
    element.attributes["aria-label"] === ariaLabel
);
const flush = () => new Promise((resolve) => setImmediate(resolve));

const discovered = await api.loadObsidianConceptIndex(app);
assert.equal(discovered.records.length, 1);
assert.equal(writes.length, 0);

async function launchFromMaintenanceLookup() {
  const lookup = new api.ConceptMaintenanceLookupModal(app, discovered);
  lookup.onOpen();
  const launch = findButton(lookup.contentEl, "Prepare Concept Migration");
  assert.ok(launch);
  launch.click();
  await flush();
  const migration = api.__openedModals.at(-1);
  assert.ok(migration instanceof api.ConceptMigrationWorkspaceModal);
  assert.equal(lookup.closed, true);
  return migration;
}

// The maintenance lookup explicitly launches migration; reading/opening does not
// prepare or write the ordinary note.
const migration = await launchFromMaintenanceLookup();
assert.equal(migration.modalTitle, "Prepare Concept Migration");
assert.equal(migration.prepared, undefined);
assert.equal(store.get(ordinaryPath), ordinaryMarkdown);
assert.equal(writes.length, 0);
const editorLabels = textContent(migration.contentEl);
for (const label of [
  "Stable identity",
  "Semantic layer mapping",
  "Personal definition - authoritative",
  "Exact user evidence - not yet a definition",
  "Generated / AI interpretation - non-authoritative",
  "Standard / external meaning - non-authoritative",
  "Unresolved / ambiguous material"
]) {
  assert.equal(editorLabels.includes(label), true, `missing UI label: ${label}`);
}
assert.equal(findTextarea(
  migration.contentEl,
  "Unresolved material mapping"
).value, ordinaryMarkdown);

// Preview, Back, editing, re-preview, and Cancel remain entirely in memory.
findSetting(migration.contentEl, "Concept ID")
  .textControl.inputEl.change("concept-migrated-ordinary");
findButton(migration.contentEl, "Preview").click();
assert.equal(migration.prepared.kind, "prepared");
assert.equal(migration.prepared.concept.userDefinition, undefined);
assert.equal(migration.prepared.mapping.unresolvedMaterialText, ordinaryMarkdown);
assert.equal(writes.length, 0);
assert.equal(findButton(migration.contentEl, "Confirm Migration") !== undefined, true);
assert.equal(allElements(migration.contentEl).some(
  (element) => element.attributes["data-migration-diff"] === "true"
), true);
assert.equal(allElements(migration.contentEl).some(
  (element) => element.attributes["data-migration-markdown-preview"] === "true"
), true);
assert.equal(
  textContent(migration.contentEl).includes("Label collisions"),
  true,
  JSON.stringify({
    collisions: migration.prepared.labelCollisions,
    text: textContent(migration.contentEl)
  })
);

findButton(migration.contentEl, "Back").click();
assert.equal(migration.prepared, undefined);
assert.equal(writes.length, 0);
findTextarea(
  migration.contentEl,
  "Personal definition mapping"
).input("My exact reviewed definition.");
findTextarea(
  migration.contentEl,
  "User evidence mapping"
).input("My exact supporting evidence.");
findTextarea(
  migration.contentEl,
  "Generated interpretation mapping"
).input("Generated wording remains separate.");
findTextarea(
  migration.contentEl,
  "Standard definition mapping"
).input("An external definition remains separate.");
findTextarea(
  migration.contentEl,
  "Unresolved material mapping"
).input("");
findButton(migration.contentEl, "Preview").click();
assert.equal(migration.prepared.mapping.userDefinitionText,
  "My exact reviewed definition.");
assert.equal(migration.prepared.mapping.unresolvedMaterialText, "");
assert.equal(migration.prepared.concept.userDefinition.text,
  "My exact reviewed definition.");
assert.equal(writes.length, 0);
const cancelledConfirm = findButton(
  migration.contentEl,
  "Confirm Migration"
);
findButton(migration.contentEl, "Cancel").click();
assert.equal(migration.closed, true);
cancelledConfirm.events.get("click")({ preventDefault() {} });
await flush();
assert.equal(store.get(ordinaryPath), ordinaryMarkdown);
assert.equal(writes.length, 0);

// A detached Confirm control belongs only to the exact preview that rendered
// it. After Back and a second preview, the stale control must authorize neither.
const staleControlMigration = await launchFromMaintenanceLookup();
findSetting(staleControlMigration.contentEl, "Concept ID")
  .textControl.inputEl.change("concept-stale-control-a");
findButton(staleControlMigration.contentEl, "Preview").click();
const stalePreviewConfirm = findButton(
  staleControlMigration.contentEl,
  "Confirm Migration"
);
findButton(staleControlMigration.contentEl, "Back").click();
findSetting(staleControlMigration.contentEl, "Concept ID")
  .textControl.inputEl.change("concept-stale-control-b");
findButton(staleControlMigration.contentEl, "Preview").click();
stalePreviewConfirm.events.get("click")({ preventDefault() {} });
await flush();
assert.equal(store.get(ordinaryPath), ordinaryMarkdown);
assert.equal(writes.length, 0);
findButton(staleControlMigration.contentEl, "Cancel").click();

// A new reviewed flow crosses the boundary only through Confirm Migration.
const confirmedMigration = await launchFromMaintenanceLookup();
findSetting(confirmedMigration.contentEl, "Concept ID")
  .textControl.inputEl.change("concept-migrated-ordinary");
findTextarea(
  confirmedMigration.contentEl,
  "Personal definition mapping"
).input("My exact reviewed definition.");
findTextarea(
  confirmedMigration.contentEl,
  "Unresolved material mapping"
).input("");
findButton(confirmedMigration.contentEl, "Preview").click();
assert.equal(writes.length, 0);
pauseNextSourceRead = true;
const pendingConfirm = findButton(
  confirmedMigration.contentEl,
  "Confirm Migration"
);
pendingConfirm.click();
await flush();
assert.equal(typeof releasePausedSourceRead, "function");
assert.equal(confirmedMigration.isConfirming, true);
const pendingBack = findButton(confirmedMigration.contentEl, "Back");
const pendingCancel = findButton(confirmedMigration.contentEl, "Cancel");
const rerenderedPendingConfirm = findButton(
  confirmedMigration.contentEl,
  "Confirm Migration"
);
assert.equal(pendingBack.disabled, true);
assert.equal(pendingCancel.disabled, true);
assert.equal(rerenderedPendingConfirm.disabled, true);
pendingBack.click();
pendingCancel.click();
rerenderedPendingConfirm.click();
pendingConfirm.events.get("click")({ preventDefault() {} });
assert.equal(confirmedMigration.prepared.kind, "prepared");
assert.equal(confirmedMigration.closed === true, false);
assert.equal(writes.length, 0);
releasePausedSourceRead();
releasePausedSourceRead = undefined;
await flush();
await flush();
assert.deepEqual(writes.map((write) => write.operation), ["modify"]);
assert.equal(writes[0].path, ordinaryPath);
assert.equal(confirmedMigration.modalTitle, "Concept Migration Complete");
assert.equal(textContent(confirmedMigration.contentEl).includes(
  "Concept migration complete."
), true);

const migrated = api.inspectConceptMarkdown(store.get(ordinaryPath));
assert.equal(migrated.kind, "concept_node");
assert.equal(migrated.persisted.conceptNode.id, "concept-migrated-ordinary");
assert.equal(migrated.persisted.conceptNode.userDefinition.text,
  "My exact reviewed definition.");
assert.equal(migrated.persisted.origin.kind, "ordinary_markdown_migration");
assert.equal(store.get(existingPath), existingMarkdown);

// A same-title concept arriving after preview invalidates that review. The
// failure refreshes the modal's index so Back -> Preview shows the collision
// and a newly reviewed distinct stable identity can then be confirmed.
const lateSourcePath = "Notes/Late Collision.md";
const lateSourceMarkdown = "# Late Collision\n\nStill ordinary source material.";
files.set(lateSourcePath, { path: lateSourcePath });
store.set(lateSourcePath, lateSourceMarkdown);
const beforeLateCollision = await api.loadObsidianConceptIndex(app);
const lateMigration = new api.ConceptMigrationWorkspaceModal(
  app,
  beforeLateCollision,
  lateSourcePath,
  lateSourceMarkdown
);
lateMigration.open();
findSetting(lateMigration.contentEl, "Concept ID")
  .textControl.inputEl.change("concept-reviewed-late-collision");
findSetting(lateMigration.contentEl, "Title")
  .textControl.inputEl.change("Late Collision");
findButton(lateMigration.contentEl, "Preview").click();
assert.equal(lateMigration.prepared.labelCollisions.length, 0);

const lateCollisionPath = "Lain Brain/Notes/Late Collision Existing.md";
const lateCollisionConcept = api.createConceptNode({
  id: "concept-distinct-late-collision",
  title: "Late Collision",
  createdAt
});
const lateCollisionMarkdown = api.serializeConceptNodeIntoMarkdown(
  "# Late Collision\n\nA separately created distinct concept.",
  lateCollisionConcept,
  {
    candidateId: "candidate-distinct-late-collision",
    candidateRevision: 1,
    approvedAt: createdAt
  }
);
files.set(lateCollisionPath, { path: lateCollisionPath });
store.set(lateCollisionPath, lateCollisionMarkdown);
const writesBeforeLateReview = writes.length;
findButton(lateMigration.contentEl, "Confirm Migration").click();
await flush();
await flush();
assert.equal(writes.length, writesBeforeLateReview);
assert.equal(lateMigration.prepared.labelCollisions.length, 0);
assert.equal(lateMigration.isConfirming, false);
assert.equal(textContent(lateMigration.contentEl).some(
  (text) => text.includes("Concept label collisions changed")
), true);

findButton(lateMigration.contentEl, "Back").click();
assert.equal(lateMigration.prepared, undefined);
findButton(lateMigration.contentEl, "Preview").click();
assert.equal(lateMigration.prepared.labelCollisions.length, 1);
assert.equal(lateMigration.prepared.labelCollisions[0].conceptId,
  lateCollisionConcept.id);
assert.equal(textContent(lateMigration.contentEl).includes("Label collisions"),
  true);
assert.equal(writes.length, writesBeforeLateReview);

findButton(lateMigration.contentEl, "Confirm Migration").click();
await flush();
await flush();
assert.equal(writes.length, writesBeforeLateReview + 1);
assert.equal(lateMigration.modalTitle, "Concept Migration Complete");
const lateMigrated = api.inspectConceptMarkdown(store.get(lateSourcePath));
assert.equal(lateMigrated.kind, "concept_node");
assert.equal(lateMigrated.persisted.conceptNode.id,
  "concept-reviewed-late-collision");
assert.notEqual(lateMigrated.persisted.conceptNode.id,
  lateCollisionConcept.id);

console.log(JSON.stringify({
  launchedFromMaintenanceLookup: true,
  semanticLayerLabelsVisible: true,
  prepareCancelBackRepreviewWrites: 0,
  pendingConfirmationControlsDisabled: true,
  doubleSubmitPrevented: true,
  lateCollisionReviewRecovered: true,
  confirmMigrationModifyCalls: writes.length,
  migratedStableId: migrated.persisted.conceptNode.id,
  result: "PASS"
}, null, 2));
