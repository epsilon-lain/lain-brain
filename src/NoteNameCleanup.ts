import { normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";
import {
  deriveConciseCandidateGroupTitle,
  getMarkdownLinkTarget,
  isValidCandidateGroupTitle
} from "./CandidateGroupVault";
import {
  discoverCandidateParents
} from "./CandidateParentDiscovery";
import {
  validateCandidateNotePath
} from "./CandidateNoteVault";
import type { LainBrainSession } from "./LainBrainSession";

export interface NoteNameCleanupProposal {
  sourcePath: string;
  currentFileName: string;
  suggestedFileName: string;
  reason: string;
}

export interface NoteNameFutureReviewItem {
  sourcePath: string;
  linkTarget: string;
  reason: string;
}

export interface NoteNameCleanupReview {
  proposals: NoteNameCleanupProposal[];
  futureReviewItems: NoteNameFutureReviewItem[];
}

export interface SelectedNoteNameCleanup {
  sourcePath: string;
  targetFileName: string;
}

export interface NoteNameCleanupResult {
  sourcePath: string;
  targetPath?: string;
  ok: boolean;
  message: string;
}

const NOTES_ROOT = "Lain Brain/Notes/";
const INSTRUCTION_BOILERPLATE =
  /^(?:i\s+am|i'm|please|create|generate|build|make|organize)\b/i;

export async function discoverNoteNameCleanupReview(
  app: App,
  session: LainBrainSession
): Promise<NoteNameCleanupReview> {
  const parents = await discoverCandidateParents(app);
  const managedPaths = new Set<string>(
    session.getLainBrainManagedVaultPaths()
  );
  const displayTitles = new Map<string, string>();
  const markdownByPath = new Map<string, string>();

  for (const parent of parents) {
    managedPaths.add(parent.parentVaultPath);
    displayTitles.set(
      parent.parentVaultPath,
      parent.parentDisplayTitle
    );
    const parentFile = app.vault.getFileByPath(parent.parentVaultPath);

    if (parentFile === null) {
      continue;
    }

    const markdown = await readSafely(app, parentFile);

    if (markdown === null) {
      continue;
    }

    markdownByPath.set(parentFile.path, markdown);

    for (const target of extractChildLinkTargets(markdown)) {
      const child = resolveLink(app, parentFile, target);

      if (child !== null && isInsideNotesRoot(child.path)) {
        managedPaths.add(child.path);
      }
    }
  }

  const proposals: NoteNameCleanupProposal[] = [];
  const futureReviewItems: NoteNameFutureReviewItem[] = [];

  for (const sourcePath of [...managedPaths].sort()) {
    if (!isInsideNotesRoot(sourcePath)) {
      continue;
    }

    const file = app.vault.getFileByPath(sourcePath);

    if (file === null) {
      continue;
    }

    const markdown = markdownByPath.get(sourcePath) ??
      await readSafely(app, file);

    if (markdown === null) {
      continue;
    }

    const currentTitle = file.basename;
    const reason = getCleanupReason(currentTitle);

    if (reason !== null) {
      const suggestedTitle = suggestSafeTitle(
        currentTitle,
        markdown,
        displayTitles.get(sourcePath)
      );

      if (
        suggestedTitle !== currentTitle &&
        isValidCandidateGroupTitle(suggestedTitle)
      ) {
        proposals.push({
          sourcePath,
          currentFileName: `${currentTitle}.md`,
          suggestedFileName: `${suggestedTitle}.md`,
          reason
        });
      }
    }

    for (const target of extractWikiLinkTargets(markdown)) {
      if (
        getCleanupReason(getMarkdownLinkTarget(target)) !== null &&
        resolveLink(app, file, target) === null
      ) {
        futureReviewItems.push({
          sourcePath,
          linkTarget: target,
          reason:
            "Long or instruction-like link target does not resolve. Review manually later."
        });
      }
    }
  }

  return { proposals, futureReviewItems };
}

export async function applyNoteNameCleanup(
  app: App,
  session: LainBrainSession,
  selections: readonly SelectedNoteNameCleanup[]
): Promise<NoteNameCleanupResult[]> {
  if (selections.length === 0) {
    return [];
  }

  const review = await discoverNoteNameCleanupReview(app, session);
  const allowedSources = new Set(
    review.proposals.map((proposal) => proposal.sourcePath)
  );
  const plans = selections.map((selection) =>
    buildRenamePlan(app, selection, allowedSources)
  );
  const targetCounts = new Map<string, number>();

  for (const plan of plans) {
    if (plan.targetPath === undefined) {
      continue;
    }

    const key = plan.targetPath.normalize("NFKC").toLocaleLowerCase();
    targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
  }

  for (const plan of plans) {
    if (plan.targetPath === undefined || !plan.ok) {
      continue;
    }

    const key = plan.targetPath.normalize("NFKC").toLocaleLowerCase();

    if ((targetCounts.get(key) ?? 0) > 1) {
      plan.ok = false;
      plan.message = "Duplicate target path in this batch";
    }
  }

  for (const plan of plans) {
    if (!plan.ok || plan.targetPath === undefined) {
      continue;
    }

    const source = app.vault.getFileByPath(plan.sourcePath);

    if (source === null) {
      plan.ok = false;
      plan.message = "Source note no longer exists";
      continue;
    }

    if (app.vault.getAbstractFileByPath(plan.targetPath) !== null) {
      plan.ok = false;
      plan.message = "Target note already exists";
      continue;
    }

    try {
      await app.fileManager.renameFile(source, plan.targetPath);
      session.updateVaultPathReferences(
        plan.sourcePath,
        plan.targetPath
      );
      plan.message = "Renamed";
    } catch {
      plan.ok = false;
      plan.message = "Rename failed";
    }
  }

  return plans;
}

function buildRenamePlan(
  app: App,
  selection: SelectedNoteNameCleanup,
  allowedSources: ReadonlySet<string>
): NoteNameCleanupResult {
  const sourcePath = normalizePath(selection.sourcePath);

  if (!allowedSources.has(sourcePath) || !isInsideNotesRoot(sourcePath)) {
    return {
      sourcePath,
      ok: false,
      message: "Note is outside the Lain Brain cleanup scope"
    };
  }

  if (app.vault.getFileByPath(sourcePath) === null) {
    return {
      sourcePath,
      ok: false,
      message: "Source note no longer exists"
    };
  }

  const folder = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
  const pathResult = validateCandidateNotePath(
    selection.targetFileName,
    folder
  );

  if (!pathResult.ok) {
    return {
      sourcePath,
      ok: false,
      message: pathResult.error
    };
  }

  if (pathResult.vaultPath === sourcePath) {
    return {
      sourcePath,
      targetPath: pathResult.vaultPath,
      ok: false,
      message: "Target name is unchanged"
    };
  }

  if (app.vault.getAbstractFileByPath(pathResult.vaultPath) !== null) {
    return {
      sourcePath,
      targetPath: pathResult.vaultPath,
      ok: false,
      message: "Target note already exists"
    };
  }

  return {
    sourcePath,
    targetPath: pathResult.vaultPath,
    ok: true,
    message: "Ready"
  };
}

function getCleanupReason(title: string): string | null {
  if (INSTRUCTION_BOILERPLATE.test(title.trim())) {
    return "Filename contains instruction boilerplate";
  }

  if (title.length > 70) {
    return "Generated filename exceeds 70 characters";
  }

  return null;
}

function suggestSafeTitle(
  currentTitle: string,
  markdown: string,
  parentDisplayTitle?: string
): string {
  if (
    parentDisplayTitle !== undefined &&
    parentDisplayTitle.length <= 70 &&
    isValidCandidateGroupTitle(parentDisplayTitle)
  ) {
    return parentDisplayTitle;
  }

  const coreConcept = /^##\s+核心概念\s*$[\s\S]*?^-\s+\[\[([^\]|#^]+)(?:\|[^\]]+)?\]\]/im
    .exec(markdown)?.[1]?.trim();

  if (
    coreConcept !== undefined &&
    coreConcept.length <= 70 &&
    isValidCandidateGroupTitle(coreConcept)
  ) {
    return coreConcept;
  }

  const heading = /^#(?!#)\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1]?.trim();

  if (
    heading !== undefined &&
    heading.length <= 70 &&
    !INSTRUCTION_BOILERPLATE.test(heading) &&
    isValidCandidateGroupTitle(heading)
  ) {
    return heading;
  }

  const derived = deriveConciseCandidateGroupTitle(
    currentTitle,
    truncateTitle(currentTitle, 70)
  );

  return truncateTitle(derived, 70);
}

function truncateTitle(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maximum) {
    return normalized;
  }

  const prefix = normalized.slice(0, maximum + 1);
  const boundary = Math.max(
    prefix.lastIndexOf(" "),
    prefix.lastIndexOf("-"),
    prefix.lastIndexOf("–")
  );

  return normalized.slice(
    0,
    boundary >= Math.floor(maximum * 0.6) ? boundary : maximum
  ).trim();
}

function extractChildLinkTargets(markdown: string): string[] {
  const heading = /^##\s+Child notes\s*$/im.exec(markdown);

  if (heading === null) {
    return [];
  }

  const start = heading.index + heading[0].length;
  const nextHeading = /^#{1,2}\s+/gm;
  nextHeading.lastIndex = start;
  const section = markdown.slice(start, nextHeading.exec(markdown)?.index);

  return [...section.matchAll(
    /^\s*-\s+\[\[([^\]|#^]+)(?:[|#^][^\]]*)?\]\]\s*$/gm
  )]
    .map((match) => match[1]?.trim())
    .filter((target): target is string => target !== undefined);
}

function extractWikiLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[\[([^\]|#^]+)(?:[|#^][^\]]*)?\]\]/g)]
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

  const targetPath = target.toLowerCase().endsWith(".md")
    ? target
    : `${target}.md`;
  const sourceFolder = source.path.slice(0, source.path.lastIndexOf("/"));
  const possiblePaths = target.includes("/")
    ? [normalizePath(targetPath)]
    : [
        normalizePath(`${sourceFolder}/${targetPath}`),
        normalizePath(targetPath)
      ];

  for (const path of possiblePaths) {
    const file = app.vault.getFileByPath(path);

    if (file !== null) {
      return file;
    }
  }

  return null;
}

function isInsideNotesRoot(path: string): boolean {
  const normalized = normalizePath(path);

  return (
    normalized.startsWith(NOTES_ROOT) &&
    normalized.toLowerCase().endsWith(".md") &&
    !normalized.split("/").includes("..")
  );
}

async function readSafely(
  app: App,
  file: TFile
): Promise<string | null> {
  try {
    return await app.vault.cachedRead(file);
  } catch {
    return null;
  }
}
