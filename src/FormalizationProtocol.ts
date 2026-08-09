// ── Formalization Protocol ─────────────────────────────────────────────
// Lain Language ↔ Lean4 Protocol
//
// Phase 1: math speech act classification, user review, data.json persistence.
// Phase 2: Lean statement generation and typechecking (no proof generation).
// Phase 3: Lean4Backend typecheck & proof verification.
//
// Invariants enforced at runtime:
//   1. Each implicit assumption MUST be referenced by ≥1 semantic change
//      with category "added_assumption" via relatedAssumptionKeys.
//   2. analysisStatus is derived from ambiguities + missingConditions.
//   3. reviewStatus can only be changed by user action (recorded in history).
//   4. proof_verified can only be set by the Lean kernel (Phase 3).
//   5. sourceRefs snapshots and aiNormalizedStatement are immutable.
// ────────────────────────────────────────────────────────────────────────

// ── Constants ──────────────────────────────────────────────────────────

export const MATH_SPEECH_ACTS = [
  "definition_candidate",
  "equivalence_claim",
  "theorem_claim",
  "conjecture",
  "proof_sketch",
  "intuition"
] as const;
export type MathSpeechActKind = typeof MATH_SPEECH_ACTS[number];

export type AnalysisStatus =
  | "needs_clarification"
  | "ready_for_review";

export type ReviewStatus =
  | "pending"
  | "accepted"
  | "rejected";

export type VerificationStatus =
  | "not_checked"
  | "statement_typechecked"
  | "proof_verified"
  | "counterexample_verified"
  | "error";

export type RevisionActor = "ai" | "user" | "system";

export type RevisionAction = "created" | "edited" | "accepted" | "rejected";

export const FORMALIZATION_SCHEMA_VERSION = 1;

// ── Atomic Types ───────────────────────────────────────────────────────

export interface MathObject {
  readonly name: string;
  readonly latex?: string;
  readonly domain?: string;
}

export interface FormalizationAssumption {
  readonly id: string;
  readonly text: string;
}

export interface SourceRef {
  readonly messageId: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly snapshot: string;
}

export interface SemanticChange {
  readonly category:
    | "added_assumption"
    | "removed_ambiguity"
    | "strengthened"
    | "weakened"
    | "added_condition"
    | "narrowed_scope";
  readonly description: string;
  readonly before?: string;
  readonly after?: string;
  readonly relatedAssumptionKeys?: readonly string[];
  readonly relatedAssumptionIds?: readonly string[];
}

export interface FormalizationRevision {
  readonly actor: RevisionActor;
  readonly action: RevisionAction;
  readonly reviewedStatement: string;
  readonly reviewStatus: ReviewStatus;
  readonly updatedAt: string;
  readonly changeDescription?: string;
}

// ── DeepSeek Response (wire format) ────────────────────────────────────

export interface DeepSeekAssumption {
  key: string;
  text: string;
}

export interface DeepSeekMathSpeechResponse {
  speechAct?: string;
  error?: string;
  objects?: DeepSeekMathObject[];
  explicitAssumptions?: DeepSeekAssumption[];
  implicitAssumptions?: DeepSeekAssumption[];
  quantifiers?: string;
  conclusion?: string;
  ambiguities?: string[];
  missingConditions?: string[];
  normalizedStatement?: string;
  latexStatement?: string;
  semanticChanges?: DeepSeekSemanticChange[];
}

interface DeepSeekMathObject {
  name?: string;
  latex?: string;
  domain?: string;
}

interface DeepSeekSemanticChange {
  category?: string;
  description?: string;
  before?: string;
  after?: string;
  relatedAssumptionKeys?: string[];
}

// ── Core Record ────────────────────────────────────────────────────────

export interface FormalizationRecord {
  readonly id: string;
  readonly schemaVersion: number;

  // provenance
  readonly claimId: string;
  readonly sourceRefs: readonly SourceRef[];

  // AI analysis
  readonly speechAct: MathSpeechActKind;
  readonly objects: readonly MathObject[];
  readonly explicitAssumptions: readonly FormalizationAssumption[];
  readonly implicitAssumptions: readonly FormalizationAssumption[];
  readonly quantifiers: string;
  readonly conclusion: string;
  readonly ambiguities: readonly string[];
  readonly missingConditions: readonly string[];
  readonly semanticChanges: readonly SemanticChange[];

  // normalization
  readonly aiNormalizedStatement: string;
  reviewedStatement: string;

  // status
  analysisStatus: AnalysisStatus;
  reviewStatus: ReviewStatus;
  verificationStatus: VerificationStatus;

  // optional LaTeX
  readonly latexStatement?: string;

  // audit trail
  wasEdited: boolean;
  revision: number;
  rejectionReason?: string;
  userNotes?: string;
  history: FormalizationRevision[];

  // Lean4 bridge (Phase 3)
  leanStatement?: string;
  leanFilePath?: string;

  // timestamps
  readonly createdAt: string;
  updatedAt: string;
}

// ── Persistence Index ──────────────────────────────────────────────────

export interface FormalizationIndex {
  schemaVersion: number;
  records: Record<string, FormalizationRecord>;
}

// ── Creation Parameters ────────────────────────────────────────────────

export interface CreateFormalizationParams {
  claimId: string;
  sourceRefs: readonly SourceRef[];
  speechAct: MathSpeechActKind;
  objects: readonly MathObject[];
  explicitAssumptions: readonly FormalizationAssumption[];
  implicitAssumptions: readonly FormalizationAssumption[];
  quantifiers: string;
  conclusion: string;
  ambiguities: readonly string[];
  missingConditions: readonly string[];
  semanticChanges: readonly SemanticChange[];
  aiNormalizedStatement: string;
  latexStatement?: string;
}

// ── Deep Immutability Helpers ──────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object" && typeof value !== "function") {
    return value;
  }

  Object.freeze(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }

  return value;
}

function deepClone<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }

  const cloned: Record<string, unknown> = {};

  for (const key of Object.keys(value as object)) {
    cloned[key] = deepClone((value as Record<string, unknown>)[key]);
  }

  return cloned as T;
}

// ── Helpers ────────────────────────────────────────────────────────────

function isMathSpeechActKind(value: unknown): value is MathSpeechActKind {
  return typeof value === "string" &&
    (MATH_SPEECH_ACTS as readonly string[]).includes(value);
}

const SEMANTIC_CHANGE_CATEGORIES: ReadonlySet<string> = new Set([
  "added_assumption",
  "removed_ambiguity",
  "strengthened",
  "weakened",
  "added_condition",
  "narrowed_scope"
]);

function isValidSemanticChangeCategory(value: unknown): boolean {
  return typeof value === "string" &&
    SEMANTIC_CHANGE_CATEGORIES.has(value);
}

function normalizeString(value: unknown, maxLength = 5000): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();

  if (trimmed === "" || trimmed.length > maxLength) {
    return "";
  }

  return trimmed;
}

function normalizeAssumption(
  value: unknown
): FormalizationAssumption | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const item = value as Record<string, unknown>;
  const id = normalizeString(item.id, 100);
  const key = normalizeString(item.key, 100);
  const text = normalizeString(item.text, 500);

  if (text === "") {
    return null;
  }

  return {
    id: id || key || `asmp-${generateShortId()}`,
    text
  };
}

function normalizeMathObject(
  value: unknown
): MathObject | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const item = value as Record<string, unknown>;
  const name = normalizeString(item.name, 200);

  if (name === "") {
    return null;
  }

  return deepFreeze({
    name,
    latex: typeof item.latex === "string" && item.latex.trim() !== ""
      ? item.latex.trim().slice(0, 500)
      : undefined,
    domain: typeof item.domain === "string" && item.domain.trim() !== ""
      ? item.domain.trim().slice(0, 500)
      : undefined
  });
}

function normalizeSourceRef(value: unknown): SourceRef | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const item = value as Record<string, unknown>;
  const messageId = normalizeString(item.messageId, 200);

  if (messageId === "") {
    return null;
  }

  const snapshot = typeof item.snapshot === "string" ? item.snapshot : "";

  if (snapshot.trim() === "") {
    return null;
  }

  return deepFreeze({
    messageId,
    startOffset: typeof item.startOffset === "number" &&
      item.startOffset >= 0
      ? item.startOffset
      : undefined,
    endOffset: typeof item.endOffset === "number" &&
      item.endOffset >= 0
      ? item.endOffset
      : undefined,
    snapshot
  });
}

function generateShortId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? fallbackId();
  } catch {
    return fallbackId();
  }
}

function fallbackId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── DeepSeek Response Parsing ──────────────────────────────────────────

export function parseMathSpeechResponse(
  raw: unknown
): {
  speechAct: MathSpeechActKind;
  objects: MathObject[];
  explicitAssumptions: FormalizationAssumption[];
  implicitAssumptions: FormalizationAssumption[];
  quantifiers: string;
  conclusion: string;
  ambiguities: string[];
  missingConditions: string[];
  normalizedStatement: string;
  latexStatement?: string;
  semanticChanges: SemanticChange[];
} | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "Invalid response format." };
  }

  const response = raw as Record<string, unknown>;

  // error
  if (typeof response.error === "string" && response.error !== "") {
    return { error: response.error };
  }

  // speechAct
  if (!isMathSpeechActKind(response.speechAct)) {
    return { error: "Missing or invalid speechAct." };
  }

  // normalizedStatement
  const normalizedStatement = normalizeString(
    response.normalizedStatement,
    5000
  );
  if (normalizedStatement === "") {
    return { error: "Missing normalizedStatement." };
  }

  // quantifiers
  const quantifiers = normalizeString(response.quantifiers, 2000);

  // conclusion
  const conclusion = normalizeString(response.conclusion, 2000);

  // objects
  const objects: MathObject[] = [];
  if (Array.isArray(response.objects)) {
    for (const item of response.objects.slice(0, 20)) {
      const parsed = normalizeMathObject(item);
      if (parsed !== null) {
        objects.push(parsed);
      }
    }
  }

  // explicit assumptions (key-based)
  const explicitAssumptions: FormalizationAssumption[] = [];
  if (Array.isArray(response.explicitAssumptions)) {
    const seen = new Set<string>();
    for (const item of response.explicitAssumptions.slice(0, 20)) {
      const parsed = normalizeAssumption(item);
      if (parsed !== null && !seen.has(parsed.id) && !seen.has(parsed.text)) {
        seen.add(parsed.id);
        seen.add(parsed.text);
        explicitAssumptions.push(deepFreeze(parsed));
      }
    }
  }

  // implicit assumptions (key-based)
  const implicitAssumptions: FormalizationAssumption[] = [];
  if (Array.isArray(response.implicitAssumptions)) {
    const seen = new Set<string>();
    for (const item of response.implicitAssumptions.slice(0, 20)) {
      const parsed = normalizeAssumption(item);
      if (parsed !== null && !seen.has(parsed.id) && !seen.has(parsed.text)) {
        seen.add(parsed.id);
        seen.add(parsed.text);
        implicitAssumptions.push(deepFreeze(parsed));
      }
    }
  }

  // ambiguities
  const ambiguities: string[] = [];
  if (Array.isArray(response.ambiguities)) {
    for (const item of response.ambiguities) {
      const normalized = normalizeString(item, 1000);
      if (normalized !== "") {
        ambiguities.push(normalized);
      }
    }
  }

  // missingConditions
  const missingConditions: string[] = [];
  if (Array.isArray(response.missingConditions)) {
    for (const item of response.missingConditions) {
      const normalized = normalizeString(item, 1000);
      if (normalized !== "") {
        missingConditions.push(normalized);
      }
    }
  }

  // semanticChanges
  const semanticChanges: SemanticChange[] = [];
  if (Array.isArray(response.semanticChanges)) {
    for (const item of response.semanticChanges.slice(0, 40)) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const change = item as Record<string, unknown>;
      if (!isValidSemanticChangeCategory(change.category)) {
        continue;
      }
      const description = normalizeString(change.description, 2000);
      if (description === "") {
        continue;
      }

      const relatedKeys: string[] = [];
      if (Array.isArray(change.relatedAssumptionKeys)) {
        for (const key of change.relatedAssumptionKeys) {
          if (typeof key === "string" && key.trim() !== "") {
            relatedKeys.push(key.trim());
          }
        }
      }

      semanticChanges.push(deepFreeze({
        category: change.category as SemanticChange["category"],
        description,
        before: typeof change.before === "string" &&
          change.before.trim() !== ""
          ? change.before.trim().slice(0, 1000)
          : undefined,
        after: typeof change.after === "string" &&
          change.after.trim() !== ""
          ? change.after.trim().slice(0, 1000)
          : undefined,
        relatedAssumptionKeys: relatedKeys.length > 0
          ? relatedKeys
          : undefined
      }));
    }
  }

  // latex
  const latexStatement = typeof response.latexStatement === "string" &&
    response.latexStatement.trim() !== ""
    ? response.latexStatement.trim().slice(0, 5000)
    : undefined;

  return {
    speechAct: response.speechAct as MathSpeechActKind,
    objects,
    explicitAssumptions,
    implicitAssumptions,
    quantifiers,
    conclusion,
    ambiguities,
    missingConditions,
    normalizedStatement,
    latexStatement,
    semanticChanges
  };
}

// ── Assumption Key → ID Resolution ─────────────────────────────────────

function resolveAssumptionKeys(
  implicitAssumptions: readonly FormalizationAssumption[],
  semanticChanges: readonly SemanticChange[]
): {
  resolvedAssumptions: FormalizationAssumption[];
  resolvedChanges: SemanticChange[];
  unresolvedKeys: string[];
} {
  const resolvedAssumptions = implicitAssumptions.map((a) => ({
    ...a,
    id: a.id || `asmp-${generateShortId()}`
  }));

  // Build key→id lookup
  const keyToId = new Map<string, string>();
  const textToId = new Map<string, string>();

  for (const a of resolvedAssumptions) {
    keyToId.set(a.id, a.id);
    textToId.set(a.text, a.id);
  }

  const resolvedChanges: SemanticChange[] = [];
  const referencedIds = new Set<string>();

  for (const change of semanticChanges) {
    if (change.category !== "added_assumption") {
      resolvedChanges.push(change);
      continue;
    }

    if (change.relatedAssumptionKeys === undefined) {
      resolvedChanges.push(change);
      continue;
    }

    const resolvedIds: string[] = [];

    for (const key of change.relatedAssumptionKeys) {
      const id = keyToId.get(key) ?? textToId.get(key);

      if (id !== undefined) {
        resolvedIds.push(id);
        referencedIds.add(id);
      }
    }

    resolvedChanges.push(deepFreeze({
      category: change.category,
      description: change.description,
      before: change.before,
      after: change.after,
      relatedAssumptionIds: resolvedIds.length > 0
        ? resolvedIds
        : undefined
    }));
  }

  const allImplicitIds = new Set(resolvedAssumptions.map((a) => a.id));
  const unresolvedKeys: string[] = [];

  for (const id of allImplicitIds) {
    if (!referencedIds.has(id)) {
      const assumption = resolvedAssumptions.find((a) => a.id === id);

      if (assumption !== undefined) {
        unresolvedKeys.push(assumption.id + ": " + assumption.text);
      }
    }
  }

  return {
    resolvedAssumptions: deepFreeze(resolvedAssumptions),
    resolvedChanges,
    unresolvedKeys
  };
}

// ── Invariant Validation ───────────────────────────────────────────────

export function deriveAnalysisStatus(
  ambiguities: readonly string[],
  missingConditions: readonly string[]
): AnalysisStatus {
  return (ambiguities.length > 0 || missingConditions.length > 0)
    ? "needs_clarification"
    : "ready_for_review";
}

export function validateFormalizationInvariants(
  record: FormalizationRecord
): string[] {
  const errors: string[] = [];

  // 1. analysisStatus must match ambiguities/missingConditions
  const needsClarification =
    record.ambiguities.length > 0 ||
    record.missingConditions.length > 0;
  if (needsClarification && record.analysisStatus !== "needs_clarification") {
    errors.push(
      "analysisStatus must be needs_clarification when ambiguities or " +
      "missingConditions are present."
    );
  }

  if (!needsClarification && record.analysisStatus !== "ready_for_review") {
    errors.push(
      "analysisStatus must be ready_for_review when no ambiguities or " +
      "missingConditions."
    );
  }

  // 2. Each implicit assumption must be referenced by ≥1 semantic change
  //    with category "added_assumption" via relatedAssumptionIds.
  for (const imp of record.implicitAssumptions) {
    const matched = record.semanticChanges.some(
      (change) =>
        change.category === "added_assumption" &&
        change.relatedAssumptionIds !== undefined &&
        change.relatedAssumptionIds.includes(imp.id)
    );

    if (!matched) {
      errors.push(
        `Implicit assumption "${imp.id}" ("${imp.text}") is not ` +
        `referenced by any semantic change with category "added_assumption".`
      );
    }
  }

  // 3. reviewStatus must have been set by user action (audited in history)
  if (record.reviewStatus === "accepted" || record.reviewStatus === "rejected") {
    const hasUserAction = record.history.some(
      (rev) =>
        rev.actor === "user" &&
        (rev.action === "accepted" || rev.action === "rejected") &&
        rev.reviewStatus === record.reviewStatus
    );

    if (!hasUserAction) {
      errors.push(
        `reviewStatus "${record.reviewStatus}" must have a corresponding ` +
        `user action in history.`
      );
    }
  }

  // 4. proof_verified can only be set by Lean kernel (Phase 3)
  if (record.verificationStatus === "proof_verified") {
    errors.push(
      "verificationStatus proof_verified can only be set by Lean kernel " +
      "(Phase 3)."
    );
  }

  // 5. Phase 1 verificationStatus constraints
  if (
    record.verificationStatus !== "not_checked" &&
    record.verificationStatus !== "error"
  ) {
    errors.push(
      "Phase 1 only supports verificationStatus not_checked or error."
    );
  }

  return errors;
}

// ── Factory ────────────────────────────────────────────────────────────

export function createFormalizationRecord(
  params: CreateFormalizationParams
): FormalizationRecord {
  const now = new Date().toISOString();

  // Deep-freeze sourceRefs
  const frozenSourceRefs = deepFreeze(
    params.sourceRefs.map((ref) => deepFreeze({ ...ref }))
  );

  // Resolve assumption key → ID linkage
  const { resolvedAssumptions, resolvedChanges, unresolvedKeys } =
    resolveAssumptionKeys(
      params.implicitAssumptions,
      params.semanticChanges
    );

  if (unresolvedKeys.length > 0) {
    throw new Error(
      "Implicit assumptions not referenced by any added_assumption " +
      "semantic change:\n" + unresolvedKeys.join("\n")
    );
  }

  const analysisStatus = deriveAnalysisStatus(
    params.ambiguities,
    params.missingConditions
  );

  const initialHistory: FormalizationRevision[] = [deepFreeze({
    actor: "ai",
    action: "created",
    reviewedStatement: params.aiNormalizedStatement,
    reviewStatus: "pending",
    updatedAt: now,
    changeDescription: "Initial AI formalization"
  })];

  const record: FormalizationRecord = {
    id: generateShortId(),
    schemaVersion: FORMALIZATION_SCHEMA_VERSION,
    claimId: params.claimId,
    sourceRefs: frozenSourceRefs,
    speechAct: params.speechAct,
    objects: deepFreeze([...params.objects]),
    explicitAssumptions: deepFreeze([...params.explicitAssumptions]),
    implicitAssumptions: resolvedAssumptions,
    quantifiers: params.quantifiers,
    conclusion: params.conclusion,
    ambiguities: deepFreeze([...params.ambiguities]),
    missingConditions: deepFreeze([...params.missingConditions]),
    semanticChanges: resolvedChanges,
    aiNormalizedStatement: params.aiNormalizedStatement,
    reviewedStatement: params.aiNormalizedStatement,
    analysisStatus,
    reviewStatus: "pending",
    verificationStatus: "not_checked",
    latexStatement: params.latexStatement,
    wasEdited: false,
    revision: 1,
    history: initialHistory,
    createdAt: now,
    updatedAt: now
  };

  const invariantErrors = validateFormalizationInvariants(record);

  if (invariantErrors.length > 0) {
    throw new Error(
      "Formalization invariants violated:\n" + invariantErrors.join("\n")
    );
  }

  return deepFreeze(record);
}

// ── Controlled Update ──────────────────────────────────────────────────

export function applyFormalizationReview(
  record: Readonly<FormalizationRecord>,
  reviewStatus: ReviewStatus,
  reviewedStatement?: string,
  rejectionReason?: string,
  userNotes?: string
): FormalizationRecord {
  // Validate
  if ((reviewStatus === "accepted" || reviewStatus === "rejected") &&
    reviewedStatement !== undefined &&
    reviewedStatement.trim() === "") {
    throw new Error("reviewedStatement cannot be empty.");
  }

  if (reviewStatus === "rejected" && (rejectionReason ?? "").trim() === "") {
    throw new Error("Rejection reason is required.");
  }

  const now = new Date().toISOString();
  const nextReviewedStatement = reviewedStatement ?? record.reviewedStatement;
  const wasEdited = nextReviewedStatement !== record.aiNormalizedStatement;
  const nextRevision = record.revision + 1;

  // Determine action
  let action: RevisionAction;
  if (reviewStatus === "accepted") {
    action = "accepted";
  } else if (reviewStatus === "rejected") {
    action = "rejected";
  } else if (wasEdited) {
    action = "edited";
  } else {
    action = "edited";
  }

  const newRevision: FormalizationRevision = deepFreeze({
    actor: "user",
    action,
    reviewedStatement: nextReviewedStatement,
    reviewStatus,
    updatedAt: now
  });

  const nextHistory = [...record.history, newRevision];

  const next: FormalizationRecord = {
    ...record,
    reviewedStatement: nextReviewedStatement,
    reviewStatus,
    wasEdited,
    revision: nextRevision,
    rejectionReason: reviewStatus === "rejected"
      ? rejectionReason
      : record.rejectionReason,
    userNotes: userNotes ?? record.userNotes,
    history: nextHistory,
    updatedAt: now
  };

  const invariantErrors = validateFormalizationInvariants(next);

  if (invariantErrors.length > 0) {
    throw new Error(
      "Formalization invariants violated after review:\n" +
      invariantErrors.join("\n")
    );
  }

  return deepFreeze(next);
}

// ── Markdown Summary (Human Readable Only) ─────────────────────────────

export function buildFormalizationSummary(
  record: FormalizationRecord
): string {
  const statusLabel = record.reviewStatus === "accepted"
    ? "accepted"
    : record.reviewStatus === "rejected"
      ? "rejected"
      : record.analysisStatus === "needs_clarification"
        ? "needs clarification"
        : "pending";

  const lines: string[] = [];

  lines.push(
    `- ${record.speechAct} (${statusLabel}): ` +
    record.conclusion.slice(0, 120)
  );

  if (record.implicitAssumptions.length > 0) {
    const addedByAI = record.implicitAssumptions
      .map((a) => a.text)
      .join("; ");
    lines.push(`  - Assumptions added by AI: ${addedByAI}`);
  }

  if (record.missingConditions.length > 0) {
    lines.push(
      `  - Missing conditions: ${record.missingConditions.join("; ")}`
    );
  }

  if (record.ambiguities.length > 0) {
    lines.push(
      `  - Ambiguities: ${record.ambiguities.join("; ")}`
    );
  }

  lines.push(
    `  - Normalized: ${record.reviewedStatement.slice(0, 200)}`
  );

  if (record.wasEdited) {
    lines.push("  - User edited the normalized statement.");
  }

  if (record.rejectionReason !== undefined) {
    lines.push(`  - Rejection reason: ${record.rejectionReason}`);
  }

  return lines.join("\n");
}

export function buildAllFormalizationSummaries(
  records: readonly FormalizationRecord[]
): string {
  if (records.length === 0) {
    return "";
  }

  return [
    "### Formalizations",
    ...records.map((r) => buildFormalizationSummary(r)),
    ""
  ].join("\n");
}

// ── Serialization ──────────────────────────────────────────────────────

export function serializeFormalizationIndex(
  index: FormalizationIndex
): unknown {
  return deepClone(index);
}

export function deserializeFormalizationIndex(
  value: unknown
): FormalizationIndex | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const data = value as Record<string, unknown>;

  if (typeof data.schemaVersion !== "number" || data.schemaVersion < 1) {
    return null;
  }

  if (typeof data.records !== "object" || data.records === null) {
    return null;
  }

  const records: Record<string, FormalizationRecord> = {};

  for (const [key, recordValue] of Object.entries(
    data.records as Record<string, unknown>
  )) {
    if (typeof recordValue !== "object" || recordValue === null) {
      continue;
    }

    const record = recordValue as Record<string, unknown>;

    if (
      typeof record.id !== "string" ||
      typeof record.schemaVersion !== "number" ||
      typeof record.claimId !== "string" ||
      !isMathSpeechActKind(record.speechAct) ||
      typeof record.aiNormalizedStatement !== "string"
    ) {
      continue;
    }

    // Freeze nested structures
    try {
      records[key] = deepFreeze(record as unknown as FormalizationRecord);
    } catch {
      continue;
    }
  }

  return deepFreeze({
    schemaVersion: data.schemaVersion as number,
    records
  });
}

// ── Phase 3 Stub ───────────────────────────────────────────────────────

export function trySetProofVerified(
  _record: Readonly<FormalizationRecord>
): never {
  throw new Error(
    "proof_verified can only be set by Lean kernel verification (Phase 3)."
  );
}

// ── Lean Artifact Types ────────────────────────────────────────────────

export interface LeanDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  line?: number;
  column?: number;
}

export interface LeanArtifact {
  id: string;
  claimId: string;
  formalizationId: string;
  /** Lean modules this artifact depends on.
   *  Included in generated code as `import <module>` lines.
   *  Empty array → no imports.
   *  ["Mathlib.Data.Real.Basic"] → narrow import.
   *  ["Mathlib"] → explicit full-mathlib fallback. */
  imports: readonly string[];
  generatedCode: string;
  reviewedCode: string;
  status: "not_checked" | "statement_typechecked" | "error";
  diagnostics: LeanDiagnostic[];
  createdAt: string;
  updatedAt: string;
}

// ── Lean Runner Abstraction ────────────────────────────────────────────

export interface LeanCheckRequest {
  code: string;
  timeoutSeconds?: number;
}

export interface LeanProcessDebug {
  sawExit: boolean;
  sawClose: boolean;
  exitCode?: number;
  exitSignal?: string;
  elapsedMs: number;
  usedExitFallback: boolean;
}

export interface LeanCheckResult {
  status: "statement_typechecked" | "error";
  diagnostics: LeanDiagnostic[];
  exitCode: number;
  stdout: string;
  stderr: string;
  debug?: LeanProcessDebug;
}

export interface LeanRunner {
  check(request: LeanCheckRequest): Promise<LeanCheckResult>;
}

// ── Lean Artifact Persistence ──────────────────────────────────────────

export interface LeanArtifactIndex {
  schemaVersion: number;
  artifacts: Record<string, LeanArtifact>;
}

export const LEAN_ARTIFACT_SCHEMA_VERSION = 2;

export function serializeLeanArtifactIndex(
  index: LeanArtifactIndex
): unknown {
  return deepClone(index);
}

export function deserializeLeanArtifactIndex(
  value: unknown
): LeanArtifactIndex | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const data = value as Record<string, unknown>;

  if (
    typeof data.schemaVersion !== "number" ||
    data.schemaVersion < 1 ||
    data.schemaVersion > 2
  ) {
    return null;
  }

  if (
    typeof data.artifacts !== "object" ||
    data.artifacts === null
  ) {
    return null;
  }

  const artifacts: Record<string, LeanArtifact> = {};

  for (const [key, art] of Object.entries(
    data.artifacts as Record<string, unknown>
  )) {
    if (typeof art !== "object" || art === null) {
      continue;
    }

    const a = art as Record<string, unknown>;

    if (
      typeof a.id !== "string" ||
      typeof a.claimId !== "string" ||
      typeof a.formalizationId !== "string"
    ) {
      continue;
    }

    try {
      // Backward compat: pre-v2 artifacts lack `imports` → default to ["Mathlib"].
      const artifact = a as Record<string, unknown>;
      if (!Array.isArray(artifact.imports)) {
        artifact.imports = ["Mathlib"];
      }
      artifacts[key] = deepFreeze(artifact as unknown as LeanArtifact);
    } catch {
      continue;
    }
  }

  return deepFreeze({
    schemaVersion: data.schemaVersion as number,
    artifacts
  });
}

// ── Lean Body Import Guard ─────────────────────────────────────────────

/**
 * Validate that a Lean body (the part after imports, produced by an LLM
 * or other external source) does NOT contain any top-level `import`
 * directives.
 *
 * The import block is owned exclusively by `LeanArtifact.imports` and
 * assembled by `buildLeanCode`.  An LLM body that carries its own import
 * lines violates this contract.
 *
 * Detection rules (per line):
 *   - A line whose first non-whitespace characters are `import` followed
 *     by whitespace or end-of-line is a directive and triggers rejection.
 *     This includes lines with trailing comments:
 *       `import Mathlib -- trailing comment`
 *   - Lines that start with `--` (comment) are naturally ignored because
 *     the first non-whitespace characters are `--`, not `import`.
 *   - The bare word "import" appearing mid-line in prose is not matched.
 *
 * Returns an empty array on success, or a single-error diagnostic array
 * when the body contains at least one import directive.
 */
export function validateLeanBodyNoImports(
  body: string
): LeanDiagnostic[] {
  if (typeof body !== "string" || body.trim() === "") {
    return [];
  }

  // Match a line whose first non-whitespace characters are `import`
  // followed by a space, tab, or end-of-string.
  //
  // Comment lines (first non-whitespace is `--`) are naturally excluded
  // — no explicit `--` check needed.
  //
  // Breakdown:
  //   ^[ \t]*        — leading spaces / tabs
  //   import          — the keyword
  //   (?=[ \t]|$)     — followed by whitespace or end-of-line
  const IMPORT_DIRECTIVE_RE = /^[ \t]*import(?=[ \t]|$)/m;

  if (IMPORT_DIRECTIVE_RE.test(body)) {
    // Find the first offending line for the diagnostic message.
    // Uses the same rule as the regex: first non-whitespace is `import`.
    const lines = body.split("\n");
    let firstLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith("import ") ||
        trimmed === "import"
      ) {
        firstLine = i + 1;
        break;
      }
    }

    return [
      {
        severity: "error",
        message:
          "LLM violated the Lean body contract: the generated body " +
          "contains its own import directive. The import block is " +
          "managed exclusively through LeanArtifact.imports. " +
          "Re-run generation or manually remove any `import` lines " +
          "from the body.",
        line: firstLine
      }
    ];
  }

  return [];
}

// ── Lean Code Builder ──────────────────────────────────────────────────

/**
 * Build a complete Lean source from explicit imports and a statement body.
 *
 * The body should contain the statement, options, and comments — everything
 * after the import block.  The builder only prepends `import <module>` lines.
 *
 * Examples:
 *   buildLeanCode([], "#check (1 + 1 : Nat)")
 *     → "#check (1 + 1 : Nat)"
 *
 *   buildLeanCode(["Mathlib.Data.Real.Basic"], "set_option autoImplicit false\n\n#check (∀ x : ℝ, x + 0 = x)")
 *     → "import Mathlib.Data.Real.Basic\n\nset_option autoImplicit false\n\n#check (∀ x : ℝ, x + 0 = x)"
 *
 *   buildLeanCode(["Mathlib"], "set_option autoImplicit false\n\n#check (1 + 1 : Nat)")
 *     → "import Mathlib\n\nset_option autoImplicit false\n\n#check (1 + 1 : Nat)"
 */
export function buildLeanCode(
  imports: readonly string[],
  body: string
): string {
  if (imports.length === 0) {
    return body;
  }

  const importLines = imports
    .map((m) => `import ${m}`)
    .join("\n");

  return importLines + "\n\n" + body;
}

/**
 * Select the narrowest currently-supported import set for a reviewed
 * formalization. This is deliberately deterministic: the LLM owns only the
 * statement body and cannot invent or widen the artifact import block.
 */
export function selectLeanImportsForFormalization(
  formalization: Readonly<FormalizationRecord>,
  leanBody: string
): readonly string[] {
  const semanticText = [
    formalization.reviewedStatement,
    formalization.conclusion,
    formalization.quantifiers,
    leanBody,
    ...formalization.objects.flatMap((object) => [
      object.name,
      object.latex ?? "",
      object.domain ?? ""
    ])
  ].join("\n");

  if (
    /ℝ/.test(semanticText) ||
    /\\mathbb\{R\}/.test(semanticText) ||
    /\breal(?:\s+number)?s?\b/i.test(semanticText)
  ) {
    return ["Mathlib.Data.Real.Basic"];
  }

  // Explicit compatibility fallback for domains without a reviewed narrow
  // mapping yet. This remains visible in LeanArtifact.imports.
  return ["Mathlib"];
}

// ── Lean Code Safety Validator ─────────────────────────────────────────

export const LEAN_PROHIBITED_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  message: string;
}> = [
  {
    pattern: /\bsorry\b/,
    message:
      "Prohibited: 'sorry' placeholder is not allowed in reviewed code."
  },
  {
    pattern: /\badmit\b/,
    message:
      "Prohibited: 'admit' placeholder is not allowed in reviewed code."
  },
  {
    pattern: /\baxiom\b/,
    message:
      "Prohibited: 'axiom' declaration is not allowed in reviewed code."
  },
  {
    pattern: /\bunsafe\b/,
    message:
      "Prohibited: 'unsafe' construct is not allowed in reviewed code."
  },
  {
    pattern: /\bIO\.\s*(?:readFile|writeFile|process|spawn|print|println)\b/,
    message:
      "Prohibited: external I/O or process execution is not allowed."
  },
  {
    pattern: /\bSystem\.\s*(?:cmd|call|spawn)\b/,
    message:
      "Prohibited: external system call is not allowed."
  }
];

export function validateLeanCode(
  code: string
): LeanDiagnostic[] {
  if (typeof code !== "string" || code.trim() === "") {
    return [
      {
        severity: "error",
        message: "Code must be a non-empty string."
      }
    ];
  }

  const diagnostics: LeanDiagnostic[] = [];

  for (const { pattern, message } of LEAN_PROHIBITED_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(code);

    if (match !== null) {
      const line = code.slice(0, match.index).split("\n").length;
      diagnostics.push({
        severity: "error",
        message,
        line
      });
    }
  }

  return diagnostics;
}

// ── Lean Eligibility ────────────────────────────────────────────────────

export interface LeanEligibilityResult {
  eligible: boolean;
  reason?: string;
}

export function checkLeanEligibility(
  formalization: Readonly<FormalizationRecord>,
  isPrimary: boolean
): LeanEligibilityResult {
  if (!isPrimary) {
    return {
      eligible: false,
      reason:
        "This formalization is not set as the primary formalization " +
        "for its claim."
    };
  }

  if (formalization.reviewStatus !== "accepted") {
    return {
      eligible: false,
      reason:
        "The formalization must be accepted before a Lean statement " +
        "can be generated."
    };
  }

  if (formalization.analysisStatus !== "ready_for_review") {
    return {
      eligible: false,
      reason:
        "The formalization must be ready for review (no ambiguities " +
        "or missing conditions) before a Lean statement can be generated."
    };
  }

  return { eligible: true };
}

// ── Primary Formalization Rules ────────────────────────────────────────

export function canSetPrimaryFormalization(
  formalization: Readonly<FormalizationRecord>,
  claimFormalizationIds: readonly string[]
): { allowed: boolean; reason?: string } {
  if (!claimFormalizationIds.includes(formalization.id)) {
    return {
      allowed: false,
      reason:
        "The formalization must belong to the same claim."
    };
  }

  if (formalization.reviewStatus === "rejected") {
    return {
      allowed: false,
      reason:
        "A rejected formalization cannot be set as primary."
    };
  }

  return { allowed: true };
}

export function shouldClearPrimaryOnRejection(
  formalization: Readonly<FormalizationRecord>,
  currentPrimaryId: string | undefined
): boolean {
  return formalization.id === currentPrimaryId;
}
