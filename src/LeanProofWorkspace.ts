// ── Lean Proof Workspace ──────────────────────────────────────────────
// First-class, durable proof-work state:
//   - LeanFormalizationTarget: the canonical proposition (source of truth)
//   - LeanProofDraft: local, reloadable proof-body working state
//   - LeanProofVerificationArtifact: immutable formal verification evidence
//
// This module is downstream of accepted semantics.  It never mutates the
// Personal Brain and never interprets Lean output into verification truth.
// ────────────────────────────────────────────────────────────────────────

import {
  hashLeanStatement,
  type LeanProofProvenance
} from "./LeanProofVerification";
import {
  compareBrainFormalizationConcepts,
  deriveSemanticStaleness,
  getMemoryByRecordId,
  type PersistedBrainFormalization,
  type SemanticStalenessStatus
} from "./BrainFormalizationMemory";
import type { ConceptIndex } from "./BrainGrowthIndex";

export const LEAN_PROOF_WORKSPACE_SCHEMA_VERSION = 1 as const;

export type LeanTargetProvenance =
  | "structured_generation"
  | "generated"
  | "migrated_legacy"
  | "user_edited";

export type LeanProofArtifactResult =
  | "verified"
  | "lean_error"
  | "timeout"
  | "environment_error"
  | "placeholder_rejected"
  | "invalid_candidate"
  | "stale_candidate"
  | "statement_mismatch";

// ── Canonical Target ───────────────────────────────────────────────────

export interface LeanFormalizationTarget {
  readonly id: string;
  readonly formalizationId: string;
  readonly irId?: string;
  readonly propositionText: string;
  readonly imports: readonly string[];
  readonly propositionHash: string;
  readonly provenance: LeanTargetProvenance;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateLeanFormalizationTargetInput {
  readonly id?: string;
  readonly formalizationId: string;
  readonly irId?: string;
  readonly propositionText: string;
  readonly imports?: readonly string[];
  readonly provenance?: LeanTargetProvenance;
  readonly createdAt?: string;
}

// ── Draft ──────────────────────────────────────────────────────────────

export interface LeanProofDraft {
  readonly id: string;
  readonly formalizationId: string;
  readonly irId?: string;
  readonly targetId: string;
  readonly targetHash: string;
  readonly proofBody: string;
  readonly proofHash: string;
  readonly provenance: LeanProofProvenance;
  readonly edited: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateLeanProofDraftInput {
  readonly id?: string;
  readonly formalizationId: string;
  readonly irId?: string;
  readonly targetId: string;
  readonly targetHash: string;
  readonly proofBody: string;
  readonly provenance?: LeanProofProvenance;
  readonly edited?: boolean;
  readonly createdAt?: string;
}

// ── Verification Artifact ──────────────────────────────────────────────

export interface LeanProofVerificationArtifact {
  readonly id: string;
  readonly formalizationId: string;
  readonly irId?: string;
  readonly targetId: string;
  readonly targetHash: string;
  readonly proofCandidateId: string;
  readonly proofHash: string;
  readonly proofProvenance: LeanProofProvenance;
  readonly theoremName: string;
  readonly imports: readonly string[];
  readonly result: LeanProofArtifactResult;
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly executedAt: string;
  readonly diagnostics: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateLeanProofArtifactInput {
  readonly id?: string;
  readonly formalizationId: string;
  readonly irId?: string;
  readonly targetId: string;
  readonly targetHash: string;
  readonly proofCandidateId: string;
  readonly proofHash: string;
  readonly proofProvenance: LeanProofProvenance;
  readonly theoremName: string;
  readonly imports: readonly string[];
  readonly result: LeanProofArtifactResult;
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly executedAt: string;
  readonly diagnostics?: readonly string[];
  readonly createdAt?: string;
}

export interface LeanProofWorkspaceState {
  readonly schemaVersion: typeof LEAN_PROOF_WORKSPACE_SCHEMA_VERSION;
  readonly targets: Readonly<Record<string, LeanFormalizationTarget>>;
  readonly drafts: Readonly<Record<string, LeanProofDraft>>;
  readonly artifacts: Readonly<Record<string, LeanProofVerificationArtifact>>;
}

export function emptyLeanProofWorkspace(): LeanProofWorkspaceState {
  return {
    schemaVersion: LEAN_PROOF_WORKSPACE_SCHEMA_VERSION,
    targets: {},
    drafts: {},
    artifacts: {}
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function generateId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? fallbackId();
  } catch {
    return fallbackId();
  }
}

function fallbackId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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

// ── Constructors ───────────────────────────────────────────────────────

export function createLeanFormalizationTarget(
  input: Readonly<CreateLeanFormalizationTargetInput>
): LeanFormalizationTarget {
  const formalizationId = nonEmpty(input.formalizationId);
  const propositionText = nonEmpty(input.propositionText);
  if (formalizationId === "" || propositionText === "") {
    throw new Error(
      "formalizationId and propositionText must be non-empty."
    );
  }
  const imports = [...(input.imports ?? [])];
  const now = input.createdAt ?? new Date().toISOString();
  return {
    id: nonEmpty(input.id) || generateId(),
    formalizationId,
    irId: input.irId,
    propositionText,
    imports,
    propositionHash: hashLeanStatement(propositionText, imports),
    provenance: input.provenance ?? "generated",
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Boundary hygiene for the structured DeepSeek proposition.  This is NOT
 * Lean validation; it only rejects presentation/declaration wrappers so the
 * canonical target stores a proposition, not a `#check` or theorem string.
 */
export function validateCanonicalLeanProposition(
  value: string
): readonly string[] {
  const issues: string[] = [];
  const trimmed = value.trim();
  if (trimmed === "") {
    issues.push("Proposition must be non-empty.");
  }
  if (trimmed.includes("```")) {
    issues.push("Proposition must not contain Markdown fences.");
  }
  if (/#check\b/.test(trimmed)) {
    issues.push("Proposition must not contain a #check wrapper.");
  }
  if (/\b(sorry|admit|sorryAx)\b/.test(trimmed)) {
    issues.push("Proposition must not contain placeholder syntax.");
  }

  const topLevelPrefix =
    /^(?:theorem|lemma|example|axiom|import|set_option|open|namespace|section|universe)\b/;
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (candidate === "" || candidate.startsWith("--")) {
      continue;
    }
    if (topLevelPrefix.test(candidate)) {
      issues.push(
        `Proposition contains a top-level declaration: "${candidate}".`
      );
    }
  }
  return issues;
}

/**
 * Construct the executable `#check` source from the canonical proposition.
 * The proposition is the source of truth; the source is only a projection.
 */
export function buildLeanStatementCheckSource(
  target: Readonly<LeanFormalizationTarget>
): string {
  const importLines = target.imports
    .map((module) => `import ${module}`)
    .join("\n");
  const header = importLines === ""
    ? "set_option autoImplicit false"
    : importLines + "\n\nset_option autoImplicit false";
  return header + "\n\n#check (" + target.propositionText + ")";
}

export function createLeanProofDraft(
  input: Readonly<CreateLeanProofDraftInput>
): LeanProofDraft {
  const formalizationId = nonEmpty(input.formalizationId);
  const targetId = nonEmpty(input.targetId);
  if (formalizationId === "" || targetId === "") {
    throw new Error("formalizationId and targetId must be non-empty.");
  }
  const now = input.createdAt ?? new Date().toISOString();
  return {
    id: nonEmpty(input.id) || generateId(),
    formalizationId,
    irId: input.irId,
    targetId,
    targetHash: input.targetHash,
    proofBody: input.proofBody,
    proofHash: hashLeanStatement(input.proofBody),
    provenance: input.provenance ?? "user_authored",
    edited: input.edited ?? false,
    createdAt: now,
    updatedAt: now
  };
}

export function createLeanProofVerificationArtifact(
  input: Readonly<CreateLeanProofArtifactInput>
): LeanProofVerificationArtifact {
  const now = input.createdAt ?? new Date().toISOString();
  return {
    id: nonEmpty(input.id) || generateId(),
    formalizationId: input.formalizationId,
    irId: input.irId,
    targetId: input.targetId,
    targetHash: input.targetHash,
    proofCandidateId: input.proofCandidateId,
    proofHash: input.proofHash,
    proofProvenance: input.proofProvenance,
    theoremName: input.theoremName,
    imports: [...input.imports],
    result: input.result,
    verified: input.verified,
    verifiedAt: input.verifiedAt,
    executedAt: input.executedAt,
    diagnostics: [...(input.diagnostics ?? [])],
    createdAt: now,
    updatedAt: now
  };
}

// ── Idempotent Updates ─────────────────────────────────────────────────

export function upsertLeanFormalizationTarget(
  state: Readonly<LeanProofWorkspaceState>,
  target: Readonly<LeanFormalizationTarget>
): LeanProofWorkspaceState {
  return {
    ...state,
    targets: { ...state.targets, [target.id]: target }
  };
}

export function upsertLeanProofDraft(
  state: Readonly<LeanProofWorkspaceState>,
  draft: Readonly<LeanProofDraft>
): LeanProofWorkspaceState {
  return {
    ...state,
    drafts: { ...state.drafts, [draft.id]: draft }
  };
}

export function addLeanProofVerificationArtifact(
  state: Readonly<LeanProofWorkspaceState>,
  artifact: Readonly<LeanProofVerificationArtifact>
): LeanProofWorkspaceState {
  return {
    ...state,
    artifacts: { ...state.artifacts, [artifact.id]: artifact }
  };
}

// ── Query API ──────────────────────────────────────────────────────────

export function getLeanTargetByFormalizationId(
  state: Readonly<LeanProofWorkspaceState>,
  formalizationId: string
): LeanFormalizationTarget | undefined {
  return Object.values(state.targets).find(
    (target) => target.formalizationId === formalizationId
  );
}

export function getLeanProofDraftsByFormalizationId(
  state: Readonly<LeanProofWorkspaceState>,
  formalizationId: string
): readonly LeanProofDraft[] {
  return Object.values(state.drafts).filter(
    (draft) => draft.formalizationId === formalizationId
  );
}

export function getLeanProofArtifactsByFormalizationId(
  state: Readonly<LeanProofWorkspaceState>,
  formalizationId: string
): readonly LeanProofVerificationArtifact[] {
  return Object.values(state.artifacts).filter(
    (artifact) => artifact.formalizationId === formalizationId
  );
}

export function getLatestVerifiedArtifact(
  state: Readonly<LeanProofWorkspaceState>,
  formalizationId: string
): LeanProofVerificationArtifact | undefined {
  return getLeanProofArtifactsByFormalizationId(state, formalizationId)
    .filter((artifact) => artifact.verified)
    .sort((left, right) => right.verifiedAt!.localeCompare(left.verifiedAt!))
    [0];
}

// ── Serialization ──────────────────────────────────────────────────────

export function serializeLeanProofWorkspace(
  state: Readonly<LeanProofWorkspaceState>
): unknown {
  return {
    schemaVersion: state.schemaVersion,
    targets: Object.fromEntries(
      Object.entries(state.targets).map(([key, value]) => [key, { ...value }])
    ),
    drafts: Object.fromEntries(
      Object.entries(state.drafts).map(([key, value]) => [key, { ...value }])
    ),
    artifacts: Object.fromEntries(
      Object.entries(state.artifacts).map(([key, value]) => [key, { ...value }])
    )
  };
}

function parseTarget(value: unknown): LeanFormalizationTarget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = nonEmpty(value.id);
  const formalizationId = nonEmpty(value.formalizationId);
  const propositionText = nonEmpty(value.propositionText);
  if (id === "" || formalizationId === "" || propositionText === "") {
    return undefined;
  }
  return {
    id,
    formalizationId,
    irId: typeof value.irId === "string" ? value.irId : undefined,
    propositionText,
    imports: asStringArray(value.imports),
    propositionHash:
      typeof value.propositionHash === "string"
        ? value.propositionHash
        : hashLeanStatement(propositionText, asStringArray(value.imports)),
    provenance: value.provenance === "structured_generation" ||
      value.provenance === "migrated_legacy" ||
      value.provenance === "user_edited"
      ? value.provenance
      : "generated",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
  };
}

function parseDraft(value: unknown): LeanProofDraft | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = nonEmpty(value.id);
  const formalizationId = nonEmpty(value.formalizationId);
  const targetId = nonEmpty(value.targetId);
  if (id === "" || formalizationId === "" || targetId === "") {
    return undefined;
  }
  return {
    id,
    formalizationId,
    irId: typeof value.irId === "string" ? value.irId : undefined,
    targetId,
    targetHash:
      typeof value.targetHash === "string" ? value.targetHash : "",
    proofBody: typeof value.proofBody === "string" ? value.proofBody : "",
    proofHash:
      typeof value.proofHash === "string"
        ? value.proofHash
        : hashLeanStatement(typeof value.proofBody === "string" ? value.proofBody : ""),
    provenance: value.provenance === "ai_generated" ||
      value.provenance === "user_edited" ||
      value.provenance === "imported"
      ? value.provenance
      : "user_authored",
    edited: value.edited === true,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
  };
}

function parseArtifact(value: unknown): LeanProofVerificationArtifact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = nonEmpty(value.id);
  const formalizationId = nonEmpty(value.formalizationId);
  const targetId = nonEmpty(value.targetId);
  const proofCandidateId = nonEmpty(value.proofCandidateId);
  if (
    id === "" ||
    formalizationId === "" ||
    targetId === "" ||
    proofCandidateId === ""
  ) {
    return undefined;
  }
  const verified = value.verified === true;
  return {
    id,
    formalizationId,
    irId: typeof value.irId === "string" ? value.irId : undefined,
    targetId,
    targetHash:
      typeof value.targetHash === "string" ? value.targetHash : "",
    proofCandidateId,
    proofHash: typeof value.proofHash === "string" ? value.proofHash : "",
    proofProvenance: value.proofProvenance === "ai_generated" ||
      value.proofProvenance === "user_edited" ||
      value.proofProvenance === "imported"
      ? value.proofProvenance
      : "user_authored",
    theoremName: typeof value.theoremName === "string"
      ? value.theoremName
      : "",
    imports: asStringArray(value.imports),
    result: typeof value.result === "string"
      ? value.result as LeanProofArtifactResult
      : verified
        ? "verified"
        : "lean_error",
    verified,
    verifiedAt: typeof value.verifiedAt === "string" ? value.verifiedAt : undefined,
    executedAt: typeof value.executedAt === "string" ? value.executedAt : "",
    diagnostics: asStringArray(value.diagnostics),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
  };
}

export interface LeanProofWorkspaceLoadResult {
  readonly state: LeanProofWorkspaceState;
  readonly diagnostics: readonly string[];
}

export function deserializeLeanProofWorkspace(
  value: unknown
): LeanProofWorkspaceLoadResult {
  const diagnostics: string[] = [];
  if (!isRecord(value)) {
    return {
      state: emptyLeanProofWorkspace(),
      diagnostics: ["Lean proof workspace must be an object."]
    };
  }
  if (value.schemaVersion !== LEAN_PROOF_WORKSPACE_SCHEMA_VERSION) {
    return {
      state: emptyLeanProofWorkspace(),
      diagnostics: [
        `Unsupported Lean proof workspace schema ${String(value.schemaVersion)}.`
      ]
    };
  }

  const targets: Record<string, LeanFormalizationTarget> = {};
  const drafts: Record<string, LeanProofDraft> = {};
  const artifacts: Record<string, LeanProofVerificationArtifact> = {};

  if (isRecord(value.targets)) {
    for (const [key, raw] of Object.entries(value.targets)) {
      const parsed = parseTarget(raw);
      if (parsed !== undefined) {
        targets[key] = parsed;
      } else {
        diagnostics.push(`Skipped malformed Lean target ${key}.`);
      }
    }
  }
  if (isRecord(value.drafts)) {
    for (const [key, raw] of Object.entries(value.drafts)) {
      const parsed = parseDraft(raw);
      if (parsed !== undefined) {
        drafts[key] = parsed;
      } else {
        diagnostics.push(`Skipped malformed Lean proof draft ${key}.`);
      }
    }
  }
  if (isRecord(value.artifacts)) {
    for (const [key, raw] of Object.entries(value.artifacts)) {
      const parsed = parseArtifact(raw);
      if (parsed !== undefined) {
        artifacts[key] = parsed;
      } else {
        diagnostics.push(`Skipped malformed Lean proof artifact ${key}.`);
      }
    }
  }

  return {
    state: { schemaVersion: LEAN_PROOF_WORKSPACE_SCHEMA_VERSION, targets, drafts, artifacts },
    diagnostics
  };
}

// ── View Model ─────────────────────────────────────────────────────────

export interface ProofWorkspaceViewModel {
  readonly semanticStatus: "accepted" | "unknown";
  readonly semanticStaleness: SemanticStalenessStatus;
  readonly targetStatus: "missing" | "present";
  readonly candidateStatus:
    | "missing"
    | "unverified"
    | "verified"
    | "stale"
    | "placeholder_rejected"
    | "failed";
  readonly verificationStatus:
    | "not_checked"
    | "statement_typechecked"
    | "proof_verified"
    | "error";
  readonly currentTargetHash?: string;
  readonly currentProofHash?: string;
  readonly proofProvenance?: LeanProofProvenance;
  readonly lastVerifiedArtifactId?: string;
}

export function buildProofWorkspaceViewModel(
  state: Readonly<LeanProofWorkspaceState>,
  formalizationId: string,
  options: {
    readonly memory?: PersistedBrainFormalization;
    readonly currentConceptIndex?: Readonly<ConceptIndex>;
  } = {}
): ProofWorkspaceViewModel {
  const target = getLeanTargetByFormalizationId(state, formalizationId);
  const drafts = getLeanProofDraftsByFormalizationId(state, formalizationId);
  const artifacts = getLeanProofArtifactsByFormalizationId(state, formalizationId);
  const latestVerified = artifacts
    .filter((artifact) => artifact.verified)
    .sort((left, right) => right.verifiedAt!.localeCompare(left.verifiedAt!))
    [0];
  const currentDraft = drafts[drafts.length - 1];

  let semanticStaleness: SemanticStalenessStatus = "current";
  if (
    options.memory !== undefined &&
    options.currentConceptIndex !== undefined
  ) {
    semanticStaleness = deriveSemanticStaleness(
      compareBrainFormalizationConcepts(
        options.memory,
        options.currentConceptIndex
      )
    );
  }

  let candidateStatus: ProofWorkspaceViewModel["candidateStatus"] = "missing";
  if (currentDraft !== undefined) {
    const draftArtifact = artifacts
      .filter((artifact) => artifact.proofCandidateId === currentDraft.id)
      .sort((left, right) => right.executedAt.localeCompare(left.executedAt))
      [0];
    if (draftArtifact?.verified === true &&
        draftArtifact.proofHash === currentDraft.proofHash &&
        draftArtifact.targetHash === currentDraft.targetHash) {
      candidateStatus = "verified";
    } else if (
      currentDraft.targetHash !== target?.propositionHash
    ) {
      candidateStatus = "stale";
    } else if (
      draftArtifact?.result === "placeholder_rejected"
    ) {
      candidateStatus = "placeholder_rejected";
    } else if (
      draftArtifact !== undefined && draftArtifact.verified === false
    ) {
      candidateStatus = "failed";
    } else {
      candidateStatus = "unverified";
    }
  }

  return {
    semanticStatus: options.memory !== undefined ? "accepted" : "unknown",
    semanticStaleness,
    targetStatus: target !== undefined ? "present" : "missing",
    candidateStatus,
    verificationStatus: latestVerified !== undefined
      ? "proof_verified"
      : "not_checked",
    currentTargetHash: target?.propositionHash,
    currentProofHash: currentDraft?.proofHash,
    proofProvenance: currentDraft?.provenance,
    lastVerifiedArtifactId: latestVerified?.id
  };
}
