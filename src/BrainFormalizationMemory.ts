// ── Brain Formalization Memory ────────────────────────────────────────
// Durable, local semantic lineage for accepted Brain-aware formalizations.
//
// This is history: it preserves which Personal Brain concepts and exact
// revisions were used at acceptance.  The current Brain remains the current
// state; the memory is never rewritten when a concept later evolves.
// ────────────────────────────────────────────────────────────────────────

import {
  deserializePersonalSemanticIR,
  serializePersonalSemanticIR,
  type ConceptResolutionMethod,
  type PersonalSemanticIR
} from "./PersonalSemanticIR";
import {
  lookupConceptById,
  normalizeConceptLookupText,
  type ConceptIndex
} from "./BrainGrowthIndex";
import type { BrainFormalizationEvaluation } from "./BrainFormalizationWorkflow";
import type { VerificationStatus } from "./FormalizationProtocol";

export const BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION = 1 as const;

// ── Persisted Shape ────────────────────────────────────────────────────

export type PersistedReviewDecision =
  | "accepted"
  | "edited_then_accepted";

export interface PersistedConceptBinding {
  readonly surfacePhrase: string;
  readonly status: "resolved" | "unresolved" | "proposed_new";
  readonly conceptId?: string;
  readonly conceptRevision?: number;
  readonly resolutionMethod: ConceptResolutionMethod;
  readonly resolvedTitle?: string;
  readonly personalDefinitionSnapshot?: string;
  readonly standardDefinitionSnapshot?: string;
}

export interface PersistedLeanStatus {
  readonly statementStatus:
    | "not_checked"
    | "statement_typechecked"
    | "error";
  readonly proofStatus: "unverified" | "proof_verified";
}

export interface PersistedEvaluation {
  readonly resolvedConceptCount: number;
  readonly ambiguousConceptCount: number;
  readonly unresolvedConceptCount: number;
  readonly explicitAssumptionCount: number;
  readonly addedImplicitAssumptionCount: number;
  readonly semanticDiffCategories: readonly string[];
  readonly edited: boolean;
  readonly formalizationCreated: boolean;
  readonly leanTypecheckResult:
    | "not_checked"
    | "statement_typechecked"
    | "error";
  readonly leanProofResult: "unverified" | "proof_verified";
}

export interface PersistedBrainFormalization {
  readonly memoryId: string;
  readonly schemaVersion: typeof BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION;
  readonly irId: string;
  readonly recordId: string;
  readonly claimId: string;
  readonly sourceMessageId: string;
  readonly sourceSnapshot: string;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly reviewDecision: PersistedReviewDecision;
  readonly conceptBindings: readonly PersistedConceptBinding[];
  readonly semanticDiffCategories: readonly string[];
  readonly editedBeforeAcceptance: boolean;
  readonly ir: PersonalSemanticIR;
  readonly evaluation: PersistedEvaluation;
  readonly lean: PersistedLeanStatus;
}

export interface BrainFormalizationMemory {
  readonly schemaVersion: typeof BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION;
  readonly records: Readonly<Record<string, PersistedBrainFormalization>>;
}

export interface BrainFormalizationMemoryLoadResult {
  readonly memory: BrainFormalizationMemory;
  readonly diagnostics: readonly string[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== ""
  ).map((item) => item.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyMemory(
  diagnostics: string[] = []
): BrainFormalizationMemoryLoadResult {
  return {
    memory: { schemaVersion: BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION, records: {} },
    diagnostics
  };
}

// ── Binding Snapshot ───────────────────────────────────────────────────

function bindingsFromIR(
  ir: Readonly<PersonalSemanticIR>
): PersistedConceptBinding[] {
  return ir.conceptBindings.map((binding) => ({
    surfacePhrase: binding.surfacePhrase,
    status: binding.status === "resolved"
      ? "resolved" as const
      : binding.status === "proposed_new"
        ? "proposed_new" as const
        : "unresolved" as const,
    conceptId: binding.conceptId,
    conceptRevision: binding.conceptRevision,
    resolutionMethod: binding.resolutionMethod,
    resolvedTitle: binding.resolvedTitle,
    personalDefinitionSnapshot: binding.personalDefinition,
    standardDefinitionSnapshot: binding.standardDefinition
  }));
}

// ── Creation / Idempotent Upsert ───────────────────────────────────────

export interface AddBrainFormalizationInput {
  readonly ir: Readonly<PersonalSemanticIR>;
  readonly recordId: string;
  readonly claimId: string;
  readonly sourceMessageId: string;
  readonly acceptedAt: string;
  readonly edited: boolean;
  readonly evaluation: BrainFormalizationEvaluation;
}

export interface AddBrainFormalizationResult {
  readonly memory: BrainFormalizationMemory;
  readonly record: PersistedBrainFormalization;
  readonly created: boolean;
}

export function addBrainFormalization(
  memory: Readonly<BrainFormalizationMemory>,
  input: Readonly<AddBrainFormalizationInput>
): AddBrainFormalizationResult {
  // Replay-safe: a stable record ID or IR ID that already exists is returned
  // unchanged instead of creating a duplicate.
  for (const existing of Object.values(memory.records)) {
    if (existing.recordId === input.recordId || existing.irId === input.ir.id) {
      return { memory, record: existing, created: false };
    }
  }

  const memoryId = `bfm-${input.recordId}`;
  const now = input.acceptedAt;
  const record: PersistedBrainFormalization = {
    memoryId,
    schemaVersion: BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION,
    irId: input.ir.id,
    recordId: input.recordId,
    claimId: input.claimId,
    sourceMessageId: input.sourceMessageId,
    sourceSnapshot: input.ir.source.snapshot,
    acceptedAt: now,
    updatedAt: now,
    reviewDecision: input.edited ? "edited_then_accepted" : "accepted",
    conceptBindings: bindingsFromIR(input.ir),
    semanticDiffCategories: input.evaluation.semanticDiffCategories,
    editedBeforeAcceptance: input.edited,
    ir: input.ir,
    evaluation: {
      resolvedConceptCount: input.evaluation.resolvedConceptCount,
      ambiguousConceptCount: input.evaluation.ambiguousConceptCount,
      unresolvedConceptCount: input.evaluation.unresolvedConceptCount,
      explicitAssumptionCount: input.evaluation.explicitAssumptionCount,
      addedImplicitAssumptionCount:
        input.evaluation.addedImplicitAssumptionCount,
      semanticDiffCategories: input.evaluation.semanticDiffCategories,
      edited: input.evaluation.edited,
      formalizationCreated: input.evaluation.formalizationCreated,
      leanTypecheckResult: input.evaluation.leanTypecheckResult,
      leanProofResult: input.evaluation.leanProofResult
    },
    lean: {
      statementStatus: "not_checked",
      proofStatus: "unverified"
    }
  };

  return {
    memory: {
      schemaVersion: BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION,
      records: { ...memory.records, [memoryId]: record }
    },
    record,
    created: true
  };
}

// ── Serialization ──────────────────────────────────────────────────────

export function serializeBrainFormalizationMemory(
  memory: Readonly<BrainFormalizationMemory>
): unknown {
  const records: Record<string, unknown> = {};
  for (const [key, record] of Object.entries(memory.records)) {
    records[key] = {
      memoryId: record.memoryId,
      schemaVersion: record.schemaVersion,
      irId: record.irId,
      recordId: record.recordId,
      claimId: record.claimId,
      sourceMessageId: record.sourceMessageId,
      sourceSnapshot: record.sourceSnapshot,
      acceptedAt: record.acceptedAt,
      updatedAt: record.updatedAt,
      reviewDecision: record.reviewDecision,
      conceptBindings: record.conceptBindings.map((binding) => ({ ...binding })),
      semanticDiffCategories: [...record.semanticDiffCategories],
      editedBeforeAcceptance: record.editedBeforeAcceptance,
      ir: serializePersonalSemanticIR(record.ir),
      evaluation: { ...record.evaluation },
      lean: { ...record.lean }
    };
  }
  return {
    schemaVersion: memory.schemaVersion,
    records
  };
}

function parsePersistedRecord(
  memoryId: string,
  value: unknown
): { record: PersistedBrainFormalization } | { error: string } {
  if (!isRecord(value)) {
    return { error: `Record ${memoryId} is not an object.` };
  }

  const irResult = deserializePersonalSemanticIR(value.ir);
  if (!irResult.ok) {
    return { error: `Record ${memoryId}: ${irResult.error}` };
  }

  const recordId = nonEmpty(value.recordId);
  const irId = nonEmpty(value.irId);
  const claimId = nonEmpty(value.claimId);
  const sourceMessageId = nonEmpty(value.sourceMessageId);
  const sourceSnapshot = nonEmpty(value.sourceSnapshot);
  if (
    recordId === "" ||
    irId === "" ||
    claimId === "" ||
    sourceMessageId === "" ||
    sourceSnapshot === ""
  ) {
    return { error: `Record ${memoryId} is missing required IDs.` };
  }

  const rawBindings = Array.isArray(value.conceptBindings)
    ? value.conceptBindings
    : [];
  const conceptBindings: PersistedConceptBinding[] = [];
  for (const raw of rawBindings) {
    if (!isRecord(raw)) {
      continue;
    }
    const status = nonEmpty(raw.status);
    if (
      status !== "resolved" &&
      status !== "unresolved" &&
      status !== "proposed_new"
    ) {
      continue;
    }
    const resolutionMethod = nonEmpty(raw.resolutionMethod);
    if (resolutionMethod === "") {
      continue;
    }
    conceptBindings.push({
      surfacePhrase: nonEmpty(raw.surfacePhrase),
      status,
      conceptId: typeof raw.conceptId === "string" && raw.conceptId !== ""
        ? raw.conceptId
        : undefined,
      conceptRevision:
        typeof raw.conceptRevision === "number" &&
        Number.isInteger(raw.conceptRevision) &&
        raw.conceptRevision >= 1
          ? raw.conceptRevision
          : undefined,
      resolutionMethod: resolutionMethod as ConceptResolutionMethod,
      resolvedTitle: typeof raw.resolvedTitle === "string"
        ? raw.resolvedTitle
        : undefined,
      personalDefinitionSnapshot:
        typeof raw.personalDefinitionSnapshot === "string"
          ? raw.personalDefinitionSnapshot
          : undefined,
      standardDefinitionSnapshot:
        typeof raw.standardDefinitionSnapshot === "string"
          ? raw.standardDefinitionSnapshot
          : undefined
    });
  }

  const rawEvaluation = isRecord(value.evaluation) ? value.evaluation : {};
  const evaluation: PersistedEvaluation = {
    resolvedConceptCount: typeof rawEvaluation.resolvedConceptCount === "number"
      ? rawEvaluation.resolvedConceptCount
      : 0,
    ambiguousConceptCount: typeof rawEvaluation.ambiguousConceptCount === "number"
      ? rawEvaluation.ambiguousConceptCount
      : 0,
    unresolvedConceptCount:
      typeof rawEvaluation.unresolvedConceptCount === "number"
        ? rawEvaluation.unresolvedConceptCount
        : 0,
    explicitAssumptionCount:
      typeof rawEvaluation.explicitAssumptionCount === "number"
        ? rawEvaluation.explicitAssumptionCount
        : 0,
    addedImplicitAssumptionCount:
      typeof rawEvaluation.addedImplicitAssumptionCount === "number"
        ? rawEvaluation.addedImplicitAssumptionCount
        : 0,
    semanticDiffCategories: asStringArray(rawEvaluation.semanticDiffCategories),
    edited: rawEvaluation.edited === true,
    formalizationCreated: rawEvaluation.formalizationCreated === true,
    leanTypecheckResult: rawEvaluation.leanTypecheckResult === "statement_typechecked" ||
      rawEvaluation.leanTypecheckResult === "error"
      ? rawEvaluation.leanTypecheckResult
      : "not_checked",
    leanProofResult: rawEvaluation.leanProofResult === "proof_verified"
      ? "proof_verified"
      : "unverified"
  };

  const rawLean = isRecord(value.lean) ? value.lean : {};
  const lean: PersistedLeanStatus = {
    statementStatus: rawLean.statementStatus === "statement_typechecked" ||
      rawLean.statementStatus === "error"
      ? rawLean.statementStatus
      : "not_checked",
    proofStatus: rawLean.proofStatus === "proof_verified"
      ? "proof_verified"
      : "unverified"
  };

  const reviewDecision = value.reviewDecision === "edited_then_accepted"
    ? "edited_then_accepted"
    : "accepted";

  return {
    record: {
      memoryId,
      schemaVersion: BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION,
      irId,
      recordId,
      claimId,
      sourceMessageId,
      sourceSnapshot,
      acceptedAt: typeof value.acceptedAt === "string"
        ? value.acceptedAt
        : "",
      updatedAt: typeof value.updatedAt === "string"
        ? value.updatedAt
        : "",
      reviewDecision,
      conceptBindings,
      semanticDiffCategories: asStringArray(value.semanticDiffCategories),
      editedBeforeAcceptance: value.editedBeforeAcceptance === true,
      ir: irResult.ir,
      evaluation,
      lean
    }
  };
}

export function deserializeBrainFormalizationMemory(
  value: unknown
): BrainFormalizationMemoryLoadResult {
  if (!isRecord(value)) {
    return emptyMemory(["Brain formalization memory must be an object."]);
  }
  if (value.schemaVersion !== BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION) {
    return emptyMemory([
      `Unsupported Brain formalization memory schema ` +
      `${String(value.schemaVersion)}.`
    ]);
  }
  if (!isRecord(value.records)) {
    return emptyMemory(["Brain formalization memory records are missing."]);
  }

  const records: Record<string, PersistedBrainFormalization> = {};
  const diagnostics: string[] = [];
  const seenRecordIds = new Set<string>();
  const seenIRIds = new Set<string>();

  for (const [memoryId, raw] of Object.entries(value.records)) {
    const parsed = parsePersistedRecord(memoryId, raw);
    if ("error" in parsed) {
      diagnostics.push(parsed.error);
      continue;
    }
    const record = parsed.record;
    if (seenRecordIds.has(record.recordId) || seenIRIds.has(record.irId)) {
      diagnostics.push(`Duplicate linkage detected for ${memoryId}.`);
      continue;
    }
    seenRecordIds.add(record.recordId);
    seenIRIds.add(record.irId);
    records[memoryId] = record;
  }

  return {
    memory: { schemaVersion: BRAIN_FORMALIZATION_MEMORY_SCHEMA_VERSION, records },
    diagnostics
  };
}

// ── Query API ──────────────────────────────────────────────────────────

export function getMemoryByRecordId(
  memory: Readonly<BrainFormalizationMemory>,
  recordId: string
): PersistedBrainFormalization | undefined {
  return Object.values(memory.records).find(
    (record) => record.recordId === recordId
  );
}

export function getMemoryByIRId(
  memory: Readonly<BrainFormalizationMemory>,
  irId: string
): PersistedBrainFormalization | undefined {
  return Object.values(memory.records).find(
    (record) => record.irId === irId
  );
}

export function listConceptBindingsForRecord(
  memory: Readonly<BrainFormalizationMemory>,
  recordId: string
): readonly PersistedConceptBinding[] {
  return getMemoryByRecordId(memory, recordId)?.conceptBindings ?? [];
}

export function listFormalizationsReferencingConcept(
  memory: Readonly<BrainFormalizationMemory>,
  conceptId: string
): readonly PersistedBrainFormalization[] {
  return Object.values(memory.records).filter((record) =>
    record.conceptBindings.some((binding) => binding.conceptId === conceptId)
  );
}

// ── Lean Status Evolution ──────────────────────────────────────────────

export interface UpdateBrainFormalizationLeanInput {
  readonly statementStatus?:
    | "not_checked"
    | "statement_typechecked"
    | "error";
  readonly proofStatus?: "unverified" | "proof_verified";
}

export function updateBrainFormalizationLeanStatus(
  memory: Readonly<BrainFormalizationMemory>,
  recordId: string,
  patch: Readonly<UpdateBrainFormalizationLeanInput>
): {
  readonly memory: BrainFormalizationMemory;
  readonly record?: PersistedBrainFormalization;
  readonly updated: boolean;
} {
  const existing = getMemoryByRecordId(memory, recordId);
  if (existing === undefined) {
    return { memory, updated: false };
  }
  const nextStatementStatus =
    patch.statementStatus ?? existing.lean.statementStatus;
  const nextProofStatus = patch.proofStatus ?? existing.lean.proofStatus;

  // Replay-safe no-op: identical authoritative state does not churn memory.
  if (
    existing.lean.statementStatus === nextStatementStatus &&
    existing.lean.proofStatus === nextProofStatus
  ) {
    return { memory, record: existing, updated: false };
  }

  const next: PersistedBrainFormalization = {
    ...existing,
    updatedAt: new Date().toISOString(),
    lean: {
      statementStatus: nextStatementStatus,
      proofStatus: nextProofStatus
    },
    evaluation: {
      ...existing.evaluation,
      leanTypecheckResult: nextStatementStatus,
      leanProofResult: nextProofStatus
    }
  };
  return {
    memory: {
      schemaVersion: memory.schemaVersion,
      records: { ...memory.records, [existing.memoryId]: next }
    },
    record: next,
    updated: true
  };
}

/**
 * Mirror already-authoritative FormalizationProtocol verification state into
 * durable semantic memory.  This function never interprets Lean output and
 * never creates verification authority; it only records what existing code
 * has already established.
 */
export function synchronizeBrainFormalizationStatus(
  memory: Readonly<BrainFormalizationMemory>,
  recordId: string,
  verificationStatus: VerificationStatus
): {
  readonly memory: BrainFormalizationMemory;
  readonly record?: PersistedBrainFormalization;
  readonly updated: boolean;
} {
  const existing = getMemoryByRecordId(memory, recordId);
  const proofWasVerified =
    existing?.lean.proofStatus === "proof_verified";

  switch (verificationStatus) {
    case "not_checked":
      return updateBrainFormalizationLeanStatus(memory, recordId, {
        statementStatus: "not_checked",
        // Editing reviewed code deliberately resets the authoritative record,
        // so the memory mirror resets with it.
        proofStatus: "unverified"
      });
    case "statement_typechecked":
      return updateBrainFormalizationLeanStatus(memory, recordId, {
        statementStatus: "statement_typechecked",
        proofStatus: proofWasVerified ? "proof_verified" : "unverified"
      });
    case "proof_verified":
      return updateBrainFormalizationLeanStatus(memory, recordId, {
        statementStatus: "statement_typechecked",
        proofStatus: "proof_verified"
      });
    case "counterexample_verified":
      // Counterexample verification is authoritative disproof, not a Lean
      // elaboration error.  It is preserved distinctly by the existing
      // FormalizationProtocol status even though no Lean check status field
      // currently names it.
      return updateBrainFormalizationLeanStatus(memory, recordId, {
        statementStatus: "error",
        proofStatus: proofWasVerified ? "proof_verified" : "unverified"
      });
    case "error":
      return updateBrainFormalizationLeanStatus(memory, recordId, {
        statementStatus: "error",
        proofStatus: proofWasVerified ? "proof_verified" : "unverified"
      });
  }
}

// ── Current vs Historical Comparison ───────────────────────────────────

export type ConceptFreshnessStatus =
  | "unchanged"
  | "revision_changed"
  | "renamed_only"
  | "missing"
  | "definition_changed"
  | "revision_unavailable";

export interface ConceptFreshness {
  readonly conceptId: string;
  readonly status: ConceptFreshnessStatus;
  readonly historicalRevision?: number;
  readonly currentRevision?: number;
  readonly historicalTitle?: string;
  readonly currentTitle?: string;
  readonly historicalDefinition?: string;
  readonly currentDefinition?: string;
}

export function compareBrainFormalizationConcepts(
  record: Readonly<PersistedBrainFormalization>,
  currentIndex: Readonly<ConceptIndex>
): readonly ConceptFreshness[] {
  const result: ConceptFreshness[] = [];
  for (const binding of record.conceptBindings) {
    if (binding.conceptId === undefined) {
      continue;
    }
    const lookup = lookupConceptById(currentIndex, binding.conceptId);
    if (lookup.kind !== "unique_match") {
      result.push({
        conceptId: binding.conceptId,
        status: "missing",
        historicalRevision: binding.conceptRevision,
        historicalTitle: binding.resolvedTitle,
        historicalDefinition: binding.personalDefinitionSnapshot
      });
      continue;
    }

    const current = lookup.match.concept;
    const historicalRevision = binding.conceptRevision;
    if (historicalRevision === undefined) {
      result.push({
        conceptId: binding.conceptId,
        status: "revision_unavailable",
        currentRevision: current.revision,
        currentTitle: current.title,
        currentDefinition: current.userDefinition?.text
      });
      continue;
    }

    const historicalDefinition = binding.personalDefinitionSnapshot;
    const currentDefinition = current.userDefinition?.text;
    const definitionsEqual =
      historicalDefinition !== undefined &&
      currentDefinition !== undefined &&
      normalizeConceptLookupText(historicalDefinition) ===
        normalizeConceptLookupText(currentDefinition);
    const sameRevision = historicalRevision === current.revision;

    let status: ConceptFreshnessStatus;
    if (sameRevision) {
      status = "unchanged";
    } else if (definitionsEqual) {
      status = "renamed_only";
    } else if (
      historicalDefinition !== undefined &&
      currentDefinition !== undefined &&
      normalizeConceptLookupText(historicalDefinition) !==
        normalizeConceptLookupText(currentDefinition)
    ) {
      status = "definition_changed";
    } else {
      status = "revision_changed";
    }

    result.push({
      conceptId: binding.conceptId,
      status,
      historicalRevision,
      currentRevision: current.revision,
      historicalTitle: binding.resolvedTitle,
      currentTitle: current.title,
      historicalDefinition,
      currentDefinition
    });
  }
  return result;
}

export type SemanticStalenessStatus =
  | "current"
  | "changed"
  | "partially_missing"
  | "unavailable";

export function deriveSemanticStaleness(
  freshness: readonly ConceptFreshness[]
): SemanticStalenessStatus {
  if (freshness.length === 0) {
    return "current";
  }
  const missing = freshness.some((item) => item.status === "missing");
  const allMissing = freshness.every((item) => item.status === "missing");
  const changed = freshness.some(
    (item) =>
      item.status === "revision_changed" ||
      item.status === "definition_changed"
  );
  if (allMissing) {
    return "unavailable";
  }
  if (missing) {
    return "partially_missing";
  }
  if (changed) {
    return "changed";
  }
  return "current";
}
