import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

class FakeStyle {
  setProperty(name, value) {
    this[name] = value;
  }
}

class FakeElement {
  static scrollIntoViewCalls = 0;
  static document = null;

  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = new FakeStyle();
    this.ownerDocument = FakeElement.document;
    this.classList = {
      add: (...names) => this.addClass(...names),
      remove: () => {},
      contains: (name) => (this.attributes.get("class") ?? "")
        .split(/\s+/)
        .includes(name)
    };
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.readOnly = false;
    this.rows = 0;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.isConnected = true;
  }

  get offsetTop() {
    if (this.parentElement === null) return 0;
    return this.parentElement.children.indexOf(this) * 140;
  }

  get offsetHeight() {
    return 120;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  createEl(tagName, options = {}) {
    const child = this.appendChild(new FakeElement(tagName));
    if (typeof options.text === "string") child.textContent = options.text;
    if (typeof options.cls === "string") child.addClass(options.cls);
    return child;
  }

  createDiv(options = {}) {
    return this.createEl("div", options);
  }

  createSpan(options = {}) {
    return this.createEl("span", options);
  }

  addClass(...names) {
    const existing = this.attributes.get("class") ?? "";
    this.attributes.set("class", [existing, ...names].filter(Boolean).join(" "));
  }

  setAttr(name, value) {
    this.attributes.set(name, String(value));
    if (name === "data-scroll-container") this.clientHeight = 150;
  }

  setAttribute(name, value) {
    this.setAttr(name, value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setText(value) {
    this.textContent = String(value);
  }

  empty() {
    this.children = [];
    this.textContent = "";
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ currentTarget: this, target: this });
    }
  }

  click() {
    if (this.tagName === "INPUT" && this.type === "checkbox") {
      this.checked = !this.checked;
      this.dispatch("input");
      this.dispatch("change");
    }
    this.dispatch("click");
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);

    const visit = (element) => {
      for (const child of element.children) {
        let matched = false;
        if (attribute !== null) {
          const [, name, value] = attribute;
          matched = child.attributes.has(name) &&
            (value === undefined || child.attributes.get(name) === value);
        } else if (selector.startsWith(".")) {
          matched = child.classList.contains(selector.slice(1));
        } else if (selector === child.tagName.toLowerCase()) {
          matched = true;
        }
        if (matched) matches.push(child);
        visit(child);
      }
    };

    visit(this);
    return matches;
  }

  contains(other) {
    if (other === this) return true;
    return this.children.some((child) => child.contains(other));
  }

  closest(selector) {
    let current = this;
    while (current !== null) {
      if (selector.startsWith(".") && current.classList.contains(selector.slice(1))) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  remove() {
    if (this.parentElement === null) return;
    this.parentElement.children = this.parentElement.children.filter(
      (child) => child !== this
    );
    this.parentElement = null;
  }

  scrollIntoView() {
    FakeElement.scrollIntoViewCalls += 1;
    let root = this;
    while (root.parentElement !== null) root = root.parentElement;
    root.scrollTop = 999;
  }
}

const fakeDocument = {
  defaultView: {
    requestAnimationFrame(callback) { callback(); }
  },
  createElement(tagName) {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  },
  addEventListener() {},
  removeEventListener() {},
  getSelection() { return null; },
  createRange() {
    return {
      selectNodeContents() {}
    };
  }
};
FakeElement.document = fakeDocument;

class FakeModal {
  constructor(app) {
    this.app = app;
    this.contentEl = new FakeElement("div");
    this.modalEl = new FakeElement("div");
    this.modalContainerEl = new FakeElement("div");
    this.modalContainerEl.addClass("modal-container");
    this.modalEl.appendChild(this.contentEl);
    this.modalContainerEl.appendChild(this.modalEl);
    this.title = "";
  }
  setTitle(value) { this.title = value; }
  close() { this.onClose?.(); }
}

class FakeSetting {
  constructor(container) {
    this.settingEl = container.createDiv();
  }
  setName() { return this; }
  setDisabled() { return this; }
  addDropdown(callback) {
    callback({
      addOption() { return this; },
      setValue() { return this; },
      onChange() { return this; }
    });
    return this;
  }
}

class FakeComponent {
  load() {}
  unload() {}
}

function fakeMarkdownRender(_app, markdown, container) {
  const mathPattern = /(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g;
  let cursor = 0;
  for (const match of markdown.matchAll(mathPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      container.createSpan({ text: markdown.slice(cursor, index) });
    }
    const math = container.createSpan();
    math.addClass("math");
    math.setText("rendered math");
    cursor = index + match[0].length;
  }
  if (cursor < markdown.length) {
    container.createSpan({ text: markdown.slice(cursor) });
  }
  return Promise.resolve();
}

let formalizationRequestCount = 0;
async function fakeRequestUrl() {
  formalizationRequestCount += 1;
  return {
    json: {
      choices: [{
        message: {
          content: JSON.stringify({
            speechAct: "theorem_claim",
            objects: [],
            explicitAssumptions: [],
            implicitAssumptions: [],
            quantifiers: "For every n",
            conclusion: "n + 0 = n",
            ambiguities: [],
            missingConditions: [],
            normalizedStatement: "For every n, n + 0 = n.",
            latexStatement: "\\forall n, n + 0 = n",
            semanticChanges: []
          })
        }
      }]
    }
  };
}

const built = await esbuild.build({
  stdin: {
    contents: [
      "export { ReviewClaimsModal } from './src/ReviewClaimsModal';",
      "export { LainBrainSession } from './src/LainBrainSession';",
      "export { createFormalizationRecord } from './src/FormalizationProtocol';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "review-claims-modal-ux-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
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
          "exports.App = class {};",
          "exports.Modal = globalThis.__FakeModal;",
          "exports.Setting = globalThis.__FakeSetting;",
          "exports.Component = globalThis.__FakeComponent;",
          "exports.MarkdownRenderer = { render: (...args) => globalThis.__FakeMarkdownRender(...args) };",
          "exports.normalizePath = (value) => value;",
          "exports.requestUrl = (...args) => globalThis.__FakeRequestUrl(...args);"
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
  console,
  URL,
  crypto: {
    randomUUID: () => "review-ux-" + Math.random().toString(36).slice(2, 8)
  },
  setTimeout,
  clearTimeout,
  prompt: () => "Rejected during review",
  __FakeMarkdownRender: fakeMarkdownRender,
  __FakeRequestUrl: fakeRequestUrl,
  __FakeModal: FakeModal,
  __FakeSetting: FakeSetting,
  __FakeComponent: FakeComponent
});

const {
  ReviewClaimsModal,
  LainBrainSession,
  createFormalizationRecord
} = module.exports;

function makeApp() {
  return {
    vault: {
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null,
      getFileByPath: () => null,
      getFolderByPath: () => null,
      cachedRead: async () => "",
      read: async () => ""
    },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) },
    metadataCache: { getFileCache: () => null }
  };
}

function makeCandidate(id = "candidate-review-ux") {
  return {
    id,
    title: "Review UX",
    primaryConcept: { name: "review UX", aliases: [] },
    markdown: "# Review UX",
    sourceMessageIds: ["message-1"],
    viewMode: "preview",
    userEdited: false,
    revision: 1,
    claims: [],
    formalizationIds: []
  };
}

function makeSuggestion(candidateId, suffix) {
  return {
    id: `claim-${candidateId}-${suffix}`,
    text: `For every n, n + 0 = n (${suffix}).`,
    kind: "formal_statement",
    verification: "lean_pending",
    sourceReferences: [],
    sourceMessageIds: ["message-1"]
  };
}

function makePendingRecord(claimId, text) {
  return createFormalizationRecord({
    claimId,
    sourceRefs: [{ messageId: "message-1", snapshot: text }],
    speechAct: "theorem_claim",
    objects: [],
    explicitAssumptions: [],
    implicitAssumptions: [],
    quantifiers: "For every n",
    conclusion: "n + 0 = n",
    ambiguities: [],
    missingConditions: [],
    semanticChanges: [],
    aiNormalizedStatement: text,
    latexStatement: "\\forall n, n + 0 = n"
  });
}

function makeHarness(suggestions, { injectPreviews = true } = {}) {
  const app = makeApp();
  const candidate = makeCandidate();
  const session = new LainBrainSession(
    app,
    () => "test-api-key",
    () => null,
    { analyzeImage: async () => { throw new Error("Vision not expected"); } },
    async () => { throw new Error("Chat not expected"); },
    async () => []
  );
  session.candidates = [candidate];
  session.activeCandidateId = candidate.id;
  session.messages = [{
    id: "message-1",
    role: "user",
    content: "For every n, n + 0 = n.",
    includeInHistory: true
  }];

  if (injectPreviews) {
    for (const suggestion of suggestions.filter(
      (item) => item.kind === "formal_statement"
    )) {
      const record = makePendingRecord(suggestion.id, suggestion.text);
      session.suggestionPreviews.set(suggestion.id, [{
        record,
        suggestionId: suggestion.id,
        sourceText: suggestion.text,
        sourceKind: suggestion.kind
      }]);
    }
  }

  const modal = new ReviewClaimsModal(app, session, candidate.id);
  modal.loading = false;
  modal.rows = suggestions.map((item) => ({ item, selected: false }));
  modal.render();
  return { modal, session, candidate };
}

function allElements(root) {
  const result = [];
  const visit = (element) => {
    result.push(element);
    for (const child of element.children) visit(child);
  };
  visit(root);
  return result;
}

function findButton(root, text) {
  return allElements(root).find(
    (element) => element.tagName === "BUTTON" && element.textContent === text
  );
}

function hasText(root, text) {
  return allElements(root).some((element) => element.textContent === text);
}

function findClaimTextarea(root, text) {
  return allElements(root).find(
    (element) => element.tagName === "TEXTAREA" && element.value === text
  );
}

function findInclude(root, claimId) {
  return allElements(root).find(
    (element) =>
      element.tagName === "INPUT" &&
      element.getAttribute("data-include-claim-id") === claimId
  );
}

function findClaimCard(root, claimId) {
  return allElements(root).find(
    (element) => element.getAttribute("data-claim-id") === claimId
  );
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

async function formalizeThroughModal(modal) {
  const button = findButton(modal.contentEl, "Formalize");
  assert.ok(button, "Actual Formalize action must render");
  button.click();
  await waitFor(
    () => findButton(modal.contentEl, "Accept") !== undefined,
    "Formalization preview did not appear"
  );
}

// A native-style checkbox click on a non-formal claim updates the exact
// current row that Apply reads, then commits that selected claim.
{
  const suggestion = {
    ...makeSuggestion("candidate-review-ux", "open-question"),
    kind: "open_question",
    verification: "source_pending",
    text: "Is this still an open question?"
  };
  const { modal, session, candidate } = makeHarness([suggestion]);
  let appliedItems = null;
  const originalApply = session.applyReviewedClaims.bind(session);
  session.applyReviewedClaims = (candidateId, items) => {
    appliedItems = items;
    return originalApply(candidateId, items);
  };

  const checkbox = allElements(modal.contentEl).find(
    (element) =>
      element.tagName === "INPUT" &&
      element.type === "checkbox" &&
      element.getAttribute("data-include-claim-id") === suggestion.id
  );
  assert.ok(checkbox, "Open-question Include checkbox must render");
  checkbox.click();
  assert.equal(checkbox.checked, true);
  assert.equal(modal.rows[0].selected, true);

  // Exercise the same rerender path used by modal status updates.
  modal.render();
  const rerenderedCheckbox = allElements(modal.contentEl).find(
    (element) =>
      element.tagName === "INPUT" &&
      element.getAttribute("data-include-claim-id") === suggestion.id
  );
  assert.ok(rerenderedCheckbox);
  assert.equal(rerenderedCheckbox.checked, true);
  assert.equal(modal.rows[0].selected, true);

  findButton(modal.contentEl, "Apply selected claims").click();
  assert.equal(hasText(modal.contentEl, "Select at least one claim to apply."), false);
  assert.deepEqual(Array.from(appliedItems, (item) => item.id), [suggestion.id]);
  assert.equal(candidate.claims.length, 1);
  assert.equal(hasText(modal.contentEl, "Applied 1 claim."), true);
  assert.equal(hasText(modal.contentEl, "✓ Applied"), true);
  modal.onClose();
  console.log("REVIEW-UX-A PASS: open-question native checkbox click survives rerender and Apply");
}

// Editable source remains raw while its explicitly rendered presentation goes
// through the shared Obsidian Markdown/math path.
{
  const raw = "对任意实数 $a$，有 $a + 0 = 0 + a = a$。";
  const suggestion = {
    ...makeSuggestion("candidate-review-ux", "latex-render"),
    text: raw
  };
  const { modal } = makeHarness([suggestion]);
  await new Promise((resolve) => setTimeout(resolve, 220));

  const source = findClaimTextarea(modal.contentEl, raw);
  const preview = modal.contentEl.querySelector(
    `[data-rendered-claim-preview="${suggestion.id}"]`
  );
  assert.ok(source);
  assert.equal(source.value, raw, "Editable source must retain raw TeX delimiters");
  assert.ok(preview, "Rendered claim preview must exist");
  assert.ok(
    allElements(preview).some((element) => element.classList.contains("math")),
    "Rendered preview must contain math presentation DOM"
  );
  assert.equal(
    allElements(preview).some(
      (element) => element.textContent.includes("$a$") ||
        element.textContent.includes("$a + 0 = 0 + a = a$")
    ),
    false,
    "Rendered presentation must not expose literal TeX delimiters"
  );

  const accept = findButton(modal.contentEl, "Accept");
  accept.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const collapsed = modal.contentEl.querySelector(
    `[data-rendered-formalization-preview="${modal.rows[0].item.id}"]`
  );
  // Record IDs are independent of row IDs; locate by the presentation marker.
  const collapsedPreview = allElements(modal.contentEl).find(
    (element) => element.getAttribute("data-rendered-formalization-preview") !== null
  );
  assert.ok(collapsedPreview);
  assert.ok(
    allElements(collapsedPreview).some((element) => element.classList.contains("math")),
    "Collapsed formalization presentation must also render math"
  );
  assert.equal(collapsed, null);
  modal.onClose();
  console.log("REVIEW-MATH PASS: raw editor source and rendered mathematical presentations stay distinct");
}
// Formal Include eligibility is enforced by the actual row DOM.
{
  const suggestion = makeSuggestion("candidate-review-ux", "no-preview");
  const { modal } = makeHarness([suggestion], { injectPreviews: false });
  const include = findInclude(modal.contentEl, suggestion.id);
  assert.ok(include);
  assert.equal(include.disabled, true);
  assert.equal(include.checked, false);
  assert.equal(modal.rows[0].selected, false);
  assert.equal(hasText(modal.contentEl, "Formalize before selecting for Apply"), true);
  modal.onClose();
  console.log("REVIEW-INVARIANT-A PASS: no-preview formal row cannot remain selected");
}

{
  const suggestion = makeSuggestion("candidate-review-ux", "pending-include");
  const { modal } = makeHarness([suggestion], { injectPreviews: false });
  await formalizeThroughModal(modal);
  const include = findInclude(modal.contentEl, suggestion.id);
  assert.equal(include.disabled, true);
  assert.equal(include.checked, false);
  assert.equal(modal.rows[0].selected, false);
  assert.equal(hasText(modal.contentEl, "Review formalization before selecting for Apply"), true);
  modal.onClose();
  console.log("REVIEW-INVARIANT-B PASS: pending formal preview cannot be selected");
}

{
  const suggestion = makeSuggestion("candidate-review-ux", "accepted-include");
  const { modal, candidate } = makeHarness([suggestion], { injectPreviews: false });
  await formalizeThroughModal(modal);
  findButton(modal.contentEl, "Accept").click();
  const include = findInclude(modal.contentEl, suggestion.id);
  assert.equal(include.disabled, false);
  assert.equal(include.checked, true);
  assert.equal(modal.rows[0].selected, true);
  findButton(modal.contentEl, "Apply selected claims").click();
  assert.equal(candidate.claims.length, 1);
  assert.equal(hasText(modal.contentEl, "Applied 1 claim."), true);
  modal.onClose();
  console.log("REVIEW-INVARIANT-C PASS: accepted current preview enables and selects Include");
}

// Editing an accepted formal row clears its real selected state immediately;
// an independently selected factual row can still Apply.
{
  const formal = makeSuggestion("candidate-review-ux", "stale-clear");
  const factual = {
    ...makeSuggestion("candidate-review-ux", "stale-factual"),
    kind: "factual_claim",
    verification: "source_pending",
    text: "This factual row should still Apply."
  };
  const { modal, candidate } = makeHarness(
    [formal, factual],
    { injectPreviews: false }
  );
  await formalizeThroughModal(modal);
  findButton(modal.contentEl, "Accept").click();
  findInclude(modal.contentEl, factual.id).click();

  const claimText = findClaimTextarea(modal.contentEl, formal.text);
  claimText.value = formal.text + " Changed.";
  claimText.dispatch("input");
  const formalInclude = findInclude(modal.contentEl, formal.id);
  assert.equal(formalInclude.checked, false);
  assert.equal(formalInclude.disabled, true);
  assert.equal(modal.rows.find((row) => row.item.id === formal.id).selected, false);
  assert.equal(hasText(modal.contentEl, "⚠ Stale"), true);

  findButton(modal.contentEl, "Apply selected claims").click();
  assert.equal(candidate.claims.length, 1);
  assert.equal(candidate.claims[0].id, factual.id);
  assert.equal(hasText(modal.contentEl, "Applied 1 claim."), true);
  modal.onClose();
  console.log("REVIEW-INVARIANT-D PASS: stale transition clears actual selection and factual still applies");
}

// Rejecting an accepted preview clears Include on rerender.
{
  const suggestion = makeSuggestion("candidate-review-ux", "reject-clear");
  const { modal } = makeHarness([suggestion], { injectPreviews: false });
  await formalizeThroughModal(modal);
  findButton(modal.contentEl, "Accept").click();
  assert.equal(modal.rows[0].selected, true);
  findButton(modal.contentEl, "Expand").click();
  findButton(modal.contentEl, "Reject").click();
  const include = findInclude(modal.contentEl, suggestion.id);
  assert.equal(include.checked, false);
  assert.equal(include.disabled, true);
  assert.equal(modal.rows[0].selected, false);
  modal.onClose();
  console.log("REVIEW-INVARIANT-E PASS: rejected transition clears actual selection");
}

// A non-ready formal row is disabled and cannot block a selected factual row.
{
  const factual = {
    ...makeSuggestion("candidate-review-ux", "ready-factual"),
    kind: "factual_claim",
    verification: "source_pending",
    text: "A selectable factual row."
  };
  const formal = makeSuggestion("candidate-review-ux", "not-ready-formal");
  const { modal, candidate } = makeHarness(
    [factual, formal],
    { injectPreviews: false }
  );
  assert.equal(findInclude(modal.contentEl, formal.id).disabled, true);
  assert.equal(modal.rows.find((row) => row.item.id === formal.id).selected, false);
  findInclude(modal.contentEl, factual.id).click();
  findButton(modal.contentEl, "Apply selected claims").click();
  assert.deepEqual(Array.from(candidate.claims, (claim) => claim.id), [factual.id]);
  assert.equal(hasText(modal.contentEl, "Applied 1 claim."), true);
  modal.onClose();
  console.log("REVIEW-INVARIANT-F PASS: non-ready formal cannot block factual batch");
}

// The Session guard remains defensive if invalid selected state is forced
// after render; the exact card is marked and the claims list reveals it.
{
  const fillers = Array.from({ length: 4 }, (_, index) => ({
    ...makeSuggestion("candidate-review-ux", `blocker-fill-${index}`),
    kind: "factual_claim",
    verification: "source_pending",
    text: `Unselected filler ${index}.`
  }));
  const blocker = makeSuggestion("candidate-review-ux", "forced-blocker");
  const { modal, candidate } = makeHarness(
    [...fillers, blocker],
    { injectPreviews: false }
  );
  modal.rows.find((row) => row.item.id === blocker.id).selected = true;
  findButton(modal.contentEl, "Apply selected claims").click();

  const blockerCard = findClaimCard(modal.contentEl, blocker.id);
  const list = modal.contentEl.querySelector("[data-scroll-container]");
  assert.equal(candidate.claims.length, 0);
  assert.equal(blockerCard.getAttribute("data-apply-blocker"), "true");
  assert.equal(
    hasText(
      modal.contentEl,
      `Claim "${blocker.text}" must have an accepted current formalization before Apply.`
    ),
    true
  );
  assert.ok(list.scrollTop > 0, "Claims list must reveal the exact blocker");
  assert.equal(modal.contentEl.scrollTop, 0);
  modal.onClose();
  console.log("REVIEW-INVARIANT-G PASS: defensive failure highlights and reveals exact blocker");
}
// Simplest factual claim: the actual checkbox and Apply button pass the
// current row object through Session and leave the modal open as Applied.
{
  const suggestion = {
    ...makeSuggestion("candidate-review-ux", "factual-click"),
    kind: "factual_claim",
    verification: "source_pending",
    text: "This factual claim still needs a source."
  };
  const { modal, session, candidate } = makeHarness([suggestion]);
  let applyCalls = 0;
  let receivedItems = null;
  const originalApply = session.applyReviewedClaims.bind(session);
  session.applyReviewedClaims = (candidateId, items) => {
    applyCalls += 1;
    receivedItems = items;
    return originalApply(candidateId, items);
  };

  const include = allElements(modal.contentEl).find(
    (element) => element.getAttribute("data-include-claim-id") === suggestion.id
  );
  include.click();
  findButton(modal.contentEl, "Apply selected claims").click();

  assert.equal(applyCalls, 1, "Actual Apply handler must call Session once");
  assert.deepEqual(Array.from(receivedItems, (item) => item.id), [suggestion.id]);
  assert.equal(receivedItems[0].kind, "factual_claim");
  assert.equal(candidate.claims.length, 1);
  assert.equal(hasText(modal.contentEl, "Applied 1 claim."), true);
  assert.equal(hasText(modal.contentEl, "✓ Applied"), true);
  modal.onClose();
  console.log("REVIEW-NONFORMAL-A PASS: factual checkbox → actual Apply commits and renders success");
}

// A factual row that is already selected in modal state uses the same actual
// button path without requiring another checkbox event.
{
  const suggestion = {
    ...makeSuggestion("candidate-review-ux", "factual-selected"),
    kind: "factual_claim",
    verification: "source_pending",
    text: "An already-selected factual claim."
  };
  const { modal, session, candidate } = makeHarness([suggestion]);
  modal.rows[0].selected = true;
  modal.render();
  let receivedIds = [];
  const originalApply = session.applyReviewedClaims.bind(session);
  session.applyReviewedClaims = (candidateId, items) => {
    receivedIds = Array.from(items, (item) => item.id);
    return originalApply(candidateId, items);
  };

  findButton(modal.contentEl, "Apply selected claims").click();
  assert.deepEqual(receivedIds, [suggestion.id]);
  assert.equal(candidate.claims.length, 1);
  assert.equal(hasText(modal.contentEl, "Applied 1 claim."), true);
  assert.equal(hasText(modal.contentEl, "✓ Applied"), true);
  modal.onClose();
  console.log("REVIEW-NONFORMAL-B PASS: preselected factual row applies through actual button");
}

// An unselected formal row cannot block a selected factual row.
{
  const factual = {
    ...makeSuggestion("candidate-review-ux", "mixed-factual"),
    kind: "factual_claim",
    verification: "source_pending",
    text: "Only this factual row is selected."
  };
  const formal = makeSuggestion("candidate-review-ux", "mixed-formal");
  const { modal, session, candidate } = makeHarness([factual, formal]);
  let receivedItems = null;
  const originalApply = session.applyReviewedClaims.bind(session);
  session.applyReviewedClaims = (candidateId, items) => {
    receivedItems = items;
    return originalApply(candidateId, items);
  };

  const factualInclude = allElements(modal.contentEl).find(
    (element) => element.getAttribute("data-include-claim-id") === factual.id
  );
  factualInclude.click();
  findButton(modal.contentEl, "Apply selected claims").click();

  assert.deepEqual(Array.from(receivedItems, (item) => item.id), [factual.id]);
  assert.equal(candidate.claims.length, 1);
  assert.equal(candidate.claims[0].id, factual.id);
  assert.equal(hasText(modal.contentEl, "Applied 1 claim."), true);
  assert.equal(hasText(modal.contentEl, "✓ Applied"), true);
  modal.onClose();
  console.log("REVIEW-NONFORMAL-C PASS: unselected formal row does not block factual Apply");
}

// A factual row and a current accepted formal row travel through one actual
// Apply click and commit exactly once each. The captured trace covers stages
// 1-13 without introducing production logging.
{
  formalizationRequestCount = 0;
  const factual = {
    ...makeSuggestion("candidate-review-ux", "e2e-factual"),
    kind: "factual_claim",
    verification: "source_pending",
    text: "A factual claim selected in the mixed batch."
  };
  const formal = makeSuggestion("candidate-review-ux", "e2e-formal");
  const { modal, session, candidate } = makeHarness(
    [factual, formal],
    { injectPreviews: false }
  );
  await formalizeThroughModal(modal);
  findButton(modal.contentEl, "Accept").click();
  findInclude(modal.contentEl, factual.id).click();

  const trace = {
    clickFired: false,
    rowsBefore: modal.rows.map((row) => ({
      id: row.item.id,
      kind: row.item.kind,
      selected: row.selected
    })),
    selectedIds: [],
    payloadIds: [],
    applyResult: null,
    successMessage: "",
    errorMessage: "",
    committedIds: [],
    renderedAppliedCount: 0
  };
  const originalApply = session.applyReviewedClaims.bind(session);
  session.applyReviewedClaims = (candidateId, items) => {
    trace.clickFired = true;
    trace.selectedIds = modal.rows.filter((row) => row.selected).map((row) => row.item.id);
    trace.payloadIds = Array.from(items, (item) => item.id);
    trace.applyResult = originalApply(candidateId, items);
    return trace.applyResult;
  };

  findButton(modal.contentEl, "Apply selected claims").click();
  trace.successMessage = modal.successMessage;
  trace.errorMessage = modal.error;
  trace.committedIds = Array.from(modal.committedIds);
  trace.renderedAppliedCount = allElements(modal.contentEl).filter(
    (element) => element.textContent === "✓ Applied"
  ).length;

  assert.equal(trace.clickFired, true);
  assert.deepEqual(new Set(trace.selectedIds), new Set([factual.id, formal.id]));
  assert.deepEqual(new Set(trace.payloadIds), new Set([factual.id, formal.id]));
  assert.equal(trace.applyResult.ok, true);
  assert.equal(trace.applyResult.appliedCount, 2);
  assert.equal(trace.successMessage, "Applied 2 claims.");
  assert.equal(trace.errorMessage, "");
  assert.deepEqual(new Set(trace.committedIds), new Set([factual.id, formal.id]));
  assert.equal(trace.renderedAppliedCount, 2);
  assert.equal(hasText(modal.contentEl, "Applied 2 claims."), true);
  assert.equal(candidate.claims.length, 2);
  assert.equal(Object.keys(session.getFormalizationIndex().records).length, 1);
  assert.equal(formalizationRequestCount, 1);
  modal.onClose();
  console.log("REVIEW-APPLY-E2E-C PASS: factual + accepted formal commit once through actual DOM click");
}
// A successful Apply with a non-fatal legacy Knowledge-status warning must
// still transition the modal row to Applied and show success.
{
  const suggestion = {
    ...makeSuggestion("candidate-review-ux", "legacy-warning"),
    kind: "factual_claim",
    verification: "source_pending",
    text: "A factual claim in a legacy candidate."
  };
  const { modal, session, candidate } = makeHarness([suggestion]);
  candidate.markdown =
    "# Review UX\n\n## Knowledge status\n\nLegacy unmanaged status.";
  modal.rows[0].selected = true;
  modal.render();
  let applyResult = null;
  const originalApply = session.applyReviewedClaims.bind(session);
  session.applyReviewedClaims = (candidateId, items) => {
    applyResult = originalApply(candidateId, items);
    return applyResult;
  };

  findButton(modal.contentEl, "Apply selected claims").click();
  assert.equal(applyResult.ok, true);
  assert.equal(applyResult.appliedCount, 1);
  assert.equal(typeof applyResult.warning, "string");
  assert.equal(candidate.claims.length, 1);
  assert.equal(hasText(modal.contentEl, "Applied 1 claim."), true);
  assert.equal(hasText(modal.contentEl, "✓ Applied"), true);
  assert.equal(
    hasText(
      modal.contentEl,
      "Knowledge status could not be updated safely. Review the candidate Markdown manually."
    ),
    true,
    "Non-fatal warning remains visible alongside successful Apply state"
  );
  modal.onClose();
  console.log("REVIEW-NONFORMAL-WARNING PASS: warning no longer hides successful Apply state");
}
// Real Formalize → Accept → Apply wiring recognizes the same current preview.
{
  formalizationRequestCount = 0;
  const suggestion = makeSuggestion("candidate-review-ux", "real-path");
  const { modal, session, candidate } = makeHarness(
    [suggestion],
    { injectPreviews: false }
  );

  await formalizeThroughModal(modal);
  const pending = session.getFormalizationPreviewsForSuggestion(suggestion.id);
  assert.equal(pending.length, 1);
  const previewId = pending[0].record.id;
  assert.equal(pending[0].record.reviewStatus, "pending");

  findButton(modal.contentEl, "Accept").click();
  const accepted = session.getCurrentFormalizationPreviewForSuggestion(
    suggestion.id,
    suggestion.text,
    suggestion.kind,
    "accepted"
  );
  assert.ok(accepted);
  assert.equal(accepted.record.id, previewId);
  assert.equal(hasText(modal.contentEl, "Accepted ✓"), true);
  const include = allElements(modal.contentEl).find(
    (element) =>
      element.tagName === "INPUT" &&
      element.getAttribute("data-include-claim-id") === suggestion.id
  );
  assert.equal(include.checked, true);

  findButton(modal.contentEl, "Apply selected claims").click();
  assert.equal(hasText(modal.contentEl, "Formalize and review this formal statement before applying it."), false);
  assert.equal(candidate.claims.length, 1);
  assert.equal(candidate.claims[0].formalizationIds.length, 1);
  assert.equal(candidate.claims[0].formalizationIds[0], previewId);
  assert.equal(session.getFormalizationIndex().records[previewId].reviewStatus, "accepted");
  assert.equal(formalizationRequestCount, 1, "Apply must not call the LLM again");
  modal.onClose();
  console.log("REVIEW-IDENTITY-A PASS: actual Formalize → Accept → Apply materializes the same preview once");
}

// Editing the claim source after Accept immediately changes the visible badge
// to stale and removes it from the pending Apply selection.
{
  formalizationRequestCount = 0;
  const suggestion = makeSuggestion("candidate-review-ux", "stale-path");
  const { modal, session, candidate } = makeHarness(
    [suggestion],
    { injectPreviews: false }
  );
  await formalizeThroughModal(modal);
  findButton(modal.contentEl, "Accept").click();

  const claimText = findClaimTextarea(modal.contentEl, suggestion.text);
  assert.ok(claimText);
  claimText.value = suggestion.text + " Changed after review.";
  claimText.dispatch("input");
  assert.equal(hasText(modal.contentEl, "Accepted ✓"), false);
  assert.equal(hasText(modal.contentEl, "⚠ Stale"), true);

  findButton(modal.contentEl, "Apply selected claims").click();
  assert.equal(hasText(modal.contentEl, "Select at least one claim to apply."), true);
  assert.equal(candidate.claims.length, 0);
  assert.equal(session.getFormalizationIndex().records && Object.keys(session.getFormalizationIndex().records).length, 0);
  assert.equal(formalizationRequestCount, 1);
  modal.onClose();
  console.log("REVIEW-IDENTITY-B PASS: edited source makes accepted preview visibly stale and blocks Apply");
}

// Pending previews remain unselected and do not satisfy Apply.
{
  formalizationRequestCount = 0;
  const suggestion = makeSuggestion("candidate-review-ux", "pending-path");
  const { modal, candidate } = makeHarness(
    [suggestion],
    { injectPreviews: false }
  );
  await formalizeThroughModal(modal);
  const include = allElements(modal.contentEl).find(
    (element) => element.getAttribute("data-include-claim-id") === suggestion.id
  );
  include.click();
  findButton(modal.contentEl, "Apply selected claims").click();
  assert.equal(hasText(modal.contentEl, "Select at least one claim to apply."), true);
  assert.equal(candidate.claims.length, 0);
  assert.equal(formalizationRequestCount, 1);
  modal.onClose();
  console.log("REVIEW-IDENTITY-C PASS: pending preview blocks Apply");
}

// Rejected previews remain unselected and do not satisfy Apply.
{
  formalizationRequestCount = 0;
  const suggestion = makeSuggestion("candidate-review-ux", "rejected-path");
  const { modal, candidate } = makeHarness(
    [suggestion],
    { injectPreviews: false }
  );
  await formalizeThroughModal(modal);
  findButton(modal.contentEl, "Reject").click();
  const include = allElements(modal.contentEl).find(
    (element) => element.getAttribute("data-include-claim-id") === suggestion.id
  );
  include.click();
  findButton(modal.contentEl, "Apply selected claims").click();
  assert.equal(hasText(modal.contentEl, "Select at least one claim to apply."), true);
  assert.equal(candidate.claims.length, 0);
  assert.equal(formalizationRequestCount, 1);
  modal.onClose();
  console.log("REVIEW-IDENTITY-D PASS: rejected preview blocks Apply");
}
// Actual modal Accept wiring auto-selects Include but does not cross Apply.
{
  const suggestion = makeSuggestion("candidate-review-ux", "accepted");
  const { modal, session, candidate } = makeHarness([suggestion]);
  const accept = findButton(modal.contentEl, "Accept");
  assert.ok(accept, "Accept button must be rendered by the actual modal");

  accept.click();

  assert.equal(modal.rows[0].selected, true);
  const checkbox = allElements(modal.contentEl).find(
    (element) => element.tagName === "INPUT" && element.type === "checkbox"
  );
  assert.ok(checkbox);
  assert.equal(checkbox.checked, true);
  assert.equal(candidate.claims.length, 0);
  assert.equal(Object.keys(session.formalizationIndex.records).length, 0);

  const apply = findButton(modal.contentEl, "Apply selected claims");
  assert.ok(apply);
  apply.click();

  assert.equal(candidate.claims.length, 1);
  assert.equal(Object.keys(session.formalizationIndex.records).length, 1);
  assert.equal(hasText(modal.contentEl, "Applied 1 claim."), true);
  assert.equal(hasText(modal.contentEl, "✓ Applied"), true);
  assert.equal(
    allElements(modal.contentEl).filter(
      (element) => element.tagName === "INPUT" && element.type === "checkbox"
    ).length,
    0,
    "Committed row must not render Include"
  );

  // Re-clicking Apply has no local selection and must not materialize again.
  findButton(modal.contentEl, "Apply selected claims").click();
  assert.equal(hasText(modal.contentEl, "Select at least one claim to apply."), true);
  assert.equal(candidate.claims.length, 1);
  assert.equal(Object.keys(session.formalizationIndex.records).length, 1);
  modal.onClose();

  console.log("REVIEW-UX-1 PASS: Accept selects Include locally; Apply materializes exactly once");
}

// Zero-selection feedback is rendered by the actual Apply handler.
{
  const suggestion = makeSuggestion("candidate-review-ux", "zero");
  const { modal, session, candidate } = makeHarness([suggestion]);
  findButton(modal.contentEl, "Apply selected claims").click();
  assert.equal(hasText(modal.contentEl, "Select at least one claim to apply."), true);
  assert.equal(candidate.claims.length, 0);
  assert.equal(Object.keys(session.formalizationIndex.records).length, 0);
  modal.onClose();
  console.log("REVIEW-UX-2 PASS: zero-selection Apply shows visible feedback");
}

// The real modal DOM is a constrained three-part column. Enough rows to
// overflow remain inside the sole scroll owner while the footer stays a
// non-scrolling sibling across rerenders.
{
  const suggestions = Array.from({ length: 14 }, (_, index) => ({
    ...makeSuggestion("candidate-review-layout", `row-${index}`),
    kind: "open_question",
    verification: "source_pending",
    text: `Overflowing claim row ${index + 1}?`
  }));
  const { modal } = makeHarness(suggestions);

  const assertThreePartLayout = () => {
    const list = modal.contentEl.querySelector("[data-scroll-container]");
    const footer = modal.contentEl.querySelector("[data-review-claims-footer]");
    const apply = findButton(modal.contentEl, "Apply selected claims");

    assert.ok(list, "Claims scroll container must exist");
    assert.ok(footer, "Fixed footer must exist");
    assert.ok(apply, "Apply action must remain rendered");
    assert.equal(list.contains(footer), false, "Footer must be outside the scrolling list");
    assert.equal(footer.parentElement, modal.contentEl);
    assert.equal(apply.parentElement.parentElement, footer);
    assert.equal(modal.contentEl.style.display, "flex");
    assert.equal(modal.contentEl.style.flexDirection, "column");
    assert.equal(modal.contentEl.style.overflowY, "hidden");
    assert.equal(list.style.flex, "1 1 auto");
    assert.equal(list.style.minHeight, "0");
    assert.equal(list.style.overflowY, "auto");
    assert.equal(footer.style.flex, "0 0 auto");
    assert.equal(footer.style.flexShrink, "0");
    return { list, footer };
  };

  const before = assertThreePartLayout();
  before.list.scrollTop = 900;
  assert.equal(before.footer.parentElement, modal.contentEl);
  assert.ok(findButton(modal.contentEl, "Apply selected claims"));

  // Formalize/Accept status changes use this same render path. A rerender may
  // replace nodes, but it must recreate the footer outside the list.
  modal.batchFormalizeMessage = "Formalized 1 claim.";
  modal.render();
  const after = assertThreePartLayout();
  assert.equal(after.list.scrollTop, 900);
  assert.ok(findButton(modal.contentEl, "Apply selected claims"));
  modal.onClose();
  console.log("REVIEW-UX-4 PASS: overflowing actual modal DOM keeps footer outside sole scroll owner");
}
// Accept may reveal the next pending row, but only by changing the designated
// list's scrollTop. The modal content root remains anchored and scrollIntoView
// is never invoked.
{
  FakeElement.scrollIntoViewCalls = 0;
  const first = makeSuggestion("candidate-review-ux", "first");
  const second = makeSuggestion("candidate-review-ux", "second");
  const { modal } = makeHarness([first, second]);
  modal.contentEl.scrollTop = 45;
  modal.modalEl.scrollTop = 55;
  modal.modalContainerEl.scrollTop = 65;
  const oldList = modal.contentEl.querySelector("[data-scroll-container]");
  oldList.scrollTop = 10;

  const acceptButtons = allElements(modal.contentEl).filter(
    (element) => element.tagName === "BUTTON" && element.textContent === "Accept"
  );
  assert.equal(acceptButtons.length, 2);
  acceptButtons[0].click();

  const newList = modal.contentEl.querySelector("[data-scroll-container]");
  assert.equal(modal.contentEl.scrollTop, 0);
  assert.equal(modal.modalEl.scrollTop, 0);
  assert.equal(modal.modalContainerEl.scrollTop, 0);
  assert.ok(newList.scrollTop > 10, "Only the claims list should reveal the next row");
  assert.equal(FakeElement.scrollIntoViewCalls, 0);
  modal.onClose();
  console.log("REVIEW-UX-3 PASS: Accept scrolls only the designated claims list");
}

console.log(JSON.stringify({
  nonFormalNativeCheckboxApply: true,
  selectionSurvivesRerender: true,
  acceptAutoSelectsInclude: true,
  acceptDoesNotPersist: true,
  applyMaterializesExactlyOnce: true,
  appliedFeedbackAndRowState: true,
  zeroSelectionFeedback: true,
  modalRootAnchored: true,
  designatedListOnlyScroll: true,
  overflowingFooterFixed: true,
  currentPreviewIdentityShared: true,
  stalePendingRejectedBlocked: true,
  factualActualDomApply: true,
  preselectedFactualApply: true,
  mixedUnselectedFormalDoesNotBlock: true,
  openQuestionWithoutFormalization: true,
  nonFatalWarningPreservesAppliedUi: true,
  formalIncludeEligibilityInvariant: true,
  staleAndRejectedClearSelection: true,
  exactApplyBlockerRevealed: true,
  reviewMathPresentationRendered: true,
  mixedApplyStagesOneThroughThirteen: true,
  result: "PASS"
}, null, 2));
