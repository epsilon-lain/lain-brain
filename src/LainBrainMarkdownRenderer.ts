import {
  App,
  Component,
  MarkdownRenderer
} from "obsidian";

interface FenceState {
  marker: "`" | "~";
  length: number;
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
      ).catch(showFallback);
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
