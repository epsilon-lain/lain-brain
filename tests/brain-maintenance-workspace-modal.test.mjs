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
    `,
    resolveDir: process.cwd(),
    sourcefile: "brain-maintenance-workspace-modal-entry.ts",
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
            click() { return this.events.get("click")?.({ preventDefault() {} }); }
            input(value) { this.value = value; return this.events.get("input")?.({}); }
          }
          class Modal {
            constructor(app) {
              this.app = app;
              this.modalEl = new MockElement("div");
              this.contentEl = new MockElement("div");
            }
            setTitle(value) { this.title = value; }
            open() { this.opened = true; this.onOpen?.(); }
            close() { this.closed = true; this.onClose?.(); }
          }
          class Setting {
            constructor(container) {
              this.container = container;
              this.settingEl = new MockElement("setting");
              container.children.push(this.settingEl);
              container.settings.push(this);
            }
            setName(value) { this.name = value; this.settingEl.text = value; return this; }
            setDesc(value) { this.description = value; return this; }
            addText(callback) {
              const inputEl = new MockElement("input");
              this.settingEl.children.push(inputEl);
              const control = {
                inputEl,
                setValue(value) { inputEl.value = value; return this; },
                onChange(handler) { inputEl.change = handler; return this; }
              };
              callback(control); this.textControl = control; return this;
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
              callback(control); this.dropdown = control; return this;
            }
            addButton(callback) {
              const buttonEl = new MockElement("button");
              this.settingEl.children.push(buttonEl);
              const control = {
                buttonEl,
                setButtonText(value) { buttonEl.text = value; return this; },
                onClick(handler) { buttonEl.events.set("click", handler); return this; }
              };
              callback(control); this.button = control; return this;
            }
            addToggle(callback) {
              const toggleEl = new MockElement("toggle");
              this.settingEl.children.push(toggleEl);
              const control = {
                toggleEl,
                setValue(value) { toggleEl.value = value; return this; },
                onChange(handler) { toggleEl.change = handler; return this; }
              };
              callback(control); this.toggle = control; return this;
            }
          }
          exports.Modal = Modal;
          exports.Setting = Setting;
          exports.normalizePath = (value) => value.replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");
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
const createdAt = "2026-08-15T04:00:00.000Z";
const evidence = {
  sourceKind: "message_span",
  messageId: "message-1",
  snapshot: "My exact personal definition.",
  actor: "user"
};
const other = api.createConceptNode({
  id: "concept-other",
  title: "Freedom",
  aliases: ["liberty"],
  createdAt
});
const concept = api.createConceptNode({
  id: "concept-main",
  title: "Freedom",
  aliases: ["liberty"],
  userEvidence: [evidence],
  generatedInterpretations: [{
    id: "ai-1",
    text: "AI interpretation remains separate.",
    sourceReferences: []
  }],
  standardDefinitions: [{
    id: "external-1",
    text: "External definition remains separate.",
    sourceReferences: []
  }],
  unresolvedItems: [{
    id: "meaning-open",
    kind: "meaning",
    text: "No definition chosen.",
    alternatives: [evidence.snapshot],
    status: "open",
    sourceReferences: []
  }],
  createdAt
});
const origin = {
  candidateId: "candidate-main",
  candidateRevision: 1,
  approvedAt: createdAt
};
const path = "Lain Brain/Notes/Freedom.md";
const otherPath = "Lain Brain/Notes/Other Freedom.md";
const ordinaryPath = "Notes/Ordinary.md";
const files = new Map([
  [path, { path }],
  [otherPath, { path: otherPath }],
  [ordinaryPath, { path: ordinaryPath }]
]);
const store = new Map([
  [path, api.serializeConceptNodeIntoMarkdown("# Freedom", concept, origin)],
  [otherPath, api.serializeConceptNodeIntoMarkdown("# Freedom", other, {
    ...origin,
    candidateId: "candidate-other"
  })],
  [ordinaryPath, "# Ordinary"]
]);
let writes = 0;
const app = {
  workspace: { getActiveFile: () => files.get(ordinaryPath) },
  vault: {
    getMarkdownFiles: () => [...files.values()],
    getFileByPath: (value) => files.get(value) ?? null,
    cachedRead: async (file) => store.get(file.path),
    modify: async (file, markdown) => {
      writes += 1;
      store.set(file.path, markdown);
    }
  }
};
const discovered = await api.loadObsidianConceptIndex(app);
const textContent = (element) => [
  element.text,
  ...element.children.flatMap((child) => textContent(child))
].filter(Boolean);
const allElements = (element) => [
  element,
  ...element.children.flatMap((child) => allElements(child))
];
const findButton = (root, label) => allElements(root).find(
  (element) => element.tag === "button" && element.text === label
);
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Ambiguous lookup visibly returns two choices and never auto-selects.
const lookup = new api.ConceptMaintenanceLookupModal(app, discovered);
lookup.onOpen();
const querySetting = lookup.contentEl.settings.find(
  (setting) => setting.name === "Concept ID, title, or alias"
);
querySetting.textControl.inputEl.change("Freedom");
findButton(lookup.contentEl, "Find Concept").click();
assert.equal(textContent(lookup.contentEl).includes(
  "Multiple concepts use this label. Choose by stable ID and path."
), true);
assert.equal(textContent(lookup.resultsEl).filter((text) => text === "Freedom").length, 2);
assert.equal(writes, 0);

// Ordinary active note is rejected without migration or write.
findButton(lookup.contentEl, "Use Active Note").click();
await flush();
assert.equal(textContent(lookup.contentEl).includes(
  "The selected note is not a ConceptNode"
), true);
assert.equal(writes, 0);

// Actual workspace DOM distinguishes all semantic layers.
const workspace = new api.ConceptMaintenanceWorkspaceModal(
  app,
  discovered,
  path,
  store.get(path),
  concept
);
workspace.onOpen();
const initialText = textContent(workspace.contentEl);
for (const label of [
  "Personal meaning — authoritative",
  "AI interpretation — non-authoritative",
  "External / standard meaning — non-authoritative",
  "Relationships",
  "Unresolved ambiguity",
  "Revision history",
  "Diagnostics",
  "Other concepts use the same label. This does not mean they are the same concept."
]) {
  assert.equal(initialText.includes(label), true, `missing UI label: ${label}`);
}
const definitionEditor = allElements(workspace.contentEl).find(
  (element) => element.attributes["aria-label"] === "Personal definition"
);
assert.equal(definitionEditor.value, "");
assert.equal(definitionEditor.value.includes("AI interpretation"), false);
assert.equal(writes, 0);

// Selecting exact evidence and preparing a diff still performs no write.
findButton(workspace.contentEl, "Use Exact Evidence").click();
assert.equal(workspace.definitionText, evidence.snapshot);
findButton(workspace.contentEl, "Prepare Review").click();
assert.ok(workspace.prepared);
assert.equal(writes, 0);
assert.equal(findButton(workspace.contentEl, "Confirm Update") !== undefined, true);
assert.equal(allElements(workspace.contentEl).some(
  (element) => element.attributes["data-maintenance-diff"] === "true"
), true);

// Back and cancel never write.
findButton(workspace.contentEl, "Back").click();
assert.equal(writes, 0);
findButton(workspace.contentEl, "Cancel").click();
assert.equal(writes, 0);

// A fresh reviewed flow writes exactly once through the actual Confirm control.
const confirmedWorkspace = new api.ConceptMaintenanceWorkspaceModal(
  app,
  discovered,
  path,
  store.get(path),
  concept
);
confirmedWorkspace.onOpen();
findButton(confirmedWorkspace.contentEl, "Use Exact Evidence").click();
findButton(confirmedWorkspace.contentEl, "Prepare Review").click();
findButton(confirmedWorkspace.contentEl, "Confirm Update").click();
await flush();
await flush();
assert.equal(writes, 1);
assert.equal(api.inspectConceptMarkdown(store.get(path))
  .persisted.conceptNode.userDefinition.text, evidence.snapshot);

// The actual Confirm control records one authoritative delta, then enqueues
// only after the origin concept write succeeds. Cancel records nothing.
const semanticEvents = [];
let originEnqueues = 0;
const propagation = {
  getState: () => ({
    deltas: [], jobs: [], pendingDecisions: [], reports: []
  }),
  recordConfirmedDelta: async (delta, vaultPath) => {
    semanticEvents.push({ delta, vaultPath });
    return true;
  },
  markOriginCommittedAndEnqueue: async () => { originEnqueues += 1; },
  markOriginWriteFailed: async () => {},
  resolveDecision: async () => {}
};
const deltaBaseMarkdown = store.get(path);
const deltaBaseConcept = api.inspectConceptMarkdown(deltaBaseMarkdown)
  .persisted.conceptNode;
const cancelWithPropagation = new api.ConceptMaintenanceWorkspaceModal(
  app, await api.loadObsidianConceptIndex(app), path,
  deltaBaseMarkdown, deltaBaseConcept, propagation
);
cancelWithPropagation.onOpen();
findButton(cancelWithPropagation.contentEl, "Cancel").click();
assert.equal(semanticEvents.length, 0);

const deltaWorkspace = new api.ConceptMaintenanceWorkspaceModal(
  app, await api.loadObsidianConceptIndex(app), path,
  deltaBaseMarkdown, deltaBaseConcept, propagation
);
deltaWorkspace.onOpen();
const deltaEditor = allElements(deltaWorkspace.contentEl).find(
  (element) => element.attributes["aria-label"] === "Personal definition"
);
deltaEditor.input("My explicitly redefined personal meaning.");
findButton(deltaWorkspace.contentEl, "Prepare Review").click();
findButton(deltaWorkspace.contentEl, "Confirm Update").click();
await flush();
await flush();
assert.equal(semanticEvents.length, 1);
assert.equal(semanticEvents[0].delta.authority, "user_confirmed");
assert.equal(semanticEvents[0].delta.kind, "personal_definition_redefined");
assert.equal(originEnqueues, 1);
assert.equal(writes, 2);

// Stale underlying content is rejected at confirmation with zero writes.
const currentMarkdown = store.get(path);
const currentConcept = api.inspectConceptMarkdown(currentMarkdown)
  .persisted.conceptNode;
const staleWorkspace = new api.ConceptMaintenanceWorkspaceModal(
  app,
  await api.loadObsidianConceptIndex(app),
  path,
  currentMarkdown,
  currentConcept
);
staleWorkspace.onOpen();
const staleEditor = allElements(staleWorkspace.contentEl).find(
  (element) => element.attributes["aria-label"] === "Personal definition"
);
staleEditor.input("A later exact definition.");
findButton(staleWorkspace.contentEl, "Prepare Review").click();
store.set(path, currentMarkdown + "\nExternal edit");
findButton(staleWorkspace.contentEl, "Confirm Update").click();
await flush();
assert.equal(writes, 2);
assert.equal(staleWorkspace.statusMessage,
  "The concept changed. Reload and review the update again.");

// Actual workspace DOM exposes review-only structural conflict controls.
let conflictStatus = "open";
let conflictDismissals = 0;
const conflictRecord = {
  schemaVersion: 1,
  id: "structural-conflict:modal",
  ruleId: "DISTINCTION_VS_EQUIVALENCE",
  category: "hard_conflict",
  severity: "conflict",
  status: "open",
  affectedConceptIds: [currentConcept.id, "concept-other-stable-id"],
  relationshipEvidence: [{
    ownerConceptId: currentConcept.id,
    ownerRevision: currentConcept.revision,
    relationshipId: "relationship-equivalent",
    relationType: "equivalent_to",
    targetConceptId: "concept-other-stable-id",
    sourceReferences: ["semantic-delta:test"]
  }, {
    ownerConceptId: currentConcept.id,
    ownerRevision: currentConcept.revision,
    relationshipId: "relationship-distinct",
    relationType: "explicitly_distinct_from",
    targetConceptId: "concept-other-stable-id",
    sourceReferences: ["semantic-delta:test"]
  }],
  relevantRevisions: { [currentConcept.id]: currentConcept.revision },
  reason: "The same concepts are both explicitly distinct and equivalent.",
  provenance: {
    detector: "deterministic_rule_registry",
    detectedAt: "2026-08-15T06:08:00.000Z",
    originatingSemanticDeltaIds: ["semantic-delta:test"]
  }
};
const conflictPropagation = {
  getState: () => ({
    deltas: [], jobs: [], pendingDecisions: [], reports: [],
    structuralConflicts: [{ ...conflictRecord, status: conflictStatus }]
  }),
  resolveDecision: async () => {},
  dismissStructuralConflict: async () => {
    conflictStatus = "dismissed";
    conflictDismissals += 1;
  }
};
const conflictWorkspace = new api.ConceptMaintenanceWorkspaceModal(
  app,
  await api.loadObsidianConceptIndex(app),
  path,
  currentMarkdown,
  currentConcept,
  conflictPropagation
);
conflictWorkspace.onOpen();
assert.equal(textContent(conflictWorkspace.contentEl).includes(
  "Structural conflicts"), true);
assert.equal(textContent(conflictWorkspace.contentEl).includes(
  "Potential structural conflict detected."), true);
assert.equal(textContent(conflictWorkspace.contentEl).some((text) =>
  text.includes(currentConcept.id)), true);
assert.equal(textContent(conflictWorkspace.contentEl).some((text) =>
  text.includes("concept-other-stable-id")), true);
assert.equal(allElements(conflictWorkspace.contentEl).some(
  (element) => element.tag === "button" && /fix/iu.test(element.text)), false);
const conflictDetails = allElements(conflictWorkspace.contentEl).find(
  (element) => element.attributes["data-structural-conflict-details"] ===
    conflictRecord.id
);
assert.equal(conflictDetails.style.display, "none");
findButton(conflictWorkspace.contentEl, "Inspect").click();
assert.equal(conflictDetails.style.display, "block");
findButton(conflictWorkspace.contentEl, "Dismiss").click();
await flush();
assert.equal(conflictDismissals, 1);
assert.equal(conflictStatus, "dismissed");
assert.equal(textContent(conflictWorkspace.contentEl).includes(
  "Status: dismissed"), true);

console.log(JSON.stringify({
  ambiguousLookupChoices: 2,
  ordinaryNoteRejected: true,
  semanticLayerLabelsDistinct: true,
  openEditPrepareCancelWrites: 0,
  explicitConfirmWrites: 2,
  confirmedSemanticDeltas: semanticEvents.length,
  staleAdditionalWrites: 0,
  actualModalDom: true,
  structuralConflictVisible: true,
  structuralConflictInspectAndDismiss: true,
  destructiveFixButtons: 0,
  result: "PASS"
}, null, 2));
