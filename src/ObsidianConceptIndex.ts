import type { App } from "obsidian";
import type { ConceptNode } from "./BrainGrowth";
import {
  createConceptIndex,
  type ConceptIndex
} from "./BrainGrowthIndex";
import {
  inspectConceptMarkdown,
  type ConceptPersistenceErrorCode
} from "./BrainGrowthPersistence";

export interface VaultConceptRecord {
  readonly vaultPath: string;
  readonly concept: ConceptNode;
}

export interface VaultConceptLoadIssue {
  readonly vaultPath: string;
  readonly code:
    | Exclude<ConceptPersistenceErrorCode, "not_concept_note">
    | "read_failed";
  readonly message: string;
}

export interface ObsidianConceptIndexResult {
  readonly index: ConceptIndex;
  readonly records: readonly VaultConceptRecord[];
  readonly issues: readonly VaultConceptLoadIssue[];
  readonly scannedMarkdownFiles: number;
}

/**
 * One-shot, read-only discovery. Ordinary Markdown is ignored and no listener,
 * cache, migration, or Vault mutation is installed.
 */
export async function loadObsidianConceptIndex(
  app: App
): Promise<ObsidianConceptIndexResult> {
  const files = [...app.vault.getMarkdownFiles()].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  const records: VaultConceptRecord[] = [];
  const issues: VaultConceptLoadIssue[] = [];

  for (const file of files) {
    let markdown: string;
    try {
      markdown = await app.vault.cachedRead(file);
    } catch {
      issues.push(Object.freeze({
        vaultPath: file.path,
        code: "read_failed",
        message: "Concept index could not read this Markdown file."
      }));
      continue;
    }

    const inspected = inspectConceptMarkdown(markdown);
    if (inspected.kind === "ordinary_markdown") {
      continue;
    }
    if (inspected.kind === "invalid_concept") {
      issues.push(Object.freeze({
        vaultPath: file.path,
        code: inspected.code,
        message: inspected.message
      }));
      continue;
    }

    records.push(Object.freeze({
      vaultPath: file.path,
      concept: inspected.persisted.conceptNode
    }));
  }

  return Object.freeze({
    index: createConceptIndex(records.map((record) => record.concept)),
    records: Object.freeze(records),
    issues: Object.freeze(issues),
    scannedMarkdownFiles: files.length
  });
}
