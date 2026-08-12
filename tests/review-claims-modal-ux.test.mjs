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
  DOMMatrix: class { constructor(){} },
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
  modal.rows = suggestions.map((item) => ({ item }));
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

// ═══════════════════════════════════════════════════════════════════════
// TEST A: Non-formal factual claim — no Include checkbox, auto-applies
// ═══════════════════════════════════════════════════════════════════════

{
  const suggestion = {
    ...makeSuggestion("candidate-review-ux", "factual"),
    kind: "factual_claim",
    verification: "source_pending",
    text: "This factual claim needs a source."
  };
  const { modal, session, candidate } = makeHarness([suggestion]);

  // No Include checkbox should exist
  const include = allElements(modal.contentEl).find(
    (element) =>
      element.tagName === "INPUT" &&
      element.type === "checkbox" &&
      element.getAttribute("data-include-claim-id") === suggestion.id
  );
  assert.equal(include, undefined, "No Include checkbox should exist for factual claim");

  // Apply button is renamed
  const applyBtn = findButton(modal.contentEl, "Apply claims");
  assert.ok(applyBtn, "Apply button must say 'Apply claims'");
  assert.equal(findButton(modal.contentEl, "Apply selected claims"), undefined,
    "Old 'Apply selected claims' button must not exist");

  // Apply commits and closes
  let receivedItems = null;
  const originalApply = session.applyReviewedClaims.bind(session);
  session.applyReviewedClaims = (candidateId, items) => {
    receivedItems = items;
    return originalApply(candidateId, items);
  };

  applyBtn.click();
  assert.deepEqual(Array.from(receivedItems, (item) => item.id), [suggestion.id]);
  assert.equal(candidate.claims.length, 1);
  assert.equal(modal.closed, true, "Modal must close after successful Apply");
  console.log("TEST-A PASS: non-formal factual claim auto-applies, no Include checkbox, modal closes");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST B: Open question — no Include checkbox, auto-applies
// ═══════════════════════════════════════════════════════════════════════

{
  const suggestion = {
    ...makeSuggestion("candidate-review-ux", "open-question"),
    kind: "open_question",
    verification: "source_pending",
    text: "Is this still an open question?"
  };
  const { modal, candidate } = makeHarness([suggestion]);

  // No Include checkbox
  const include = allElements(modal.contentEl).find(
    (element) =>
      element.tagName === "INPUT" &&
      element.type === "checkbox" &&
      element.getAttribute("data-include-claim-id") === suggestion.id
  );
  assert.equal(include, undefined, "No Include checkbox for open question");

  // Apply commits
  findButton(modal.contentEl, "Apply claims").click();
  assert.equal(candidate.claims.length, 1);
  assert.equal(modal.closed, true, "Modal must close after successful Apply");
  console.log("TEST-B PASS: open question auto-applies, no Include checkbox");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST C: Formal claim not formalized — Apply blocked with clear message
// ═══════════════════════════════════════════════════════════════════════

{
  const suggestion = makeSuggestion("candidate-review-ux", "no-preview");
  const { modal, candidate } = makeHarness([suggestion], { injectPreviews: false });

  // No Include checkbox
  const include = allElements(modal.contentEl).find(
    (element) =>
      element.tagName === "INPUT" &&
      element.getAttribute("data-include-claim-id") === suggestion.id
  );
  assert.equal(include, undefined, "No Include checkbox for unformalized formal claim");

  // Apply is blocked
  findButton(modal.contentEl, "Apply claims").click();
  assert.equal(candidate.claims.length, 0, "Apply must not commit unformalized formal claim");
  assert.equal(hasText(modal.contentEl, "1 formal claim still needs review before Apply."), true,
    "Clear blocker message must exist");
  // Modal remains open
  assert.equal(modal.closed || false, false, "Modal must not close on blocked Apply");
  modal.onClose();
  console.log("TEST-C PASS: unformalized formal claim blocks Apply with clear message");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST D: Formalized but pending review — Apply blocked
// ═══════════════════════════════════════════════════════════════════════

{
  const suggestion = makeSuggestion("candidate-review-ux", "pending");
  const { modal, candidate } = makeHarness([suggestion], { injectPreviews: false });
  await formalizeThroughModal(modal);

  // Review button exists, no Include checkbox
  const reviewBtn = findButton(modal.contentEl, "Review");
  assert.ok(reviewBtn, "Review button must exist for pending formalization");

  const include = allElements(modal.contentEl).find(
    (element) =>
      element.tagName === "INPUT" &&
      element.getAttribute("data-include-claim-id") === suggestion.id
  );
  assert.equal(include, undefined, "No Include checkbox for pending formal preview");

  // Apply blocked
  findButton(modal.contentEl, "Apply claims").click();
  assert.equal(candidate.claims.length, 0);
  assert.equal(hasText(modal.contentEl, "1 formal claim still needs review before Apply."), true);
  modal.onClose();
  console.log("TEST-D PASS: pending formal preview blocks Apply");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST E: Formal claim → Accept → reviewStatus=accepted, no selection, Apply commits
// ═══════════════════════════════════════════════════════════════════════

{
  formalizationRequestCount = 0;
  const suggestion = makeSuggestion("candidate-review-ux", "accept-flow");
  const { modal, session, candidate } = makeHarness(
    [suggestion],
    { injectPreviews: false }
  );
  await formalizeThroughModal(modal);

  // Accept the formalization
  const acceptBtn = findButton(modal.contentEl, "Accept");
  assert.ok(acceptBtn, "Accept button must exist");
  acceptBtn.click();

  // Verify reviewStatus is accepted
  const current = session.getCurrentFormalizationPreviewForSuggestion(
    suggestion.id,
    suggestion.text,
    suggestion.kind
  );
  assert.ok(current, "Current preview must exist after Accept");
  assert.equal(current.record.reviewStatus, "accepted");

  // No Include checkbox appears
  const include = allElements(modal.contentEl).find(
    (element) =>
      element.tagName === "INPUT" &&
      element.getAttribute("data-include-claim-id") === suggestion.id
  );
  assert.equal(include, undefined, "No Include checkbox after Accept");

  // Has Accepted badge
  assert.equal(hasText(modal.contentEl, "Accepted ✓"), true);

  // Apply commits the formal claim
  findButton(modal.contentEl, "Apply claims").click();
  assert.equal(candidate.claims.length, 1);
  assert.equal(modal.closed, true, "Modal must close after successful Apply");
  console.log("TEST-E PASS: Accept sets reviewStatus=accepted, no selection mutation, Apply commits");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST F: Accepted formal + factual together — both applied
// ═══════════════════════════════════════════════════════════════════════

{
  formalizationRequestCount = 0;
  const factual = {
    ...makeSuggestion("candidate-review-ux", "mixed-factual"),
    kind: "factual_claim",
    verification: "source_pending",
    text: "A factual claim in mixed batch."
  };
  const formal = makeSuggestion("candidate-review-ux", "mixed-formal");
  const { modal, session, candidate } = makeHarness(
    [factual, formal],
    { injectPreviews: false }
  );
  await formalizeThroughModal(modal);
  findButton(modal.contentEl, "Accept").click();

  // Apply commits both
  let receivedIds = [];
  const originalApply = session.applyReviewedClaims.bind(session);
  session.applyReviewedClaims = (candidateId, items) => {
    receivedIds = Array.from(items, (item) => item.id);
    return originalApply(candidateId, items);
  };

  findButton(modal.contentEl, "Apply claims").click();
  assert.deepEqual(new Set(receivedIds), new Set([factual.id, formal.id]));
  assert.equal(candidate.claims.length, 2);
  assert.equal(Object.keys(session.getFormalizationIndex().records).length, 1);
  assert.equal(formalizationRequestCount, 1, "Apply must not call LLM again");
  assert.equal(modal.closed, true, "Modal must close after successful Apply");
  console.log("TEST-F PASS: accepted formal + factual both applied, modal closes");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST G: Rejected formal — not silently applied, Apply blocked
// ═══════════════════════════════════════════════════════════════════════

{
  const suggestion = makeSuggestion("candidate-review-ux", "rejected");
  const { modal, candidate } = makeHarness([suggestion], { injectPreviews: false });
  await formalizeThroughModal(modal);

  // Reject the formalization
  findButton(modal.contentEl, "Reject").click();

  // Apply is blocked
  findButton(modal.contentEl, "Apply claims").click();
  assert.equal(candidate.claims.length, 0);
  assert.equal(hasText(modal.contentEl, "1 formal claim still needs review before Apply."), true);

  // Delete the rejected claim → blocker removed
  findButton(modal.contentEl, "Delete suggestion").click();

  // After deletion, zero claims → "No claims to apply"
  findButton(modal.contentEl, "Apply claims").click();
  assert.equal(hasText(modal.contentEl, "No claims to apply."), true);
  assert.equal(candidate.claims.length, 0);

  modal.onClose();
  console.log("TEST-G PASS: rejected formal blocks Apply, delete removes blocker");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST H: Delete suggestion removes from Apply set
// ═══════════════════════════════════════════════════════════════════════

{
  const factual = {
    ...makeSuggestion("candidate-review-ux", "delete-factual"),
    kind: "factual_claim",
    verification: "source_pending",
    text: "A factual claim to delete."
  };
  const { modal, candidate } = makeHarness([factual]);

  // Delete it
  findButton(modal.contentEl, "Delete suggestion").click();

  // Zero claims remaining
  findButton(modal.contentEl, "Apply claims").click();
  assert.equal(hasText(modal.contentEl, "No claims to apply."), true);
  assert.equal(candidate.claims.length, 0);
  modal.onClose();
  console.log("TEST-H PASS: delete removes claim from Apply set, zero claims shows feedback");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST I: Legacy warning — successful Apply still closes modal
// ═══════════════════════════════════════════════════════════════════════

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

  let applyResult = null;
  const originalApply = session.applyReviewedClaims.bind(session);
  session.applyReviewedClaims = (candidateId, items) => {
    applyResult = originalApply(candidateId, items);
    return applyResult;
  };

  findButton(modal.contentEl, "Apply claims").click();
  assert.equal(applyResult.ok, true);
  assert.equal(applyResult.appliedCount, 1);
  assert.equal(typeof applyResult.warning, "string");
  assert.equal(candidate.claims.length, 1);
  assert.equal(modal.closed, true, "Modal must close after successful Apply even with non-fatal warning");
  console.log("TEST-I PASS: legacy warning does not block Apply-close");
}

// ═══════════════════════════════════════════════════════════════════════
// TEST J: Zero remaining claims — sensible feedback
// ═══════════════════════════════════════════════════════════════════════

{
  const { modal, candidate } = makeHarness([]);
  findButton(modal.contentEl, "Apply claims").click();
  assert.equal(hasText(modal.contentEl, "No claims to apply."), true);
  assert.equal(candidate.claims.length, 0);
  modal.onClose();
  console.log("TEST-J PASS: zero claims shows 'No claims to apply.'");
}

// ═══════════════════════════════════════════════════════════════════════
// Preserved: Formalize → Accept → Apply materializes the same preview once
// ═══════════════════════════════════════════════════════════════════════

{
  formalizationRequestCount = 0;
  const suggestion = makeSuggestion("candidate-review-ux", "identity");
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

  // No Include checkbox
  const include = allElements(modal.contentEl).find(
    (element) =>
      element.tagName === "INPUT" &&
      element.getAttribute("data-include-claim-id") === suggestion.id
  );
  assert.equal(include, undefined, "No Include checkbox after Accept");

  findButton(modal.contentEl, "Apply claims").click();
  assert.equal(candidate.claims.length, 1);
  assert.equal(candidate.claims[0].formalizationIds.length, 1);
  assert.equal(candidate.claims[0].formalizationIds[0], previewId);
  assert.equal(session.getFormalizationIndex().records[previewId].reviewStatus, "accepted");
  assert.equal(formalizationRequestCount, 1, "Apply must not call the LLM again");
  modal.onClose();
  console.log("REVIEW-IDENTITY-A PASS: Formalize → Accept → Apply materializes the same preview once");
}

// ═══════════════════════════════════════════════════════════════════════
// Preserved: Stale formalization blocks Apply
// ═══════════════════════════════════════════════════════════════════════

{
  formalizationRequestCount = 0;
  const suggestion = makeSuggestion("candidate-review-ux", "stale");
  const { modal, session, candidate } = makeHarness(
    [suggestion],
    { injectPreviews: false }
  );
  await formalizeThroughModal(modal);
  findButton(modal.contentEl, "Accept").click();

  // Edit claim text to make it stale
  const claimText = findClaimTextarea(modal.contentEl, suggestion.text);
  assert.ok(claimText);
  claimText.value = suggestion.text + " Changed after review.";
  claimText.dispatch("input");
  assert.equal(hasText(modal.contentEl, "Accepted ✓"), false);
  assert.equal(hasText(modal.contentEl, "⚠ Stale"), true);

  // Apply blocked
  findButton(modal.contentEl, "Apply claims").click();
  assert.equal(hasText(modal.contentEl, "1 formal claim still needs review before Apply."), true);
  assert.equal(candidate.claims.length, 0);
  assert.equal(formalizationRequestCount, 1);
  modal.onClose();
  console.log("REVIEW-IDENTITY-B PASS: edited source makes accepted stale, blocks Apply");
}

// ═══════════════════════════════════════════════════════════════════════
// Preserved: Repeated Accept is blocked at UI and protocol layers
// ═══════════════════════════════════════════════════════════════════════

{
  const suggestion = makeSuggestion("candidate-review-ux", "accept-once");
  const { modal } = makeHarness([suggestion], { injectPreviews: false });
  await formalizeThroughModal(modal);

  const acceptBtn = findButton(modal.contentEl, "Accept");
  assert.ok(acceptBtn, "Accept button must exist for pending formalization");
  acceptBtn.click();

  const previews = modal.session.getFormalizationPreviewsForSuggestion(suggestion.id);
  assert.equal(previews.length, 1);
  const acceptedRecord = previews[0].record;
  assert.equal(acceptedRecord.reviewStatus, "accepted");
  const revisionAfterFirstAccept = acceptedRecord.revision;

  // Accept button gone after accept
  const acceptBtnAfter = findButton(modal.contentEl, "Accept");
  assert.equal(acceptBtnAfter, undefined, "Accept button must not exist after acceptance");

  // Defensive re-accept at session layer with same status/statement
  const result = modal.session.applyFormalizationReview(
    acceptedRecord.id,
    "accepted",
    acceptedRecord.reviewedStatement
  );
  assert.ok(result.ok, "Defensive re-accept must succeed (return unchanged)");

  const previewsAfter = modal.session.getFormalizationPreviewsForSuggestion(suggestion.id);
  const recordAfter = previewsAfter[0].record;
  assert.equal(recordAfter.revision, revisionAfterFirstAccept, "Repeated Accept must not bump revision");
  assert.equal(recordAfter.reviewStatus, "accepted");

  const acceptedEntries = recordAfter.history.filter(
    (rev) => rev.action === "accepted"
  );
  assert.equal(acceptedEntries.length, 1, "History must contain exactly one accepted entry");

  modal.onClose();
  console.log("REVIEW-ACCEPT-ONCE PASS: repeated Accept blocked at UI and protocol layers");
}

// ═══════════════════════════════════════════════════════════════════════
// Preserved: Math presentation is rendered distinctly from raw source
// ═══════════════════════════════════════════════════════════════════════

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

  // Accept on not_checked formalization keeps it expanded (collapse-state bug fix)
  const collapsed = modal.contentEl.querySelector(
    `[data-rendered-formalization-preview="${modal.rows[0].item.id}"]`
  );
  assert.equal(collapsed, null, "not_checked formalization must stay expanded after Accept");

  modal.onClose();
  console.log("REVIEW-MATH PASS: raw editor source and rendered math stay distinct");
}

// ═══════════════════════════════════════════════════════════════════════
// Preserved: three-part layout with footer outside scrolling list
// ═══════════════════════════════════════════════════════════════════════

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
    const apply = findButton(modal.contentEl, "Apply claims");

    assert.ok(list, "Claims scroll container must exist");
    assert.ok(footer, "Fixed footer must exist");
    assert.ok(apply, "Apply claims button must remain rendered");
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
  assert.ok(findButton(modal.contentEl, "Apply claims"));

  modal.batchFormalizeMessage = "Formalized 1 claim.";
  modal.render();
  const after = assertThreePartLayout();
  assert.equal(after.list.scrollTop, 900);
  assert.ok(findButton(modal.contentEl, "Apply claims"));
  modal.onClose();
  console.log("REVIEW-UX-LAYOUT PASS: three-part column layout preserved");
}

// ═══════════════════════════════════════════════════════════════════════
// Preserved: Accept scrolls only the designated claims list
// ═══════════════════════════════════════════════════════════════════════

{
  FakeElement.scrollIntoViewCalls = 0;
  const first = makeSuggestion("candidate-review-ux", "scroll-first");
  const second = makeSuggestion("candidate-review-ux", "scroll-second");
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
  console.log("REVIEW-UX-SCROLL PASS: Accept scrolls only the designated claims list");
}

console.log(JSON.stringify({
  nonFormalNoCheckbox: true,
  nonFormalAutoApply: true,
  openQuestionNoCheckbox: true,
  openQuestionAutoApply: true,
  unformalizedBlocksApply: true,
  clearBlockerMessage: true,
  pendingBlocksApply: true,
  acceptSetsReviewStatus: true,
  acceptNoSelectionMutation: true,
  acceptThenApplyCommits: true,
  mixedFactualFormalBothApplied: true,
  rejectedBlocksApply: true,
  deleteRemovesBlocker: true,
  deleteRemovesFromApply: true,
  zeroClaimsFeedback: true,
  legacyWarningDoesNotBlockClose: true,
  applyButtonRenamed: true,
  formalizationIdentity: true,
  staleBlocksApply: true,
  repeatAcceptBlocked: true,
  mathPresentation: true,
  threePartLayout: true,
  scrollOnlyDesignatedList: true,
  result: "PASS"
}, null, 2));
