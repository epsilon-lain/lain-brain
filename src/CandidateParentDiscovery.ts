import { normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";
import {
  deriveConciseCandidateGroupTitle,
  getMarkdownLinkTarget,
  isValidCandidateGroupTitle
} from "./CandidateGroupVault";

export interface DiscoveredCandidateParent {
  groupId: string;
  parentVaultPath: string;
  parentDisplayTitle: string;
  legacy: boolean;
}

interface ParentFrontmatter {
  type?: string;
  groupId?: string;
  title?: string;
}

export async function discoverCandidateParents(
  app: App
): Promise<DiscoveredCandidateParent[]> {
  const discovered: DiscoveredCandidateParent[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    let markdown: string;

    try {
      markdown = await app.vault.cachedRead(file);
    } catch {
      continue;
    }

    const frontmatter = readParentFrontmatter(markdown);

    if (
      frontmatter.type === "candidate-group-parent" &&
      frontmatter.groupId !== undefined &&
      frontmatter.title !== undefined &&
      isValidCandidateGroupTitle(frontmatter.title)
    ) {
      discovered.push({
        groupId: frontmatter.groupId,
        parentVaultPath: file.path,
        parentDisplayTitle: frontmatter.title,
        legacy: false
      });
      continue;
    }

    if (
      isLegacyCandidateParent(app, file, markdown)
    ) {
      discovered.push({
        groupId: createVaultParentGroupId("legacy", file.path),
        parentVaultPath: file.path,
        parentDisplayTitle: deriveLegacyDisplayTitle(file, markdown),
        legacy: true
      });
    }
  }

  return discovered.sort((left, right) =>
    left.parentDisplayTitle.localeCompare(right.parentDisplayTitle)
  );
}

export function createVaultParentGroupId(
  kind: "legacy" | "existing",
  vaultPath: string
): string {
  let hash = 2166136261;

  for (const character of normalizePath(vaultPath).toLocaleLowerCase()) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return `${kind}-parent-${(hash >>> 0).toString(36)}`;
}

function readParentFrontmatter(markdown: string): ParentFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);

  if (match === null) {
    return {};
  }

  const values = new Map<string, string>();

  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const property = /^([^:#][^:]*):\s*(.*?)\s*$/.exec(line);

    if (property?.[1] === undefined || property[2] === undefined) {
      continue;
    }

    values.set(property[1].trim(), parseYamlScalar(property[2]));
  }

  return {
    type: values.get("lain-brain-type"),
    groupId: nonEmpty(values.get("lain-brain-group-id")),
    title: nonEmpty(values.get("lain-brain-parent-title"))
  };
}

function isLegacyCandidateParent(
  app: App,
  file: TFile,
  markdown: string
): boolean {
  if (!normalizePath(file.path).startsWith("Lain Brain/")) {
    return false;
  }

  const childSection = extractChildNotesSection(markdown);

  if (childSection === null) {
    return false;
  }

  const targets = [...childSection.matchAll(
    /^\s*-\s+\[\[([^\]|#^]+)(?:[|#^][^\]]*)?\]\]\s*$/gm
  )]
    .map((match) => match[1]?.trim())
    .filter((target): target is string => target !== undefined);
  const resolved = new Set<string>();

  for (const target of targets) {
    const fileAtTarget = resolveWikiLink(app, file, target);

    if (fileAtTarget !== null && fileAtTarget.path !== file.path) {
      resolved.add(fileAtTarget.path);
    }
  }

  return resolved.size >= 2;
}

function extractChildNotesSection(markdown: string): string | null {
  const heading = /^##\s+Child notes\s*$/im.exec(markdown);

  if (heading === null) {
    return null;
  }

  const start = heading.index + heading[0].length;
  const nextHeading = /^#{1,2}\s+/gm;
  nextHeading.lastIndex = start;
  const next = nextHeading.exec(markdown);

  return markdown.slice(start, next?.index ?? markdown.length);
}

function resolveWikiLink(
  app: App,
  source: TFile,
  target: string
): TFile | null {
  const metadataDestination = app.metadataCache
    .getFirstLinkpathDest(target, source.path);

  if (metadataDestination !== null) {
    return metadataDestination;
  }

  const targetPath = target.toLowerCase().endsWith(".md")
    ? target
    : `${target}.md`;
  const sourceFolder = source.path.includes("/")
    ? source.path.slice(0, source.path.lastIndexOf("/"))
    : "";
  const paths = target.includes("/")
    ? [normalizePath(targetPath)]
    : [
        normalizePath(`${sourceFolder}/${targetPath}`),
        normalizePath(targetPath)
      ];

  for (const path of paths) {
    const destination = app.vault.getFileByPath(path);

    if (destination !== null) {
      return destination;
    }
  }

  return null;
}

function deriveLegacyDisplayTitle(
  file: TFile,
  markdown: string
): string {
  const heading = /^#(?!#)\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1]?.trim();

  if (heading !== undefined && isValidCandidateGroupTitle(heading)) {
    return heading;
  }

  const fileTitle = getMarkdownLinkTarget(file.path);

  return deriveConciseCandidateGroupTitle(fileTitle, fileTitle);
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed) as string;
      } catch {
        return trimmed.slice(1, -1);
      }
    }

    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  return trimmed;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === ""
    ? undefined
    : value.trim();
}
