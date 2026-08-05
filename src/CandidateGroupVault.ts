export function buildCandidateGroupParentMarkdown(
  parentTitle: string,
  groupId: string,
  childLinkTargets: readonly string[]
): string {
  const displayTitle = parentTitle.trim();
  const links = childLinkTargets
    .map((target) => `- [[${target}]]`)
    .join("\n");
  const frontmatter = [
    "---",
    "lain-brain-type: candidate-group-parent",
    `lain-brain-group-id: ${JSON.stringify(groupId)}`,
    `lain-brain-parent-title: ${JSON.stringify(displayTitle)}`,
    "---"
  ].join("\n");

  return (
    `${frontmatter}\n\n# ${displayTitle}\n\n` +
    `## Child notes\n\n${links}\n`
  );
}

export function addCandidateParentLink(
  markdown: string,
  parentLinkTarget: string,
  parentDisplayTitle?: string
): string {
  const alias = parentDisplayTitle?.trim();
  const parentLine = alias === undefined || alias === ""
    ? `Parent: [[${parentLinkTarget}]]`
    : `Parent: [[${parentLinkTarget}|${alias}]]`;

  if (markdown.split(/\r?\n/).includes(parentLine)) {
    return markdown;
  }

  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const title = /^#(?!#)\s+.*$/m.exec(markdown);

  if (title === null) {
    return `${parentLine}${newline}${newline}${markdown}`;
  }

  const insertAt = title.index + title[0].length;

  return (
    markdown.slice(0, insertAt) +
    `${newline}${newline}${parentLine}` +
    markdown.slice(insertAt)
  );
}

export function setCandidateParentLink(
  markdown: string,
  parentLinkTarget: string,
  parentDisplayTitle: string
): string {
  return addCandidateParentLink(
    stripCandidateParentLinks(markdown),
    parentLinkTarget,
    parentDisplayTitle
  );
}

export function stripCandidateParentLinks(markdown: string): string {
  const lines = markdown.split(/(\r?\n)/);

  for (let index = lines.length - 1; index >= 0; index -= 2) {
    if (/^Parent:\s*\[\[[^\]]+\]\]\s*$/i.test(lines[index] ?? "")) {
      lines.splice(index, lines[index + 1] === undefined ? 1 : 2);
    }
  }

  return lines.join("").replace(/^(\r?\n)+/, "");
}

export function extractCandidateParentHint(markdown: string): string | null {
  const match = /^Parent:\s*(?:\[\[([^\]|]+)(?:\|[^\]]+)?\]\]|(.+?))\s*$/im.exec(
    markdown
  );
  const hint = (match?.[1] ?? match?.[2])
    ?.replace(/\.md$/i, "")
    .trim();

  return hint === undefined || hint === "" ? null : hint;
}

export function addCandidateChildLink(
  markdown: string,
  childLinkTarget: string,
  childDisplayTitle: string
): { markdown: string; added: boolean } {
  const normalizedTarget = childLinkTarget
    .replace(/\.md$/i, "")
    .toLocaleLowerCase();
  const normalizedBaseTarget = getMarkdownLinkTarget(childLinkTarget)
    .toLocaleLowerCase();
  const existingTargets = [...markdown.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
    .map((match) => match[1]?.replace(/\.md$/i, "").toLocaleLowerCase());

  if (
    existingTargets.includes(normalizedTarget) ||
    existingTargets.includes(normalizedBaseTarget)
  ) {
    return { markdown, added: false };
  }

  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const line = `- [[${childLinkTarget}|${childDisplayTitle.trim()}]]`;
  const heading = /^##\s+Child notes\s*$/im.exec(markdown);

  if (heading === null) {
    const separator = markdown.endsWith(newline) ? newline : newline + newline;

    return {
      markdown:
        markdown + separator + `## Child notes${newline}${newline}${line}${newline}`,
      added: true
    };
  }

  const sectionStart = heading.index + heading[0].length;
  const nextHeading = /^##\s+/gm;
  nextHeading.lastIndex = sectionStart;
  const next = nextHeading.exec(markdown);
  const insertAt = next?.index ?? markdown.length;
  const before = markdown.slice(0, insertAt).replace(/(?:\r?\n)*$/, "");
  const after = markdown.slice(insertAt);

  return {
    markdown:
      before + newline + line + newline +
      (after === "" ? "" : after.replace(/^(\r?\n)*/, "")),
    added: true
  };
}

export function removeCandidateChildLink(
  markdown: string,
  childLinkTarget: string
): { markdown: string; removed: boolean } {
  const normalizedTarget = childLinkTarget
    .replace(/\.md$/i, "")
    .toLocaleLowerCase();
  const baseTarget = getMarkdownLinkTarget(childLinkTarget)
    .toLocaleLowerCase();
  const lines = markdown.split(/(\r?\n)/);

  for (let index = 0; index < lines.length; index += 2) {
    const match = /^- \[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(
      lines[index] ?? ""
    );
    const lineTarget = match?.[1]
      ?.replace(/\.md$/i, "")
      .toLocaleLowerCase();

    if (
      lineTarget !== normalizedTarget &&
      lineTarget !== baseTarget
    ) {
      continue;
    }

    lines.splice(index, lines[index + 1] === undefined ? 1 : 2);
    return { markdown: lines.join(""), removed: true };
  }

  return { markdown, removed: false };
}
export function getVaultPathLinkTarget(vaultPath: string): string {
  return vaultPath.replace(/\.md$/i, "");
}
export function getMarkdownLinkTarget(vaultPath: string): string {
  const fileName = vaultPath.split("/").pop() ?? vaultPath;

  return fileName.replace(/\.md$/i, "");
}

export function isValidCandidateGroupTitle(title: string): boolean {
  const value = title.trim();

  return (
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    value.length <= 200 &&
    !/[<>:"/\\|?*#^\[\]\r\n\u0000-\u001f]/.test(value) &&
    !/[. ]$/.test(value)
  );
}

export function deriveConciseCandidateGroupTitle(
  rawPrompt: string,
  fallbackTitle: string
): string {
  const firstLine = rawPrompt
    .split(/\r?\n/, 1)[0]
    ?.replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim() ?? "";
  const named = firstLine.match(
    /(?:named|called|titled)\s+(?:[-–—"'“”‘’]+)(.+?)(?:[-–—"'“”‘’]+)(?:[.!?]|$)/i
  )?.[1]?.trim();
  const quoted = firstLine.match(
    /["“‘']([^"”’']{2,120})["”’']/
  )?.[1]?.trim();
  const candidate = named ?? quoted ?? firstLine.replace(/[?？]+$/g, "");

  if (
    isValidCandidateGroupTitle(candidate) &&
    candidate.length <= 100 &&
    !/^(?:please|can you|could you|i am|i'm|create|generate|organize)\b/i.test(candidate)
  ) {
    return candidate;
  }

  return isValidCandidateGroupTitle(fallbackTitle)
    ? fallbackTitle.trim()
    : "Candidate Group";
}
