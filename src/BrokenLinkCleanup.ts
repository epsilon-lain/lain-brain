import { normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";
import { discoverCandidateParents } from "./CandidateParentDiscovery";
import type { LainBrainSession } from "./LainBrainSession";

export interface BrokenLinkCleanupProposal {
  id: string;
  sourcePath: string;
  startOffset: number;
  endOffset: number;
  currentWikiLink: string;
  target: string;
  proposedReplacement: string;
  reason: string;
}

export interface SelectedBrokenLinkCleanup {
  id: string;
  sourcePath: string;
  startOffset: number;
  endOffset: number;
  currentWikiLink: string;
  replacement: string;
}

export interface BrokenLinkCleanupResult {
  id: string;
  sourcePath: string;
  ok: boolean;
  message: string;
}

interface FenceState {
  marker: "`" | "~";
  length: number;
}

interface WikiLinkOccurrence {
  startOffset: number;
  endOffset: number;
  currentWikiLink: string;
  target: string;
  visibleText: string;
}


const INSTRUCTION_PREFIX =
  /^(?:i\s+am|i'm|please|create|generate|build|make|organize|explain|write)\b/i;

export async function discoverBrokenLinkCleanupReview(
  app: App,
  session: LainBrainSession
): Promise<BrokenLinkCleanupProposal[]> {
  const managedPaths = await discoverManagedNotePaths(app, session);
  const proposals: BrokenLinkCleanupProposal[] = [];

  for (const sourcePath of [...managedPaths].sort()) {
    const source = app.vault.getFileByPath(sourcePath);

    if (source === null) {
      continue;
    }

    let markdown: string;

    try {
      markdown = await app.vault.cachedRead(source);
    } catch {
      continue;
    }

    for (const occurrence of findWikiLinksOutsideProtectedRegions(markdown)) {
      if (
        resolveLink(app, source, occurrence.target) !== null ||
        !isUnsafeLegacyTarget(occurrence.target)
      ) {
        continue;
      }

      proposals.push({
        id: createOccurrenceId(
          sourcePath,
          occurrence.startOffset,
          occurrence.endOffset,
          occurrence.currentWikiLink
        ),
        sourcePath,
        startOffset: occurrence.startOffset,
        endOffset: occurrence.endOffset,
        currentWikiLink: occurrence.currentWikiLink,
        target: occurrence.target,
        proposedReplacement: occurrence.visibleText,
        reason:
          "Unresolved wikilink target is long or sentence-like"
      });
    }
  }

  return proposals;
}

export async function applyBrokenLinkCleanup(
  app: App,
  session: LainBrainSession,
  selections: readonly SelectedBrokenLinkCleanup[]
): Promise<BrokenLinkCleanupResult[]> {
  if (selections.length === 0) {
    return [];
  }

  const currentReview = await discoverBrokenLinkCleanupReview(app, session);
  const eligible = new Set(currentReview.map(proposalKey));
  const results = new Map<string, BrokenLinkCleanupResult>();
  const bySource = new Map<string, SelectedBrokenLinkCleanup[]>();

  for (const selection of selections) {
    const sourcePath = normalizePath(selection.sourcePath);
    const normalized = { ...selection, sourcePath };
    const list = bySource.get(sourcePath) ?? [];
    list.push(normalized);
    bySource.set(sourcePath, list);
  }

  for (const [sourcePath, sourceSelections] of bySource) {
    const source = app.vault.getFileByPath(sourcePath);

    if (source === null) {
      for (const selection of sourceSelections) {
        results.set(selection.id, failure(selection, "Source note no longer exists"));
      }
      continue;
    }

    let markdown: string;

    try {
      markdown = await app.vault.cachedRead(source);
    } catch {
      for (const selection of sourceSelections) {
        results.set(selection.id, failure(selection, "Unable to read source note"));
      }
      continue;
    }

    const valid: SelectedBrokenLinkCleanup[] = [];
    const occupied = new Set<string>();

    for (const selection of sourceSelections) {
      const rangeKey = `${selection.startOffset}:${selection.endOffset}`;
      const exactText = markdown.slice(
        selection.startOffset,
        selection.endOffset
      );

      if (
        exactText !== selection.currentWikiLink ||
        selection.endOffset <= selection.startOffset
      ) {
        results.set(
          selection.id,
          failure(selection, "Source content changed; repair skipped")
        );
      } else if (!eligible.has(selectionKey(selection))) {
        results.set(
          selection.id,
          failure(selection, "Link is no longer an eligible broken link")
        );
      } else if (occupied.has(rangeKey)) {
        results.set(
          selection.id,
          failure(selection, "Duplicate repair selection")
        );
      } else {
        occupied.add(rangeKey);
        valid.push(selection);
      }
    }

    if (valid.length === 0) {
      continue;
    }

    let updated = markdown;

    for (const selection of [...valid].sort(
      (left, right) => right.startOffset - left.startOffset
    )) {
      updated =
        updated.slice(0, selection.startOffset) +
        selection.replacement +
        updated.slice(selection.endOffset);
    }

    try {
      await app.vault.modify(source, updated);

      for (const selection of valid) {
        results.set(selection.id, {
          id: selection.id,
          sourcePath,
          ok: true,
          message: "Broken link markup removed"
        });
      }
    } catch {
      for (const selection of valid) {
        results.set(selection.id, failure(selection, "Unable to update source note"));
      }
    }
  }

  return selections.map((selection) =>
    results.get(selection.id) ??
    failure(selection, "Repair was not attempted")
  );
}

async function discoverManagedNotePaths(
  app: App,
  session: LainBrainSession
): Promise<Set<string>> {
  const paths = new Set(
    session.getLainBrainManagedVaultPaths().filter(isSafeVaultMarkdownPath)
  );
  const parents = await discoverCandidateParents(app);

  for (const parent of parents) {
    if (!isSafeVaultMarkdownPath(parent.parentVaultPath)) {
      continue;
    }

    paths.add(parent.parentVaultPath);
    const parentFile = app.vault.getFileByPath(parent.parentVaultPath);

    if (parentFile === null) {
      continue;
    }

    let markdown: string;

    try {
      markdown = await app.vault.cachedRead(parentFile);
    } catch {
      continue;
    }

    for (const target of extractChildLinkTargets(markdown)) {
      const child = resolveLink(app, parentFile, target);

      if (child !== null && isSafeVaultMarkdownPath(child.path)) {
        paths.add(child.path);
      }
    }
  }

  return paths;
}

function findWikiLinksOutsideProtectedRegions(
  markdown: string
): WikiLinkOccurrence[] {
  const links: WikiLinkOccurrence[] = [];
  let index = 0;
  let fence: FenceState | null = null;
  let inlineTicks = 0;
  let math: "dollars" | "brackets" | null = null;

  while (index < markdown.length) {
    const atLineStart = index === 0 || markdown[index - 1] === "\n";

    if (atLineStart) {
      const lineBreak = markdown.indexOf("\n", index);
      const lineEnd = lineBreak === -1 ? markdown.length : lineBreak;
      const line = markdown.slice(index, lineEnd);
      const marker = line.match(
        /^(?:(?:[ \t]*>[ \t]?)*[ \t]*)(`{3,}|~{3,})/
      )?.[1];

      if (fence !== null) {
        if (
          marker !== undefined &&
          marker[0] === fence.marker &&
          marker.length >= fence.length &&
          /^[ \t]*$/.test(line.slice(line.indexOf(marker) + marker.length))
        ) {
          fence = null;
        }

        index = lineBreak === -1 ? markdown.length : lineBreak + 1;
        continue;
      }

      if (marker !== undefined) {
        const markerCharacter = marker[0];

        if (markerCharacter === "`" || markerCharacter === "~") {
          fence = { marker: markerCharacter, length: marker.length };
          index = lineBreak === -1 ? markdown.length : lineBreak + 1;
          continue;
        }
      }
    }

    if (math === "dollars") {
      if (markdown.startsWith("$$", index) && !isEscaped(markdown, index)) {
        math = null;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (math === "brackets") {
      if (markdown.startsWith("\\]", index) && !isEscaped(markdown, index)) {
        math = null;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (inlineTicks === 0) {
      if (markdown.startsWith("$$", index) && !isEscaped(markdown, index)) {
        math = "dollars";
        index += 2;
        continue;
      }

      if (markdown.startsWith("\\[", index) && !isEscaped(markdown, index)) {
        math = "brackets";
        index += 2;
        continue;
      }
    }

    if (markdown[index] === "`") {
      let length = 1;

      while (markdown[index + length] === "`") {
        length += 1;
      }

      if (inlineTicks === 0) {
        inlineTicks = length;
      } else if (inlineTicks === length) {
        inlineTicks = 0;
      }

      index += length;
      continue;
    }

    if (
      inlineTicks === 0 &&
      markdown.startsWith("[[", index) &&
      markdown[index - 1] !== "!" &&
      !isEscaped(markdown, index)
    ) {
      const end = markdown.indexOf("]]", index + 2);

      if (end !== -1) {
        const currentWikiLink = markdown.slice(index, end + 2);
        const inner = markdown.slice(index + 2, end);
        const aliasIndex = inner.indexOf("|");
        const target = (
          aliasIndex === -1 ? inner : inner.slice(0, aliasIndex)
        ).trim();
        const visibleText = (
          aliasIndex === -1 ? inner : inner.slice(aliasIndex + 1)
        ).trim();

        if (target !== "" && visibleText !== "") {
          links.push({
            startOffset: index,
            endOffset: end + 2,
            currentWikiLink,
            target,
            visibleText
          });
        }

        index = end + 2;
        continue;
      }
    }

    index += 1;
  }

  return links;
}

function isUnsafeLegacyTarget(target: string): boolean {
  const normalized = target.replace(/\s+/g, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);

  return (
    normalized.length > 70 ||
    INSTRUCTION_PREFIX.test(normalized) ||
    (
      normalized.length >= 40 &&
      words.length >= 7 &&
      /[:;,.!?。！？]/.test(normalized)
    )
  );
}

function extractChildLinkTargets(markdown: string): string[] {
  const heading = /^##\s+Child notes\s*$/im.exec(markdown);

  if (heading === null) {
    return [];
  }

  const start = heading.index + heading[0].length;
  const nextHeading = /^#{1,2}\s+/gm;
  nextHeading.lastIndex = start;
  const next = nextHeading.exec(markdown);
  const section = markdown.slice(start, next?.index ?? markdown.length);

  return [...section.matchAll(
    /^\s*-\s+\[\[([^\]|#^]+)(?:[|#^][^\]]*)?\]\]\s*$/gm
  )]
    .map((match) => match[1]?.trim())
    .filter((target): target is string => target !== undefined);
}

function resolveLink(
  app: App,
  source: TFile,
  target: string
): TFile | null {
  const metadataDestination = app.metadataCache
    .getFirstLinkpathDest(target, source.path);

  if (metadataDestination !== null) {
    return metadataDestination;
  }

  const linkPath = target.split("#", 1)[0]?.split("^", 1)[0]?.trim();

  if (linkPath === undefined || linkPath === "") {
    return source;
  }

  const markdownPath = linkPath.toLowerCase().endsWith(".md")
    ? linkPath
    : `${linkPath}.md`;
  const sourceFolder = source.path.slice(0, source.path.lastIndexOf("/"));
  const possiblePaths = linkPath.includes("/")
    ? [normalizePath(markdownPath)]
    : [
        normalizePath(`${sourceFolder}/${markdownPath}`),
        normalizePath(markdownPath)
      ];

  for (const path of possiblePaths) {
    const file = app.vault.getFileByPath(path);

    if (file !== null) {
      return file;
    }
  }

  return null;
}

function isSafeVaultMarkdownPath(path: string): boolean {
  const normalized = normalizePath(path);

  return (
    normalized !== "" &&
    !/^(?:[a-z]:|\/)/i.test(normalized) &&
    normalized.toLowerCase().endsWith(".md") &&
    !normalized.split("/").includes("..")
  );
}

function createOccurrenceId(
  sourcePath: string,
  startOffset: number,
  endOffset: number,
  currentWikiLink: string
): string {
  let hash = 2166136261;
  const value = `${sourcePath}:${startOffset}:${endOffset}:${currentWikiLink}`;

  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return `broken-link-${(hash >>> 0).toString(36)}`;
}

function proposalKey(proposal: BrokenLinkCleanupProposal): string {
  return [
    proposal.sourcePath,
    proposal.startOffset,
    proposal.endOffset,
    proposal.currentWikiLink
  ].join("\u0000");
}

function selectionKey(selection: SelectedBrokenLinkCleanup): string {
  return [
    selection.sourcePath,
    selection.startOffset,
    selection.endOffset,
    selection.currentWikiLink
  ].join("\u0000");
}

function failure(
  selection: SelectedBrokenLinkCleanup,
  message: string
): BrokenLinkCleanupResult {
  return {
    id: selection.id,
    sourcePath: selection.sourcePath,
    ok: false,
    message
  };
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}
