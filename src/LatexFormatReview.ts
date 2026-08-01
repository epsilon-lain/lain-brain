export interface LatexFormatIssue {
  code: string;
  message: string;
}

interface FenceState {
  marker: "`" | "~";
  length: number;
}

interface MathRange {
  start: number;
  end: number;
}

interface EnvironmentToken {
  kind: "begin" | "end";
  name: string;
  index: number;
}

export function reviewLatexFormatting(
  markdown: string
): LatexFormatIssue[] {
  const issues: LatexFormatIssue[] = [];
  const visibleText = maskCodeSegments(markdown, issues);
  const mathRanges = reviewDollarDelimiters(
    visibleText,
    issues
  );

  reviewLegacyDelimiters(visibleText, issues);
  reviewEnvironments(visibleText, mathRanges, issues);
  reviewNakedMath(visibleText, mathRanges, issues);

  const unique = new Map<string, LatexFormatIssue>();

  for (const issue of issues) {
    unique.set(`${issue.code}:${issue.message}`, issue);
  }

  return [...unique.values()];
}

export function appendLatexFormatWarning(
  markdown: string,
  issues: readonly LatexFormatIssue[]
): string {
  const details = issues
    .slice(0, 6)
    .map((issue) => `> - ${issue.message}`)
    .join("\n");

  return (
    `${markdown.trim()}\n\n` +
    "> [!warning] LaTeX 格式错误\n" +
    "> 自动修复未能通过格式审查，已保留原始文本。\n" +
    details
  ).trim();
}

function maskCodeSegments(
  markdown: string,
  issues: LatexFormatIssue[]
): string {
  let result = "";
  let index = 0;
  let inlineCodeTicks = 0;
  let fence: FenceState | null = null;

  while (index < markdown.length) {
    const atLineStart =
      index === 0 || markdown[index - 1] === "\n";

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
        if (
          /\\(?:begin|end|frac|dfrac|tfrac|lVert|rVert|mathsf)\b/.test(
            line
          ) ||
          /\$\$/.test(line)
        ) {
          issues.push({
            code: "math-in-code-block",
            message:
              "检测到代码块中的数学公式；数学公式必须使用 Markdown 数学分隔符。"
          });
        }

        if (isClosingFence(line, fence, fenceMatch)) {
          fence = null;
        }

        result += maskLine(line);

        if (newlineIndex !== -1) {
          result += "\n";
        }

        index = newlineIndex === -1
          ? markdown.length
          : newlineIndex + 1;
        continue;
      }

      const markerRun = fenceMatch?.[1];

      if (markerRun !== undefined) {
        const marker = markerRun[0];

        if (marker === "`" || marker === "~") {
          fence = {
            marker,
            length: markerRun.length
          };
        }

        result += maskLine(line);

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

      result += " ".repeat(runLength);

      if (inlineCodeTicks === 0) {
        inlineCodeTicks = runLength;
      } else if (inlineCodeTicks === runLength) {
        inlineCodeTicks = 0;
      }

      index += runLength;
      continue;
    }

    if (inlineCodeTicks !== 0) {
      result += character === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    result += character;
    index += 1;
  }

  return result;
}

function reviewDollarDelimiters(
  text: string,
  issues: LatexFormatIssue[]
): MathRange[] {
  const ranges: MathRange[] = [];
  let inlineStart: number | null = null;
  let displayStart: number | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);

    if (
      character === "\n" &&
      inlineStart !== null
    ) {
      issues.push({
        code: "multiline-inline-math",
        message: "行内数学分隔符跨越了换行。"
      });
      inlineStart = null;
      continue;
    }

    if (
      character !== "$" ||
      isEscaped(text, index)
    ) {
      continue;
    }

    if (text.startsWith("$$", index)) {
      const lineStart = text.lastIndexOf("\n", index - 1) + 1;
      const nextNewline = text.indexOf("\n", index);
      const lineEnd = nextNewline === -1
        ? text.length
        : nextNewline;
      const delimiterLine = text
        .slice(lineStart, lineEnd)
        .trim();

      if (delimiterLine !== "$$") {
        issues.push({
          code: "display-delimiter-line",
          message: "独立公式的 $$ 必须各自单独占一行。"
        });
      }

      if (inlineStart !== null) {
        issues.push({
          code: "mixed-dollar-delimiters",
          message: "行内数学中出现了 $$ 分隔符。"
        });
        inlineStart = null;
      } else if (displayStart === null) {
        displayStart = index;
      } else {
        ranges.push({
          start: displayStart,
          end: index + 2
        });
        displayStart = null;
      }

      index += 1;
      continue;
    }

    if (displayStart !== null) {
      issues.push({
        code: "single-dollar-in-display",
        message: "独立公式内部出现了未转义的单个 $。"
      });
      continue;
    }

    if (inlineStart === null) {
      inlineStart = index;
    } else {
      ranges.push({
        start: inlineStart,
        end: index + 1
      });
      inlineStart = null;
    }
  }

  if (inlineStart !== null) {
    issues.push({
      code: "unclosed-inline-math",
      message: "存在未闭合的行内数学 $ 分隔符。"
    });
  }

  if (displayStart !== null) {
    issues.push({
      code: "unclosed-display-math",
      message: "存在未闭合的独立数学 $$ 分隔符。"
    });
  }

  return ranges;
}

function reviewLegacyDelimiters(
  text: string,
  issues: LatexFormatIssue[]
): void {
  if (/\\(?:\(|\)|\[|\])/.test(text)) {
    issues.push({
      code: "legacy-math-delimiter",
      message:
        "检测到 \\(...\\) 或 \\[...\\]；输出必须统一使用 $ 或 $$。"
    });
  }
}

function reviewEnvironments(
  text: string,
  mathRanges: readonly MathRange[],
  issues: LatexFormatIssue[]
): void {
  const tokens: EnvironmentToken[] = [];
  const environmentPattern =
    /\\(begin|end)\{([^{}\s]+)\}/g;

  for (const match of text.matchAll(environmentPattern)) {
    const kind = match[1];
    const name = match[2];
    const index = match.index;

    if (
      (kind !== "begin" && kind !== "end") ||
      name === undefined ||
      index === undefined
    ) {
      continue;
    }

    tokens.push({
      kind,
      name,
      index
    });
  }

  const commandCount =
    [...text.matchAll(/\\(?:begin|end)\b/g)].length;

  if (commandCount !== tokens.length) {
    issues.push({
      code: "incomplete-environment-command",
      message:
        "存在不完整的 \\begin{...} 或 \\end{...} 环境命令。"
    });
  }

  const stack: EnvironmentToken[] = [];

  for (const token of tokens) {
    if (!isInsideMath(token.index, mathRanges)) {
      issues.push({
        code: "environment-outside-math",
        message:
          `数学环境 ${token.kind}{${token.name}} 位于数学分隔符之外。`
      });
    }

    if (token.kind === "begin") {
      stack.push(token);
      continue;
    }

    const opening = stack.pop();

    if (opening === undefined) {
      issues.push({
        code: "environment-without-begin",
        message: `\\end{${token.name}} 没有对应的 \\begin。`
      });
      continue;
    }

    if (opening.name !== token.name) {
      issues.push({
        code: "mismatched-environment",
        message:
          `数学环境不匹配：\\begin{${opening.name}} ` +
          `对应了 \\end{${token.name}}。`
      });
    }
  }

  for (const opening of stack) {
    issues.push({
      code: "environment-without-end",
      message:
        `\\begin{${opening.name}} 没有对应的 \\end{${opening.name}}。`
    });
  }
}

function reviewNakedMath(
  text: string,
  mathRanges: readonly MathRange[],
  issues: LatexFormatIssue[]
): void {
  const prose = maskMathRanges(text, mathRanges);

  if (/\|\|[^|\n]+\|\|/.test(prose)) {
    issues.push({
      code: "ascii-norm",
      message:
        "检测到裸 ||...|| 范数；应在数学分隔符内使用 \\lVert...\\rVert。"
    });
  }

  if (
    /\b[A-Za-z][A-Za-z0-9_]*\s*\^(?:\{[^}\n]+\}|[+\-A-Za-z0-9])/.test(
      prose
    )
  ) {
    issues.push({
      code: "naked-superscript",
      message:
        "检测到数学分隔符之外的转置、伪逆或上标表达。"
    });
  }

  if (/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ᵀ]/.test(prose)) {
    issues.push({
      code: "unicode-superscript",
      message:
        "检测到 Unicode 上标；应在数学分隔符内使用完整 LaTeX 上标。"
    });
  }

  if (/\]\s*,\s*\[/.test(prose)) {
    issues.push({
      code: "broken-matrix-fragment",
      message: "检测到类似 ],[ 的不完整矩阵片段。"
    });
  }

  if (
    /(^|[\s:：])\[[+-]?\d+(?:\s*[,;]\s*[+-]?\d+)*\](?=$|[\s.,;，。])/m.test(
      prose
    )
  ) {
    issues.push({
      code: "bare-numeric-brackets",
      message:
        "检测到类似 [2] 的裸数值括号表达；数学内容必须使用完整 LaTeX。"
    });
  }

  if (
    /\\(?:frac|dfrac|tfrac|lVert|rVert|int|sum|prod|sqrt|mathsf|mathbf|begin|end)\b/.test(
      prose
    )
  ) {
    issues.push({
      code: "latex-outside-math",
      message: "检测到数学分隔符之外的 LaTeX 命令。"
    });
  }
}

function maskMathRanges(
  text: string,
  ranges: readonly MathRange[]
): string {
  const characters = text.split("");

  for (const range of ranges) {
    for (
      let index = range.start;
      index < range.end;
      index += 1
    ) {
      if (characters[index] !== "\n") {
        characters[index] = " ";
      }
    }
  }

  return characters.join("");
}

function isInsideMath(
  index: number,
  ranges: readonly MathRange[]
): boolean {
  return ranges.some(
    (range) => index > range.start && index < range.end
  );
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;

  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }

  return backslashes % 2 === 1;
}

function maskLine(line: string): string {
  return " ".repeat(line.length);
}

function isClosingFence(
  line: string,
  fence: FenceState,
  match: RegExpMatchArray | null
): boolean {
  if (match === null) {
    return false;
  }

  const markerRun = match[1];

  if (
    markerRun === undefined ||
    markerRun[0] !== fence.marker ||
    markerRun.length < fence.length
  ) {
    return false;
  }

  return /^[ \t]*$/.test(line.slice(match[0].length));
}
