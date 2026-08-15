import type { ConfirmedSemanticDelta } from "./SemanticDelta";
import type { StructuralConflict } from "./StructuralConflict";
import type {
  PendingSemanticDecision,
  PropagationPlan,
  PropagatedConceptRevision,
  PropagationSkippedConcept
} from "./SemanticPropagation";

export const SEMANTIC_DELTA_STATE_SCHEMA_VERSION = 1 as const;

export type SemanticPropagationJobStatus =
  | "awaiting_origin_write"
  | "queued"
  | "planning"
  | "propagating"
  | "completed"
  | "completed_with_pending_decisions"
  | "failed";

export interface SemanticPropagationJob {
  readonly id: string;
  readonly deltaId: string;
  readonly originVaultPath: string;
  readonly status: SemanticPropagationJobStatus;
  readonly attempts: number;
  readonly failure?: string;
}

export interface SemanticPropagationReport {
  readonly deltaId: string;
  readonly status: Exclude<
    SemanticPropagationJobStatus,
    "awaiting_origin_write" | "queued" | "planning" | "propagating"
  >;
  readonly plan: PropagationPlan;
  readonly appliedRevisions: readonly Omit<PropagatedConceptRevision, "concept">[];
  readonly pendingDecisionIds: readonly string[];
  readonly skipped: readonly PropagationSkippedConcept[];
  readonly failures: readonly string[];
}

export interface SemanticDeltaState {
  readonly schemaVersion: typeof SEMANTIC_DELTA_STATE_SCHEMA_VERSION;
  readonly deltas: readonly ConfirmedSemanticDelta[];
  readonly jobs: readonly SemanticPropagationJob[];
  readonly pendingDecisions: readonly PendingSemanticDecision[];
  readonly reports: readonly SemanticPropagationReport[];
  readonly structuralConflicts: readonly StructuralConflict[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveRevision(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

const JOB_STATUSES = new Set<SemanticPropagationJobStatus>([
  "awaiting_origin_write",
  "queued",
  "planning",
  "propagating",
  "completed",
  "completed_with_pending_decisions",
  "failed"
]);

function isPersistedDelta(value: unknown): value is ConfirmedSemanticDelta {
  if (!isRecord(value)) {
    return false;
  }
  return value.authority === "user_confirmed" &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.conceptId) &&
    isPositiveRevision(value.originatingRevision) &&
    isPositiveRevision(value.resultingRevision) &&
    isNonEmptyString(value.confirmedAt) &&
    Array.isArray(value.authorization);
}

function isPersistedJob(value: unknown): value is SemanticPropagationJob {
  if (!isRecord(value)) {
    return false;
  }
  return isNonEmptyString(value.id) &&
    isNonEmptyString(value.deltaId) &&
    isNonEmptyString(value.originVaultPath) &&
    typeof value.status === "string" &&
    JOB_STATUSES.has(value.status as SemanticPropagationJobStatus) &&
    Number.isInteger(value.attempts) && (value.attempts as number) >= 0 &&
    (value.failure === undefined || typeof value.failure === "string");
}

function isPersistedDecision(value: unknown): value is PendingSemanticDecision {
  if (!isRecord(value)) {
    return false;
  }
  return isNonEmptyString(value.id) &&
    (value.kind === undefined || value.kind === "propagation" ||
      value.kind === "structural_conflict") &&
    (value.structuralConflictId === undefined ||
      isNonEmptyString(value.structuralConflictId)) &&
    isNonEmptyString(value.deltaId) &&
    Array.isArray(value.affectedConceptIds) &&
    value.affectedConceptIds.every(isNonEmptyString) &&
    isNonEmptyString(value.reason) &&
    Array.isArray(value.evidence) && value.evidence.every(isNonEmptyString) &&
    Array.isArray(value.candidateActions) &&
    value.candidateActions.every(isNonEmptyString) &&
    ["pending", "resolved", "dismissed", "superseded"].includes(
      String(value.status)
    ) &&
    isNonEmptyString(value.createdAt) &&
    isRecord(value.revisionContext);
}

function isPersistedStructuralConflict(
  value: unknown
): value is StructuralConflict {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1 &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.ruleId) &&
    ["hard_conflict", "structural_tension", "integrity_anomaly"].includes(
      String(value.category)
    ) &&
    ["info", "review", "conflict"].includes(String(value.severity)) &&
    ["open", "resolved", "dismissed", "superseded"].includes(
      String(value.status)
    ) &&
    Array.isArray(value.affectedConceptIds) &&
    value.affectedConceptIds.every(isNonEmptyString) &&
    Array.isArray(value.relationshipEvidence) &&
    isRecord(value.relevantRevisions) &&
    isNonEmptyString(value.reason) &&
    isRecord(value.provenance);
}

function isPersistedReport(value: unknown): value is SemanticPropagationReport {
  if (!isRecord(value)) {
    return false;
  }
  return isNonEmptyString(value.deltaId) &&
    ["completed", "completed_with_pending_decisions", "failed"].includes(
      String(value.status)
    ) &&
    isRecord(value.plan) &&
    value.plan.deltaId === value.deltaId &&
    Array.isArray(value.appliedRevisions) &&
    Array.isArray(value.pendingDecisionIds) &&
    value.pendingDecisionIds.every(isNonEmptyString) &&
    Array.isArray(value.skipped) &&
    Array.isArray(value.failures) && value.failures.every(
      (item) => typeof item === "string"
    );
}

export function createEmptySemanticDeltaState(): SemanticDeltaState {
  return deepFreeze({
    schemaVersion: SEMANTIC_DELTA_STATE_SCHEMA_VERSION,
    deltas: [],
    jobs: [],
    pendingDecisions: [],
    reports: [],
    structuralConflicts: []
  });
}

/** Conservative JSON migration: malformed/future data is ignored, never guessed. */
export function migrateSemanticDeltaState(value: unknown): SemanticDeltaState {
  if (value === undefined || value === null) {
    return createEmptySemanticDeltaState();
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return createEmptySemanticDeltaState();
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.schemaVersion !== SEMANTIC_DELTA_STATE_SCHEMA_VERSION ||
    !Array.isArray(raw.deltas) ||
    !Array.isArray(raw.jobs) ||
    !Array.isArray(raw.pendingDecisions) ||
    !Array.isArray(raw.reports)
  ) {
    return createEmptySemanticDeltaState();
  }
  if (
    !raw.deltas.every(isPersistedDelta) ||
    !raw.jobs.every(isPersistedJob) ||
    !raw.pendingDecisions.every(isPersistedDecision) ||
    !raw.reports.every(isPersistedReport) ||
    (raw.structuralConflicts !== undefined &&
      (!Array.isArray(raw.structuralConflicts) ||
        !raw.structuralConflicts.every(isPersistedStructuralConflict)))
  ) {
    return createEmptySemanticDeltaState();
  }
  return deepFreeze({
    schemaVersion: SEMANTIC_DELTA_STATE_SCHEMA_VERSION,
    deltas: raw.deltas as ConfirmedSemanticDelta[],
    jobs: (raw.jobs as SemanticPropagationJob[]).map((job) =>
      job.status === "awaiting_origin_write" ||
        job.status === "planning" ||
        job.status === "propagating"
        ? { ...job, status: "queued" as const }
        : job
    ),
    pendingDecisions: raw.pendingDecisions as PendingSemanticDecision[],
    reports: raw.reports as SemanticPropagationReport[],
    structuralConflicts: (raw.structuralConflicts ?? []) as StructuralConflict[]
  });
}

/** Replace only the decision inbox without applying restart migration rules. */
export function replaceSemanticPendingDecisions(
  state: Readonly<SemanticDeltaState>,
  pendingDecisions: readonly PendingSemanticDecision[]
): SemanticDeltaState {
  return deepFreeze({
    ...state,
    pendingDecisions: [...pendingDecisions]
  });
}

export function replaceStructuralConflictState(
  state: Readonly<SemanticDeltaState>,
  structuralConflicts: readonly StructuralConflict[],
  pendingDecisions: readonly PendingSemanticDecision[] = state.pendingDecisions
): SemanticDeltaState {
  return deepFreeze({
    ...state,
    structuralConflicts: [...structuralConflicts],
    pendingDecisions: [...pendingDecisions]
  });
}

export function recordConfirmedDelta(
  state: Readonly<SemanticDeltaState>,
  delta: Readonly<ConfirmedSemanticDelta>,
  originVaultPath: string
): SemanticDeltaState {
  if (state.deltas.some((item) => item.id === delta.id)) {
    return state as SemanticDeltaState;
  }
  const job: SemanticPropagationJob = {
    id: `semantic-propagation-job:${delta.id}`,
    deltaId: delta.id,
    originVaultPath,
    status: "awaiting_origin_write",
    attempts: 0
  };
  return deepFreeze({
    ...state,
    deltas: [...state.deltas, delta],
    jobs: [...state.jobs, job]
  });
}

export function updateSemanticPropagationJob(
  state: Readonly<SemanticDeltaState>,
  deltaId: string,
  status: SemanticPropagationJobStatus,
  failure?: string
): SemanticDeltaState {
  let found = false;
  const jobs = state.jobs.map((job) => {
    if (job.deltaId !== deltaId) {
      return job;
    }
    found = true;
    return {
      ...job,
      status,
      attempts: status === "planning" ? job.attempts + 1 : job.attempts,
      ...(failure === undefined ? { failure: undefined } : { failure })
    };
  });
  return found ? deepFreeze({ ...state, jobs }) : state as SemanticDeltaState;
}

export function completeSemanticPropagation(
  state: Readonly<SemanticDeltaState>,
  report: Readonly<SemanticPropagationReport>,
  decisions: readonly PendingSemanticDecision[]
): SemanticDeltaState {
  const knownDecisionIds = new Set(state.pendingDecisions.map((item) => item.id));
  const pendingDecisions = [
    ...state.pendingDecisions,
    ...decisions.filter((item) => !knownDecisionIds.has(item.id))
  ];
  const reports = [
    ...state.reports.filter((item) => item.deltaId !== report.deltaId),
    report
  ];
  return deepFreeze({
    ...state,
    jobs: state.jobs.map((job) => job.deltaId === report.deltaId
      ? { ...job, status: report.status, failure: report.failures[0] }
      : job),
    pendingDecisions,
    reports
  });
}

export function listQueuedSemanticPropagationJobs(
  state: Readonly<SemanticDeltaState>
): readonly SemanticPropagationJob[] {
  return Object.freeze(state.jobs.filter((job) => job.status === "queued"));
}
