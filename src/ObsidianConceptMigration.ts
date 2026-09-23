import type { App, TFile } from "obsidian";
import {
  findConceptMigrationLabelCollisions,
  hashConceptMigrationSourceMarkdown,
  prepareConceptMigration,
  type PreparedConceptMigration
} from "./BrainMigration";
import { lookupConceptById } from "./BrainGrowthIndex";
import {
  inspectConceptMarkdown,
  serializeConceptNodeIntoMarkdown
} from "./BrainGrowthPersistence";
import { validateExistingVaultMarkdownPath } from "./CandidateNoteVault";
import {
  loadObsidianConceptIndex,
  type ObsidianConceptIndexResult
} from "./ObsidianConceptIndex";

const confirmationTails = new WeakMap<App, Promise<void>>();

export interface ConceptMigrationConfirmation {
  readonly kind: "confirmed_concept_migration";
  readonly confirmedAt: string;
  readonly migrationId: string;
  readonly sourceVaultPath: string;
  readonly conceptId: string;
}

export type ConceptMigrationLoadFailureCode =
  | "invalid_source_path"
  | "source_not_found"
  | "source_read_failed"
  | "source_path_changed"
  | "source_not_ordinary"
  | "source_invalid_concept_metadata"
  | "source_unsupported_schema_version";

export type ConceptMigrationLoadResult =
  | {
      readonly ok: true;
      readonly vaultPath: string;
      readonly file: TFile;
      readonly markdown: string;
    }
  | {
      readonly ok: false;
      readonly code: ConceptMigrationLoadFailureCode;
      readonly error: string;
    };

export interface ConceptMigrationLoadOptions {
  /** Bypass Obsidian's cache when the result guards a Vault modification. */
  readonly freshRead?: boolean;
}

export type ConceptMigrationWriteFailureCode =
  | ConceptMigrationLoadFailureCode
  | "approval_required"
  | "stale_source"
  | "identity_check_incomplete"
  | "identity_check_changed"
  | "conflicting_identity"
  | "label_collisions_changed"
  | "invalid_prepared_projection"
  | "vault_update_failed";

export type ConceptMigrationWriteResult =
  | {
      readonly ok: true;
      readonly vaultPath: string;
      readonly conceptId: string;
      readonly revision: number;
    }
  | {
      readonly ok: false;
      readonly code: ConceptMigrationWriteFailureCode;
      readonly error: string;
    };

function loadFailure(
  code: ConceptMigrationLoadFailureCode,
  error: string
): Extract<ConceptMigrationLoadResult, { ok: false }> {
  return Object.freeze({ ok: false, code, error });
}

function writeFailure(
  code: ConceptMigrationWriteFailureCode,
  error: string
): Extract<ConceptMigrationWriteResult, { ok: false }> {
  return Object.freeze({ ok: false, code, error });
}

/** Read exactly one explicitly selected ordinary Markdown note. Never writes. */
export async function loadOrdinaryNoteForMigration(
  app: App,
  rawVaultPath: string,
  options: Readonly<ConceptMigrationLoadOptions> = {}
): Promise<ConceptMigrationLoadResult> {
  const vaultPath = validateExistingVaultMarkdownPath(rawVaultPath);
  if (vaultPath === null) {
    return loadFailure("invalid_source_path", "Invalid migration note path");
  }
  const file = app.vault.getFileByPath(vaultPath);
  if (file === null) {
    return loadFailure("source_not_found", "Migration note was not found");
  }

  let markdown: string;
  try {
    markdown = options.freshRead === true
      ? await app.vault.read(file)
      : await app.vault.cachedRead(file);
  } catch {
    return loadFailure("source_read_failed", "Migration note could not be read");
  }
  if (
    file.path !== vaultPath ||
    app.vault.getFileByPath(vaultPath) !== file
  ) {
    return loadFailure(
      "source_path_changed",
      "Migration note path changed while it was being read"
    );
  }

  const inspected = inspectConceptMarkdown(markdown);
  if (inspected.kind === "concept_node") {
    return loadFailure(
      "source_not_ordinary",
      "The selected note is already a ConceptNode"
    );
  }
  if (inspected.kind === "invalid_concept") {
    return inspected.code === "unsupported_schema_version"
      ? loadFailure(
          "source_unsupported_schema_version",
          "The selected note uses an unsupported concept persistence version"
        )
      : loadFailure(
          "source_invalid_concept_metadata",
          "The selected note has invalid concept metadata"
        );
  }

  return Object.freeze({ ok: true, vaultPath, file, markdown });
}

function isMatchingConfirmation(
  prepared: Readonly<PreparedConceptMigration>,
  confirmation: Readonly<ConceptMigrationConfirmation>
): boolean {
  return confirmation.kind === "confirmed_concept_migration" &&
    typeof confirmation.confirmedAt === "string" &&
    confirmation.confirmedAt.trim() !== "" &&
    confirmation.migrationId === prepared.migrationId &&
    confirmation.sourceVaultPath === prepared.sourceVaultPath &&
    confirmation.conceptId === prepared.concept.id;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) ===
    JSON.stringify(canonicalize(right));
}

function immutableSnapshot<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((child) =>
      immutableSnapshot(child)
    )) as T;
  }
  const snapshot: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(
    value as Record<string, unknown>
  )) {
    snapshot[key] = immutableSnapshot(child);
  }
  return Object.freeze(snapshot) as T;
}

function identityIndexSnapshot(
  discovered: Readonly<ObsidianConceptIndexResult>
): unknown {
  return {
    scannedMarkdownFiles: discovered.scannedMarkdownFiles,
    records: discovered.records.map((record) => ({
      vaultPath: record.vaultPath,
      concept: record.concept
    })),
    issues: discovered.issues
  };
}

async function withMigrationConfirmationLock<T>(
  app: App,
  operation: () => Promise<T>
): Promise<T> {
  const previous = confirmationTails.get(app) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  confirmationTails.set(app, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (confirmationTails.get(app) === tail) {
      confirmationTails.delete(app);
    }
  }
}

function hasValidPreparedProjection(
  prepared: Readonly<PreparedConceptMigration>
): boolean {
  if (
    prepared.origin.kind !== "ordinary_markdown_migration" ||
    prepared.origin.sourceVaultPath !== prepared.sourceVaultPath ||
    prepared.origin.sourceMarkdownHash !==
      hashConceptMigrationSourceMarkdown(prepared.sourceMarkdown) ||
    prepared.origin.preparedAt !== prepared.concept.createdAt ||
    prepared.concept.createdAt !== prepared.concept.updatedAt ||
    prepared.concept.revision !== 1 ||
    prepared.concept.history.length !== 0
  ) {
    return false;
  }
  const inspected = inspectConceptMarkdown(prepared.markdown);
  if (inspected.kind !== "concept_node") {
    return false;
  }
  const rebuilt = prepareConceptMigration({
    sourceVaultPath: prepared.sourceVaultPath,
    sourceMarkdown: prepared.sourceMarkdown,
    draft: prepared.draft,
    knownConcepts: prepared.labelCollisions.map((collision) => ({
      id: collision.conceptId,
      title: collision.title,
      aliases: collision.matchedLabels
    })),
    preparedAt: prepared.origin.preparedAt
  });
  if (rebuilt.kind !== "prepared") {
    return false;
  }
  const expectedMarkdown = serializeConceptNodeIntoMarkdown(
    prepared.sourceMarkdown,
    prepared.concept,
    prepared.origin
  );
  return prepared.markdown === expectedMarkdown &&
    prepared.migrationId === rebuilt.migrationId &&
    structurallyEqual(prepared.draft, rebuilt.draft) &&
    structurallyEqual(prepared.mapping, rebuilt.mapping) &&
    structurallyEqual(prepared.diff, rebuilt.diff) &&
    structurallyEqual(prepared.concept, rebuilt.concept) &&
    structurallyEqual(prepared.origin, rebuilt.origin) &&
    prepared.markdown === rebuilt.markdown &&
    structurallyEqual(inspected.persisted.conceptNode, prepared.concept) &&
    structurallyEqual(inspected.persisted.origin, prepared.origin);
}

/**
 * The sole ordinary-note migration write boundary. Every reviewed invariant is
 * rechecked immediately before exactly one Vault modification.
 */
export async function persistConfirmedConceptMigration(
  app: App,
  input: {
    readonly prepared: PreparedConceptMigration;
    readonly confirmation: ConceptMigrationConfirmation;
  }
): Promise<ConceptMigrationWriteResult> {
  let snapshot: typeof input;
  try {
    snapshot = immutableSnapshot(input);
  } catch {
    return writeFailure(
      "invalid_prepared_projection",
      "Prepared concept migration is invalid"
    );
  }
  return withMigrationConfirmationLock(app, () =>
    persistConfirmedConceptMigrationUnlocked(app, snapshot)
  );
}

async function persistConfirmedConceptMigrationUnlocked(
  app: App,
  input: {
    readonly prepared: PreparedConceptMigration;
    readonly confirmation: ConceptMigrationConfirmation;
  }
): Promise<ConceptMigrationWriteResult> {
  const { prepared, confirmation } = input;
  const validatedPath = validateExistingVaultMarkdownPath(
    prepared.sourceVaultPath
  );
  if (
    validatedPath === null ||
    validatedPath !== prepared.sourceVaultPath
  ) {
    return writeFailure("invalid_source_path", "Invalid migration note path");
  }
  let confirmationMatches = false;
  try {
    confirmationMatches = isMatchingConfirmation(prepared, confirmation);
  } catch {
    confirmationMatches = false;
  }
  if (!confirmationMatches) {
    return writeFailure(
      "approval_required",
      "Explicit confirmation of this reviewed migration is required"
    );
  }
  let preparedProjectionIsValid = false;
  try {
    preparedProjectionIsValid = hasValidPreparedProjection(prepared);
  } catch {
    preparedProjectionIsValid = false;
  }
  if (!preparedProjectionIsValid) {
    return writeFailure(
      "invalid_prepared_projection",
      "Prepared concept migration is invalid"
    );
  }

  const loaded = await loadOrdinaryNoteForMigration(
    app,
    prepared.sourceVaultPath,
    { freshRead: true }
  );
  if (!loaded.ok) {
    return loaded;
  }
  if (loaded.markdown !== prepared.sourceMarkdown) {
    return writeFailure(
      "stale_source",
      "The source note changed. Reload and review the migration again."
    );
  }

  let discovered: ObsidianConceptIndexResult;
  try {
    discovered = await loadObsidianConceptIndex(app, { freshRead: true });
  } catch {
    return writeFailure(
      "identity_check_incomplete",
      "Concept identity could not be checked completely; no migration was written"
    );
  }
  if (discovered.issues.length > 0) {
    return writeFailure(
      "identity_check_incomplete",
      "Concept identity could not be checked completely; no migration was written"
    );
  }
  if (
    lookupConceptById(discovered.index, prepared.concept.id).kind !==
      "not_found"
  ) {
    return writeFailure(
      "conflicting_identity",
      "A ConceptNode with this stable ID already exists"
    );
  }
  const currentLabelCollisions = findConceptMigrationLabelCollisions(
    prepared.concept,
    discovered.index.concepts
  );
  if (!structurallyEqual(currentLabelCollisions, prepared.labelCollisions)) {
    return writeFailure(
      "label_collisions_changed",
      "Concept label collisions changed. Reload and review the migration again."
    );
  }

  const finalLoaded = await loadOrdinaryNoteForMigration(
    app,
    prepared.sourceVaultPath,
    { freshRead: true }
  );
  if (!finalLoaded.ok) {
    return finalLoaded;
  }
  if (finalLoaded.markdown !== prepared.sourceMarkdown) {
    return writeFailure(
      "stale_source",
      "The source note changed. Reload and review the migration again."
    );
  }

  let confirmedIndex: ObsidianConceptIndexResult;
  try {
    confirmedIndex = await loadObsidianConceptIndex(app, { freshRead: true });
  } catch {
    return writeFailure(
      "identity_check_incomplete",
      "Concept identity could not be checked completely; no migration was written"
    );
  }
  if (confirmedIndex.issues.length > 0) {
    return writeFailure(
      "identity_check_incomplete",
      "Concept identity could not be checked completely; no migration was written"
    );
  }
  if (
    lookupConceptById(confirmedIndex.index, prepared.concept.id).kind !==
      "not_found"
  ) {
    return writeFailure(
      "conflicting_identity",
      "A ConceptNode with this stable ID already exists"
    );
  }
  const confirmedLabelCollisions = findConceptMigrationLabelCollisions(
    prepared.concept,
    confirmedIndex.index.concepts
  );
  if (!structurallyEqual(confirmedLabelCollisions, prepared.labelCollisions)) {
    return writeFailure(
      "label_collisions_changed",
      "Concept label collisions changed. Reload and review the migration again."
    );
  }
  if (!structurallyEqual(
    identityIndexSnapshot(discovered),
    identityIndexSnapshot(confirmedIndex)
  )) {
    return writeFailure(
      "identity_check_changed",
      "The concept index changed during confirmation. Review the migration again."
    );
  }

  const writeLoaded = await loadOrdinaryNoteForMigration(
    app,
    prepared.sourceVaultPath,
    { freshRead: true }
  );
  if (!writeLoaded.ok) {
    return writeLoaded;
  }
  if (writeLoaded.markdown !== prepared.sourceMarkdown) {
    return writeFailure(
      "stale_source",
      "The source note changed. Reload and review the migration again."
    );
  }

  try {
    await app.vault.modify(writeLoaded.file, prepared.markdown);
  } catch {
    return writeFailure("vault_update_failed", "Vault migration update failed");
  }

  return Object.freeze({
    ok: true,
    vaultPath: loaded.vaultPath,
    conceptId: prepared.concept.id,
    revision: prepared.concept.revision
  });
}
