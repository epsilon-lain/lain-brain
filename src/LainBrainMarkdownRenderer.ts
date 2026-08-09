import {
  App,
  Component,
  MarkdownRenderer
} from "obsidian";

interface FenceState {
  marker: "`" | "~";
  length: number;
}

export const LAIN_BRAIN_RAW_TEX_ATTRIBUTE =
  "data-lain-brain-raw-tex";
export const LAIN_BRAIN_DISPLAY_MATH_ATTRIBUTE =
  "data-lain-brain-display-math";

export function extractMathSources(markdown: string): string[] {
  const sources: string[] = [];
  let index = 0;
  let inlineCodeTicks = 0;
  let fence: FenceState | null = null;

  while (index < markdown.length) {
    const atLineStart = index === 0 || markdown[index - 1] === "\n";

    if (atLineStart && inlineCodeTicks === 0) {
      const newlineIndex = markdown.indexOf("\n", index);
      const lineEnd = newlineIndex === -1
        ? markdown.length
        : newlineIndex;
      const line = markdown.slice(index, lineEnd);
      const fenceMatch = line.match(
        /^(?:(?:[ \t]*>[ \t]?)*[ \t]*)(`{3,}|~{3,})/
      );

      if (fence !== null) {
        if (fenceMatch !== null) {
          const markerRun = fenceMatch[1];
          const remainder = line.slice(fenceMatch[0].length);

          if (
            markerRun !== undefined &&
            markerRun[0] === fence.marker &&
            markerRun.length >= fence.length &&
            /^[ \t]*$/.test(remainder)
          ) {
            fence = null;
          }
        }

        index = newlineIndex === -1
          ? markdown.length
          : newlineIndex + 1;
        continue;
      }

      if (fenceMatch !== null) {
        const markerRun = fenceMatch[1];

        if (markerRun !== undefined) {
          fence = {
            marker: markerRun[0] as "`" | "~",
            length: markerRun.length
          };
        }

        index = newlineIndex === -1
          ? markdown.length
          : newlineIndex + 1;
        continue;
      }
    }

    const character = markdown.charAt(index);

    if (character === "`") {
      let runLength = 1;

      while (markdown[index + runLength] === "`") {
        runLength += 1;
      }

      if (inlineCodeTicks === 0) {
        inlineCodeTicks = runLength;
      } else if (inlineCodeTicks === runLength) {
        inlineCodeTicks = 0;
      }

      index += runLength;
      continue;
    }

    if (inlineCodeTicks !== 0) {
      index += 1;
      continue;
    }

    if (
      character === "\\" &&
      isUnescapedBackslash(markdown, index) &&
      (markdown[index + 1] === "(" || markdown[index + 1] === "[")
    ) {
      const opening = markdown[index + 1];
      const closing = opening === "(" ? ")" : "]";
      const closeIndex = findBackslashMathClose(
        markdown,
        index + 2,
        closing
      );

      if (closeIndex !== -1) {
        sources.push(markdown.slice(index, closeIndex + 2));
        index = closeIndex + 2;
        continue;
      }
    }

    if (
      character === "$" &&
      !isEscapedCharacter(markdown, index)
    ) {
      const delimiterLength = markdown[index + 1] === "$" ? 2 : 1;
      const closeIndex = findDollarMathClose(
        markdown,
        index + delimiterLength,
        delimiterLength
      );

      if (closeIndex !== -1) {
        sources.push(
          markdown.slice(index, closeIndex + delimiterLength)
        );
        index = closeIndex + delimiterLength;
        continue;
      }
    }

    index += 1;
  }

  return sources;
}

export function annotateRenderedMath(
  containerEl: HTMLElement,
  markdown: string
): void {
  const mathElements = getRenderedMathElements(containerEl);

  if (mathElements.length === 0) {
    return;
  }

  const sources = extractMathSources(markdown);
  let sourceCursor = 0;

  for (const mathElement of mathElements) {
    const annotation = mathElement.querySelector(
      'annotation[encoding="application/x-tex"]'
    )?.textContent?.trim();
    let source: string | undefined;

    if (annotation !== undefined && annotation !== "") {
      const matchingIndex = sources.findIndex(
        (candidate, index) =>
          index >= sourceCursor &&
          getMathSourceBody(candidate).trim() === annotation
      );

      if (matchingIndex !== -1) {
        source = sources[matchingIndex];
        sourceCursor = matchingIndex + 1;
      } else {
        source = isDisplayMathElement(mathElement)
          ? `$$${annotation}$$`
          : `$${annotation}$`;
      }
    } else if (sourceCursor < sources.length) {
      source = sources[sourceCursor];
      sourceCursor += 1;
    }

    if (source !== undefined && source !== "") {
      mathElement.setAttribute(
        LAIN_BRAIN_RAW_TEX_ATTRIBUTE,
        source
      );
      mathElement.setAttribute(
        LAIN_BRAIN_DISPLAY_MATH_ATTRIBUTE,
        isDisplayMathElement(mathElement) ? "true" : "false"
      );
      enableMathTextSelection(mathElement);
    }
  }
}

export function normalizeMathDelimiters(markdown: string): string {
  let result = "";
  let index = 0;
  let inlineCodeTicks = 0;
  let fence: FenceState | null = null;

  while (index < markdown.length) {
    const atLineStart = index === 0 || markdown[index - 1] === "\n";

    if (atLineStart && inlineCodeTicks === 0) {
      const newlineIndex = markdown.indexOf("\n", index);
      const lineEnd = newlineIndex === -1
        ? markdown.length
        : newlineIndex;
      const line = markdown.slice(index, lineEnd);
      const fenceMatch = line.match(
        /^(?:(?:[ \t]*>[ \t]?)*[ \t]*)(`{3,}|~{3,})/
      );

      if (fence !== null) {
        if (fenceMatch !== null) {
          const markerRun = fenceMatch[1];
          const remainder = line.slice(fenceMatch[0].length);

          if (
            markerRun !== undefined &&
            markerRun[0] === fence.marker &&
            markerRun.length >= fence.length &&
            /^[ \t]*$/.test(remainder)
          ) {
            fence = null;
          }
        }

        result += line;

        if (newlineIndex !== -1) {
          result += "\n";
        }

        index = newlineIndex === -1
          ? markdown.length
          : newlineIndex + 1;
        continue;
      }

      if (fenceMatch !== null) {
        const markerRun = fenceMatch[1];

        if (markerRun !== undefined) {
          fence = {
            marker: markerRun[0] as "`" | "~",
            length: markerRun.length
          };
        }

        result += line;

        if (newlineIndex !== -1) {
          result += "\n";
        }

        index = newlineIndex === -1
          ? markdown.length
          : newlineIndex + 1;
        continue;
      }
    }

    const character = markdown.charAt(index);

    if (character === "`") {
      let runLength = 1;

      while (markdown[index + runLength] === "`") {
        runLength += 1;
      }

      result += markdown.slice(index, index + runLength);

      if (inlineCodeTicks === 0) {
        inlineCodeTicks = runLength;
      } else if (inlineCodeTicks === runLength) {
        inlineCodeTicks = 0;
      }

      index += runLength;
      continue;
    }

    if (
      inlineCodeTicks === 0 &&
      character === "\\" &&
      isUnescapedBackslash(markdown, index)
    ) {
      const delimiter = markdown.charAt(index + 1);

      if (delimiter === "(" || delimiter === ")") {
        result += "$";
        index += 2;
        continue;
      }

      if (delimiter === "[" || delimiter === "]") {
        result += "$$";
        index += 2;
        continue;
      }
    }

    result += character;
    index += 1;
  }

  return result;
}

export class LainBrainMarkdownRenderBatch {
  private component?: Component;
  private generation = 0;

  constructor(private readonly app: App) {}

  reset(): void {
    this.generation += 1;
    this.component?.unload();
    this.component = new Component();
    this.component.load();
  }

  destroy(): void {
    this.generation += 1;
    this.component?.unload();
    this.component = undefined;
  }

  render(
    markdown: string,
    containerEl: HTMLElement,
    sourcePath: string
  ): void {
    if (this.component === undefined) {
      this.reset();
    }

    const component = this.component;

    if (component === undefined) {
      return;
    }

    const generation = this.generation;
    const showFallback = (): void => {
      if (
        this.component !== component ||
        this.generation !== generation ||
        !containerEl.isConnected
      ) {
        return;
      }

      containerEl.empty();

      const originalText = containerEl.createDiv();
      originalText.style.whiteSpace = "pre-wrap";
      originalText.setText(markdown);

      const errorMessage = containerEl.createEl("small", {
        text: "Markdown rendering failed; showing plain text."
      });
      errorMessage.style.display = "block";
      errorMessage.style.marginTop = "0.35rem";
      errorMessage.style.color = "var(--text-error)";
    };

    try {
      void MarkdownRenderer.render(
        this.app,
        normalizeMathDelimiters(markdown),
        containerEl,
        sourcePath,
        component
      ).then(() => {
        if (
          this.component === component &&
          this.generation === generation &&
          containerEl.isConnected
        ) {
          annotateRenderedMath(containerEl, markdown);
        }
      }).catch(showFallback);
    } catch {
      showFallback();
    }
  }
}

function isUnescapedBackslash(
  markdown: string,
  index: number
): boolean {
  let precedingBackslashes = 0;

  for (
    let cursor = index - 1;
    cursor >= 0 && markdown[cursor] === "\\";
    cursor -= 1
  ) {
    precedingBackslashes += 1;
  }

  return precedingBackslashes % 2 === 0;
}


function findBackslashMathClose(
  markdown: string,
  startIndex: number,
  closing: ")" | "]"
): number {
  for (let index = startIndex; index < markdown.length - 1; index += 1) {
    if (
      markdown[index] === "\\" &&
      markdown[index + 1] === closing &&
      isUnescapedBackslash(markdown, index)
    ) {
      return index;
    }
  }

  return -1;
}

function findDollarMathClose(
  markdown: string,
  startIndex: number,
  delimiterLength: number
): number {
  for (let index = startIndex; index < markdown.length; index += 1) {
    if (
      markdown[index] !== "$" ||
      isEscapedCharacter(markdown, index)
    ) {
      continue;
    }

    if (delimiterLength === 2) {
      if (markdown[index + 1] === "$") {
        return index;
      }
      continue;
    }

    if (markdown[index + 1] !== "$" && markdown[index - 1] !== "$") {
      return index;
    }
  }

  return -1;
}

function isEscapedCharacter(markdown: string, index: number): boolean {
  let precedingBackslashes = 0;

  for (
    let cursor = index - 1;
    cursor >= 0 && markdown[cursor] === "\\";
    cursor -= 1
  ) {
    precedingBackslashes += 1;
  }

  return precedingBackslashes % 2 === 1;
}

function getRenderedMathElements(
  containerEl: HTMLElement
): HTMLElement[] {
  const wrappers = Array.from(
    containerEl.querySelectorAll<HTMLElement>(".math")
  ).filter((element) =>
    element.parentElement?.closest(".math") === null ||
    element.parentElement?.closest(".math") === undefined
  );

  if (wrappers.length > 0) {
    return wrappers;
  }

  return Array.from(
    containerEl.querySelectorAll<HTMLElement>("mjx-container")
  ).filter((element) =>
    element.parentElement?.closest("mjx-container") === null ||
    element.parentElement?.closest("mjx-container") === undefined
  );
}

function enableMathTextSelection(mathElement: HTMLElement): void {
  for (const element of [
    mathElement,
    ...Array.from(
      mathElement.querySelectorAll<HTMLElement>(
        "mjx-container, mjx-assistive-mml"
      )
    )
  ]) {
    element.style.setProperty("user-select", "text", "important");
    element.style.setProperty(
      "-webkit-user-select",
      "text",
      "important"
    );
  }
}

function getMathSourceBody(source: string): string {
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

function isDisplayMathElement(element: HTMLElement): boolean {
  return (
    element.classList.contains("math-block") ||
    element.getAttribute("display") === "true" ||
    element.querySelector('mjx-container[display="true"]') !== null
  );
}
