import {
  LAIN_BRAIN_DISPLAY_MATH_ATTRIBUTE,
  LAIN_BRAIN_RAW_TEX_ATTRIBUTE
} from "./LainBrainMarkdownRenderer";

export function makeReadOnlyTextSelectable(
  containerEl: HTMLElement
): () => void {
  containerEl.setAttr("data-lain-brain-selectable", "true");
  containerEl.setAttr("tabindex", "0");
  containerEl.style.setProperty("user-select", "text", "important");
  containerEl.style.setProperty(
    "-webkit-user-select",
    "text",
    "important"
  );

  containerEl.addEventListener(
    "click",
    (event) => {
      if (!hasSelectedTextWithin(containerEl)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    },
    true
  );

  containerEl.addEventListener("copy", (event) => {
    const copiedText = getSelectedTextWithRawMath(containerEl);

    if (copiedText === null || event.clipboardData === null) {
      return;
    }

    event.clipboardData.setData("text/plain", copiedText);
    event.preventDefault();
  });

  containerEl.addEventListener("keydown", (event) => {
    if (
      event.key.toLowerCase() !== "a" ||
      (!event.ctrlKey && !event.metaKey) ||
      event.altKey ||
      isEditableTarget(event.target)
    ) {
      return;
    }

    const selection = containerEl.ownerDocument.getSelection();

    if (selection === null) {
      return;
    }

    const range = containerEl.ownerDocument.createRange();
    range.selectNodeContents(containerEl);
    selection.removeAllRanges();
    selection.addRange(range);
    event.preventDefault();
  });

  const selectionStyle = containerEl.ownerDocument.createElement(
    "style"
  );
  selectionStyle.textContent = [
    `[data-lain-brain-selectable]::selection {`,
    `  background-color: var(--text-selection, highlight);`,
    `}`,
    `[data-lain-brain-raw-tex].math-selected {`,
    `  background-color: var(--text-selection, rgba(128, 0, 255, 0.3));`,
    `  border-radius: 2px;`,
    `}`
  ].join("\n");
  containerEl.appendChild(selectionStyle);

  const onSelectionChange = (): void => {
    const mathElements = containerEl.querySelectorAll<HTMLElement>(
      `[${LAIN_BRAIN_RAW_TEX_ATTRIBUTE}]`
    );

    if (mathElements.length === 0) {
      return;
    }

    if (!hasSelectedTextWithin(containerEl)) {
      mathElements.forEach((el) =>
        el.classList.remove("math-selected")
      );
      return;
    }

    const selection = containerEl.ownerDocument.getSelection()!;
    const range = selection.getRangeAt(0);

    mathElements.forEach((el) => {
      if (rangeIntersectsNode(range, el)) {
        el.classList.add("math-selected");
      } else {
        el.classList.remove("math-selected");
      }
    });
  };

  const doc = containerEl.ownerDocument;
  doc.addEventListener("selectionchange", onSelectionChange);

  return () => {
    doc.removeEventListener("selectionchange", onSelectionChange);
    selectionStyle.remove();
    containerEl
      .querySelectorAll<HTMLElement>(
        `[${LAIN_BRAIN_RAW_TEX_ATTRIBUTE}]`
      )
      .forEach((el) => el.classList.remove("math-selected"));
  };
}

export function hasSelectedTextWithin(
  containerEl: HTMLElement
): boolean {
  const selection = containerEl.ownerDocument.getSelection();

  if (
    selection === null ||
    selection.isCollapsed ||
    selection.rangeCount === 0 ||
    selection.toString() === ""
  ) {
    return false;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;

  if (
    commonAncestor === containerEl ||
    containerEl.contains(commonAncestor)
  ) {
    return true;
  }

  try {
    return range.intersectsNode(containerEl);
  } catch {
    return false;
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null) {
    return false;
  }

  const element = target as HTMLElement;
  const tagName = element.tagName?.toLowerCase();

  return (
    tagName === "input" ||
    tagName === "textarea" ||
    element.isContentEditable === true
  );
}


function getSelectedTextWithRawMath(
  containerEl: HTMLElement
): string | null {
  const selection = containerEl.ownerDocument.getSelection();

  if (
    selection === null ||
    selection.isCollapsed ||
    selection.rangeCount === 0
  ) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const mathElements = Array.from(
    containerEl.querySelectorAll<HTMLElement>(
      `[${LAIN_BRAIN_RAW_TEX_ATTRIBUTE}]`
    )
  ).filter((element) =>
    isMathInSelectionDocumentSpan(range, element)
  );

  if (mathElements.length === 0) {
    return null;
  }

  return rebuildSelectionText(containerEl, range, mathElements);
}

function rebuildSelectionText(
  containerEl: HTMLElement,
  range: Range,
  selectedMath: readonly HTMLElement[]
): string {
  const mathSet = new Set(selectedMath);
  let result = "";

  const visit = (node: Node): void => {
    if (isMathElement(node)) {
      if (mathSet.has(node)) {
        result = appendMathSource(result, node);
      }
      return;
    }

    if (node.nodeType === 3) {
      if (rangeIntersectsNode(range, node)) {
        result += getSelectedTextNodeValue(range, node as Text);
      }
      return;
    }

    if (node.nodeType !== 1) {
      return;
    }

    const element = node as HTMLElement;

    if (element.tagName.toLowerCase() === "br") {
      if (rangeIntersectsNode(range, element)) {
        result = appendLineBreak(result);
      }
      return;
    }

    const before = result.length;

    for (const child of Array.from(node.childNodes)) {
      visit(child);
    }

    if (before !== result.length && isBlockElement(element)) {
      result = appendLineBreak(result);
    }
  };

  for (const child of Array.from(containerEl.childNodes)) {
    visit(child);
  }

  return result;
}

function isMathInSelectionDocumentSpan(
  range: Range,
  mathElement: HTMLElement
): boolean {
  if (
    rangeIntersectsNode(range, mathElement) ||
    mathElement.contains(range.startContainer) ||
    mathElement.contains(range.endContainer)
  ) {
    return true;
  }

  try {
    const mathRange = mathElement.ownerDocument.createRange();
    mathRange.selectNode(mathElement);

    return (
      range.compareBoundaryPoints(0, mathRange) <= 0 &&
      range.compareBoundaryPoints(2, mathRange) >= 0
    );
  } catch {
    return false;
  }
}

function getSelectedTextNodeValue(range: Range, node: Text): string {
  let start = 0;
  let end = node.data.length;

  if (range.startContainer === node) {
    start = range.startOffset;
  }

  if (range.endContainer === node) {
    end = range.endOffset;
  }

  return node.data.slice(start, end);
}

function isMathElement(node: Node): node is HTMLElement {
  return (
    node.nodeType === 1 &&
    (node as HTMLElement).hasAttribute(
      LAIN_BRAIN_RAW_TEX_ATTRIBUTE
    )
  );
}

function appendMathSource(
  current: string,
  mathElement: HTMLElement
): string {
  const rawTex = mathElement.getAttribute(
    LAIN_BRAIN_RAW_TEX_ATTRIBUTE
  );

  if (rawTex === null) {
    return current;
  }

  if (
    mathElement.getAttribute(LAIN_BRAIN_DISPLAY_MATH_ATTRIBUTE) ===
      "true"
  ) {
    const body = getMathBody(rawTex).trim();
    return (
      appendLineBreak(current) +
      `$$\n${body}\n$$\n`
    );
  }

  return current + `$${getMathBody(rawTex)}$`;
}

function getMathBody(source: string): string {
  if (source.startsWith("$$") && source.endsWith("$$")) {
    return source.slice(2, -2);
  }

  if (source.startsWith("$") && source.endsWith("$")) {
    return source.slice(1, -1);
  }

  if (
    (source.startsWith("\\(") && source.endsWith("\\)")) ||
    (source.startsWith("\\[") && source.endsWith("\\]"))
  ) {
    return source.slice(2, -2);
  }

  return source;
}

function appendLineBreak(value: string): string {
  return value === "" || value.endsWith("\n")
    ? value
    : value + "\n";
}

function isBlockElement(element: HTMLElement): boolean {
  return new Set([
    "article", "blockquote", "div", "h1", "h2", "h3", "h4",
    "h5", "h6", "li", "ol", "p", "pre", "section", "table",
    "tbody", "td", "th", "tr", "ul"
  ]).has(element.tagName.toLowerCase());
}

function rangeIntersectsNode(
  range: Range,
  node: Node
): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}
