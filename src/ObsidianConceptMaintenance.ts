import type { App, TFile } from "obsidian";
import { validateExistingVaultMarkdownPath } from "./CandidateNoteVault";
import {
  inspectConceptMarkdown,
  type PersistedConceptNote
} from "./BrainGrowthPersistence";

export type ConceptMaintenanceLoadResult =
  | {
      readonly ok: true;
      readonly vaultPath: string;
      readonly file: TFile;
      readonly markdown: string;
      readonly persisted: PersistedConceptNote;
    }
  | {
      readonly ok: false;
      readonly error:
        | "Invalid concept note path"
        | "Concept note was not found"
        | "The selected note is not a ConceptNode"
        | "Concept metadata is invalid"
        | "Concept persistence version is unsupported"
        | "Concept note could not be read";
    };

export type ConceptMaintenanceWriteResult =
  | {
      readonly ok: true;
      readonly vaultPath: string;
      readonly revision: number;
    }
  | {
      readonly ok: false;
      readonly error:
        | "Invalid concept note path"
        | "Concept note was not found"
        | "Concept note could not be read"
        | "The selected note is not a ConceptNode"
        | "Concept metadata is invalid"
        | "Concept persistence version is unsupported"
        | "The concept changed. Reload and review the update again."
        | "Prepared concept update is invalid"
        | "Vault update failed";
    };

function inspectionError(
  code: "invalid_concept_metadata" | "unsupported_schema_version"
): "Concept metadata is invalid" |
  "Concept persistence version is unsupported" {
  return code === "unsupported_schema_version"
    ? "Concept persistence version is unsupported"
    : "Concept metadata is invalid";
}

/** Read exactly one Vault-relative concept note. This function never writes. */
export async function loadConceptForMaintenance(
  app: App,
  rawVaultPath: string
): Promise<ConceptMaintenanceLoadResult> {
  const vaultPath = validateExistingVaultMarkdownPath(rawVaultPath);
  if (vaultPath === null) {
    return Object.freeze({ ok: false, error: "Invalid concept note path" });
  }
  const file = app.vault.getFileByPath(vaultPath);
  if (file === null) {
    return Object.freeze({ ok: false, error: "Concept note was not found" });
  }
  let markdown: string;
  try {
    markdown = await app.vault.cachedRead(file);
  } catch {
    return Object.freeze({
      ok: false,
      error: "Concept note could not be read"
    });
  }
  const inspected = inspectConceptMarkdown(markdown);
  if (inspected.kind === "ordinary_markdown") {
    return Object.freeze({
      ok: false,
      error: "The selected note is not a ConceptNode"
    });
  }
  if (inspected.kind === "invalid_concept") {
    return Object.freeze({
      ok: false,
      error: inspectionError(inspected.code)
    });
  }
  return Object.freeze({
    ok: true,
    vaultPath,
    file,
    markdown,
    persisted: inspected.persisted
  });
}

/**
 * The sole new maintenance write boundary. It performs an exact-content and
 * revision check immediately before one explicit Vault.modify call.
 */
export async function persistConfirmedConceptUpdate(
  app: App,
  input: {
    readonly vaultPath: string;
    readonly conceptId: string;
    readonly expectedRevision: number;
    readonly expectedMarkdown: string;
    readonly preparedMarkdown: string;
  }
): Promise<ConceptMaintenanceWriteResult> {
  const loaded = await loadConceptForMaintenance(app, input.vaultPath);
  if (!loaded.ok) {
    return loaded;
  }
  const current = loaded.persisted.conceptNode;
  if (
    current.id !== input.conceptId ||
    current.revision !== input.expectedRevision ||
    loaded.markdown !== input.expectedMarkdown
  ) {
    return Object.freeze({
      ok: false,
      error: "The concept changed. Reload and review the update again."
    });
  }
  const prepared = inspectConceptMarkdown(input.preparedMarkdown);
  if (
    prepared.kind !== "concept_node" ||
    prepared.persisted.conceptNode.id !== input.conceptId ||
    prepared.persisted.conceptNode.revision !== input.expectedRevision + 1
  ) {
    return Object.freeze({
      ok: false,
      error: "Prepared concept update is invalid"
    });
  }
  try {
    await app.vault.modify(loaded.file, input.preparedMarkdown);
  } catch {
    return Object.freeze({ ok: false, error: "Vault update failed" });
  }
  return Object.freeze({
    ok: true,
    vaultPath: loaded.vaultPath,
    revision: prepared.persisted.conceptNode.revision
  });
}
