import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const output = path.join(root, "tests", ".selectable-text.bundle.cjs");

await build({
  stdin: {
    contents: [
      "export * from './src/SelectableText';",
      "export { annotateRenderedMath, extractMathSources } from './src/LainBrainMarkdownRenderer';"
    ].join("\n"),
    resolveDir: root,
    sourcefile: "selectable-text-entry.ts",
    loader: "ts"
  },
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "silent",
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
          "exports.Component = class Component {};",
          "exports.MarkdownRenderer = { render: async () => {} };"
        ].join("\n")
      }));
    }
  }]
});

const selectable = await import(
  pathToFileURL(output).href + `?t=${Date.now()}`
);
await rm(output, { force: true });

const cauchySchwarz =
  String.raw`$\langle x,y\rangle \le \lVert x\rVert\lVert y\rVert$`;
const sourceMarkdown = [
  `Visible ${cauchySchwarz}.`,
  "Inline code: `" + String.raw`$ignored$` + "`.",
  "```text",
  String.raw`$$ignored_fence$$`,
  "```",
  String.raw`Also \(a+b\) and:`,
  String.raw`\[\int_0^1 x^2\,dx\]`
].join("\n");
assert.deepEqual(selectable.extractMathSources(sourceMarkdown), [
  cauchySchwarz,
  String.raw`\(a+b\)`,
  String.raw`\[\int_0^1 x^2\,dx\]`
]);

let annotatedTex = null;
const annotationText =
  String.raw`\langle x,y\rangle \le \lVert x\rVert\lVert y\rVert`;
const renderedMath = {
  parentElement: { closest: () => null },
  querySelector: (selector) =>
    selector.includes("application/x-tex")
      ? { textContent: annotationText }
      : null,
  setAttribute: (name, value) => {
    if (name === "data-lain-brain-raw-tex") {
      annotatedTex = value;
      return;
    }
    assert.equal(name, "data-lain-brain-display-math");
    assert.equal(value, "false");
  },
  classList: { contains: () => false },
  getAttribute: () => null,
  style: { setProperty: () => {} },
  querySelectorAll: () => []
};
selectable.annotateRenderedMath({
  querySelectorAll: (selector) =>
    selector === ".math" ? [renderedMath] : []
}, `Paragraph ${cauchySchwarz}.`);
assert.equal(annotatedTex, cauchySchwarz);

const child = { tagName: "DIV", isContentEditable: false };
const beforeText = { nodeType: 3, data: "Before formula. " };
const middleText = { nodeType: 3, data: " Between formulas. " };
const afterText = { nodeType: 3, data: " After formula." };
const displayOne = String.raw`$$\int_0^1 x^2\,dx$$`;
const displayTwo = String.raw`$$\begin{bmatrix}1 & 0 \\ 0 & 1\end{bmatrix}$$`;
let includeMathByDocumentOrder = false;
let currentRange;
let selectedContents = null;
let rangesRemoved = 0;
let rangesAdded = 0;
const rangeFactory = {
  selectedNode: null,
  selectNode: (node) => {
    rangeFactory.selectedNode = node;
  },
  selectNodeContents: (node) => {
    selectedContents = node;
  }
};
const selectionChangeListeners = new Set();
const ownerDocument = {
  getSelection: () => selection,
  createRange: () => ({
    selectedNode: null,
    selectNode: (node) => {
      rangeFactory.selectedNode = node;
    },
    selectNodeContents: (node) => {
      selectedContents = node;
    }
  }),
  createElement: () => ({ textContent: "", remove: () => {} }),
  addEventListener: (name, listener) => {
    if (name === "selectionchange") {
      selectionChangeListeners.add(listener);
    }
  },
  removeEventListener: (name, listener) => {
    if (name === "selectionchange") {
      selectionChangeListeners.delete(listener);
    }
  }
};
const createMathClassList = () => {
  const store = new Set();
  return {
    add(name) { store.add(name); },
    remove(name) { store.delete(name); },
    contains(name) { return store.has(name); }
  };
};
const makeMathNode = (rawTex) => ({
  nodeType: 1,
  tagName: "DIV",
  childNodes: [],
  ownerDocument,
  classList: createMathClassList(),
  hasAttribute: (name) => name === "data-lain-brain-raw-tex",
  getAttribute: (name) => {
    if (name === "data-lain-brain-raw-tex") {
      return rawTex;
    }
    if (name === "data-lain-brain-display-math") {
      return "true";
    }
    return null;
  },
  contains: () => false
});
const mathOne = makeMathNode(displayOne);
const mathTwo = makeMathNode(displayTwo);
const containerChildren = [
  beforeText,
  mathOne,
  middleText,
  mathTwo,
  afterText
];

const selectedRange = {
  startContainer: beforeText,
  startOffset: 0,
  endContainer: afterText,
  endOffset: afterText.data.length,
  commonAncestorContainer: child,
  intersectsNode: (node) => node.nodeType === 3,
  compareBoundaryPoints: (how, mathRange) => {
    const node = rangeFactory.selectedNode ?? mathRange.selectedNode;
    if (!includeMathByDocumentOrder) {
      return how === 0 ? -1 : -1;
    }
    if (node === mathOne || node === mathTwo) {
      return how === 0 ? -1 : 1;
    }
    return 0;
  }
};
currentRange = selectedRange;
let selectedText = "Before formula. Between formulas. After formula.";
const selection = {
  isCollapsed: false,
  rangeCount: 1,
  toString: () => selectedText,
  getRangeAt: () => currentRange,
  removeAllRanges: () => {
    rangesRemoved += 1;
  },
  addRange: (range) => {
    rangesAdded += 1;
    currentRange = selectedRange;
  }
};
const listeners = new Map();
const listenerCapture = new Map();
const styleCalls = [];
const attributes = new Map();
const selectableElement = {
  setAttr: (name, value) => attributes.set(name, value),
  style: {
    setProperty: (...args) => styleCalls.push(args)
  },
  ownerDocument,
  childNodes: containerChildren,
  querySelectorAll: () => [mathOne, mathTwo],
  contains: (node) => node === child,
  addEventListener: (name, listener, capture = false) => {
    listeners.set(name, listener);
    listenerCapture.set(name, capture);
  },
  appendChild: () => {}
};

const cleanup = selectable.makeReadOnlyTextSelectable(selectableElement);
assert.equal(typeof cleanup, "function");
assert.equal(attributes.get("data-lain-brain-selectable"), "true");
assert.equal(attributes.get("tabindex"), "0");
assert.deepEqual(styleCalls, [
  ["user-select", "text", "important"],
  ["-webkit-user-select", "text", "important"]
]);
assert.deepEqual([...listeners.keys()].sort(), ["click", "copy", "keydown"]);
assert.equal(listenerCapture.get("click"), true);
assert.equal(listeners.has("selectstart"), false);
assert.equal(listeners.has("contextmenu"), false);

let navigationPrevented = false;
let propagationStopped = false;
listeners.get("click")({
  preventDefault: () => {
    navigationPrevented = true;
  },
  stopPropagation: () => {
    propagationStopped = true;
  }
});
assert.equal(navigationPrevented, true);
assert.equal(propagationStopped, true);

selection.isCollapsed = true;
selectedText = "";
navigationPrevented = false;
propagationStopped = false;
listeners.get("click")({
  preventDefault: () => {
    navigationPrevented = true;
  },
  stopPropagation: () => {
    propagationStopped = true;
  }
});
assert.equal(navigationPrevented, false);
assert.equal(propagationStopped, false);

selection.isCollapsed = false;
selectedText = "near formula only";
includeMathByDocumentOrder = false;
let copiedText = null;
let copyPrevented = false;
listeners.get("copy")({
  clipboardData: {
    setData: (_type, value) => {
      copiedText = value;
    }
  },
  preventDefault: () => {
    copyPrevented = true;
  }
});
assert.equal(copiedText, null);
assert.equal(copyPrevented, false);

includeMathByDocumentOrder = true;
copyPrevented = false;
listeners.get("copy")({
  clipboardData: {
    setData: (type, value) => {
      assert.equal(type, "text/plain");
      copiedText = value;
    }
  },
  preventDefault: () => {
    copyPrevented = true;
  }
});
assert.equal(copyPrevented, true);
assert.equal(copiedText.includes(displayOne), false);
assert.equal(copiedText.includes("$$\n\\int_0^1 x^2\\,dx\n$$"), true);
assert.equal(
  copiedText.includes(
    "$$\n\\begin{bmatrix}1 & 0 \\\\ 0 & 1\\end{bmatrix}\n$$"
  ),
  true
);
assert.equal(copiedText.indexOf("\\int_0^1"), copiedText.lastIndexOf("\\int_0^1"));
assert.equal(copiedText.indexOf("\\int_0^1") < copiedText.indexOf("\\begin{bmatrix}"), true);

let selectAllPrevented = false;
listeners.get("keydown")({
  key: "a",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  target: child,
  preventDefault: () => {
    selectAllPrevented = true;
  }
});
assert.equal(selectAllPrevented, true);
assert.equal(selectedContents, selectableElement);
assert.equal(rangesRemoved, 1);
assert.equal(rangesAdded, 1);
copyPrevented = false;
listeners.get("copy")({
  clipboardData: {
    setData: (_type, value) => {
      copiedText = value;
    }
  },
  preventDefault: () => {
    copyPrevented = true;
  }
});
assert.equal(copyPrevented, true);
assert.equal(copiedText.includes("\\int_0^1"), true);
assert.equal(copiedText.includes("\\begin{bmatrix}"), true);

cleanup();
assert.equal(selectionChangeListeners.size, 0);

const chatSource = await readFile(
  path.join(root, "src", "LainBrainChatPanel.ts"),
  "utf8"
);
const largeSource = await readFile(
  path.join(root, "src", "LainBrainLargeView.ts"),
  "utf8"
);
const selectableSource = await readFile(
  path.join(root, "src", "SelectableText.ts"),
  "utf8"
);
const rendererSource = await readFile(
  path.join(root, "src", "LainBrainMarkdownRenderer.ts"),
  "utf8"
);

assert.match(chatSource, /makeReadOnlyTextSelectable\(\s*this\.transcriptEl\s*\)/);
assert.match(largeSource, /makeReadOnlyTextSelectable\(\s*previewEl\s*\)/);
assert.match(chatSource, /selectableCleanup/);
assert.match(largeSource, /selectableCleanup/);
assert.match(selectableSource, /return \(\) => \{/);
assert.match(selectableSource, /selectionchange/);
assert.match(selectableSource, /math-selected/);
assert.doesNotMatch(chatSource, /Copy response|Response copied|copyRawText/);
assert.doesNotMatch(largeSource, /Copy Markdown|Markdown copied|copyRawText/);
assert.match(selectableSource, /LAIN_BRAIN_RAW_TEX_ATTRIBUTE/);
assert.match(selectableSource, /rangeIntersectsNode\(range, element\)/);
assert.match(rendererSource, /annotateRenderedMath\(containerEl, markdown\)/);
assert.match(chatSource, /this\.markdownRenderer\.render\(/);
assert.match(largeSource, /this\.candidateMarkdownRenderer\.render\(/);
assert.match(rendererSource, /MarkdownRenderer\.render\(/);
assert.match(rendererSource, /normalizeMathDelimiters\(markdown\)/);
assert.doesNotMatch(chatSource, /user-select["']?\s*[:,]\s*["']none/);

console.log(JSON.stringify({
  exactInlineTexAnnotated: annotatedTex === cauchySchwarz,
  codeMathIgnored: true,
  nearbyNonIntersectingSelectionUsesNativeCopy: true,
  skippedDisplayMathIncludedByDocumentOrder:
    copiedText.includes("\\int_0^1") &&
    copiedText.includes("\\begin{bmatrix}"),
  ctrlOrCmdASelectionCopiesAllFormulas: true,
  sidebarAndLargeChatShareSelectableCopyPath: true,
  candidateAndKnowledgeStatusShareSelectableCopyPath: true,
  selectedLinkClickPrevented: true,
  unselectedLinkClickPreserved: true,
  markdownAndLatexRendererPreserved: true,
  result: "PASS"
}, null, 2));
