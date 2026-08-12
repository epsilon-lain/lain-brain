// ── Continuous chat-level semantic hypotheses ─────────────────────────
//
// A ChatSemanticSession tracks the AI's current best interpretation of user
// language. Understanding is provisional: a usable hypothesis needs no generic
// approval event and may be replaced naturally as later user evidence arrives.
// Only genuine blocking ambiguity interrupts the conversation.
//
// This controller creates no UserConclusion and performs no truth validation,
// AI call, Lean call, network access, Vault write, or persistence operation.

import {
  applySemanticPatch,
  getUnresolvedBlockingAmbiguities,
  resolveAmbiguity,
  type SemanticAmbiguity,
  type SemanticPatch,
  type SemanticSpec
} from "./SemanticSpec";
import {
  validateUserConclusion,
  type UserTextProvenance
} from "./KnowledgeProtocol";

export const CHAT_SEMANTIC_STATES = [
  "analyzing",
  "needs_clarification",
  "understood"
] as const;
export type ChatSemanticState = typeof CHAT_SEMANTIC_STATES[number];

export type SemanticHypothesisChangeKind =
  | "initial_analysis"
  | "analysis_attached"
  | "clarification_answer"
  | "semantic_patch"
  | "conversation_refinement";

export interface SemanticHypothesisHistoryEntry {
  readonly sessionRevision: number;
  readonly semanticSpec: SemanticSpec;
  readonly changeKind: SemanticHypothesisChangeKind;
  readonly evidenceRefs: readonly UserTextProvenance[];
  readonly createdAt: string;
}

export interface ChatClarificationAnswer {
  readonly ambiguityId: string;
  readonly resolutionId: string;
  readonly answerText: string;
  readonly selectedChoiceId?: string;
  readonly createdAt: string;
}

export interface ChatSemanticSession {
  readonly id: string;
  /** Initial expression that began this semantic negotiation. */
  readonly userText: string;
  readonly userSourceRefs: readonly UserTextProvenance[];
  /** All user-authored evidence currently informing the hypothesis. */
  readonly evidenceRefs: readonly UserTextProvenance[];
  readonly semanticSpec?: SemanticSpec;
  /** Ephemeral AI presentation; never authoritative knowledge prose. */
  readonly semanticReviewPresentation?: string;
  readonly clarificationAnswers: readonly ChatClarificationAnswer[];
  readonly hypothesisHistory: readonly SemanticHypothesisHistoryEntry[];
  readonly state: ChatSemanticState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChatSemanticSessionParams {
  readonly id: string;
  readonly userText: string;
  readonly userSourceRefs: readonly UserTextProvenance[];
  readonly semanticSpec?: SemanticSpec;
  readonly semanticReviewPresentation?: string;
  readonly createdAt: string;
}

export interface ReviseSemanticHypothesisParams {
  readonly semanticSpec: SemanticSpec;
  readonly updatedAt: string;
  readonly additionalUserSourceRefs?: readonly UserTextProvenance[];
  readonly semanticReviewPresentation?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined ||
      (typeof value !== "object" && typeof value !== "function")) {
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
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    clone[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return clone as T;
}

function deriveState(
  semanticSpec: Readonly<SemanticSpec> | undefined
): ChatSemanticState {
  if (semanticSpec === undefined) {
    return "analyzing";
  }
  return getUnresolvedBlockingAmbiguities(semanticSpec).length > 0
    ? "needs_clarification"
    : "understood";
}

function materializeUserSource(source: Readonly<UserTextProvenance>): string {
  if (source.sourceKind === "user_edit") {
    return source.snapshot;
  }
  if (source.startOffset === undefined && source.endOffset === undefined) {
    return source.snapshot;
  }
  if (source.startOffset === undefined || source.endOffset === undefined) {
    return "";
  }
  return source.snapshot.slice(source.startOffset, source.endOffset);
}

function materializeSemanticSource(
  source: Readonly<SemanticSpec["sourceRefs"][number]>
): string {
  if (source.startOffset === undefined && source.endOffset === undefined) {
    return source.snapshot;
  }
  if (source.startOffset === undefined || source.endOffset === undefined) {
    return "";
  }
  return source.snapshot.slice(source.startOffset, source.endOffset);
}

function validateExactUserText(
  id: string,
  text: string,
  sourceRefs: readonly UserTextProvenance[],
  createdAt: string
): void {
  const errors = validateUserConclusion({
    id: `provenance-check:${id}`,
    text,
    sourceRefs,
    kind: "other",
    protocolArtifactIds: [],
    createdAt
  });
  if (errors.length > 0) {
    throw new Error(
      "User text provenance is invalid:\n" +
      errors.map((error) => `  ${error.path}: ${error.message}`).join("\n")
    );
  }
}

function validateEvidenceRef(
  sessionId: string,
  sourceRef: Readonly<UserTextProvenance>,
  index: number,
  createdAt: string
): void {
  validateExactUserText(
    `${sessionId}:evidence:${index}`,
    materializeUserSource(sourceRef),
    [sourceRef],
    createdAt
  );
}

function requirePendingWorkingSpec(semanticSpec: Readonly<SemanticSpec>): void {
  if (semanticSpec.reviewStatus !== "pending") {
    throw new Error(
      "A chat semantic hypothesis must remain pending, not accepted or rejected."
    );
  }
}

function requireSemanticSpecEvidence(
  semanticSpec: Readonly<SemanticSpec>,
  evidenceRefs: readonly UserTextProvenance[]
): void {
  const semanticEvidence = semanticSpec.sourceRefs.map(materializeSemanticSource);
  for (const evidenceRef of evidenceRefs) {
    const evidence = materializeUserSource(evidenceRef);
    if (!semanticEvidence.includes(evidence)) {
      throw new Error(
        "SemanticSpec must contain an exact source snapshot for every user evidence span."
      );
    }
  }
}

function makeHistoryEntry(
  sessionRevision: number,
  semanticSpec: Readonly<SemanticSpec>,
  changeKind: SemanticHypothesisChangeKind,
  evidenceRefs: readonly UserTextProvenance[],
  createdAt: string
): SemanticHypothesisHistoryEntry {
  return deepFreeze(deepClone({
    sessionRevision,
    semanticSpec,
    changeKind,
    evidenceRefs,
    createdAt
  })) as SemanticHypothesisHistoryEntry;
}

function validateCreateParams(params: CreateChatSemanticSessionParams): void {
  if (!nonEmpty(params.id)) {
    throw new Error("Chat semantic session ID cannot be empty.");
  }
  if (!nonEmpty(params.createdAt)) {
    throw new Error("createdAt cannot be empty.");
  }
  validateExactUserText(
    params.id,
    params.userText,
    params.userSourceRefs,
    params.createdAt
  );
  if (params.semanticSpec !== undefined) {
    requirePendingWorkingSpec(params.semanticSpec);
    requireSemanticSpecEvidence(params.semanticSpec, params.userSourceRefs);
  }
}

export function createChatSemanticSession(
  params: CreateChatSemanticSessionParams
): ChatSemanticSession {
  validateCreateParams(params);
  const evidenceRefs = deepFreeze(deepClone(params.userSourceRefs));
  const history = params.semanticSpec === undefined
    ? []
    : [makeHistoryEntry(
      1,
      params.semanticSpec,
      "initial_analysis",
      evidenceRefs,
      params.createdAt
    )];
  return deepFreeze(deepClone({
    id: params.id,
    userText: params.userText,
    userSourceRefs: params.userSourceRefs,
    evidenceRefs,
    semanticSpec: params.semanticSpec,
    semanticReviewPresentation: params.semanticReviewPresentation,
    clarificationAnswers: [],
    hypothesisHistory: history,
    state: deriveState(params.semanticSpec),
    revision: 1,
    createdAt: params.createdAt,
    updatedAt: params.createdAt
  })) as ChatSemanticSession;
}

/** Attach the first AI-supplied working hypothesis to an analyzing session. */
export function attachSemanticAnalysis(
  session: Readonly<ChatSemanticSession>,
  semanticSpec: Readonly<SemanticSpec>,
  updatedAt: string,
  semanticReviewPresentation?: string
): ChatSemanticSession {
  if (session.state !== "analyzing" || session.semanticSpec !== undefined) {
    throw new Error("Semantic analysis can only be attached to an analyzing session.");
  }
  if (!nonEmpty(updatedAt)) {
    throw new Error("updatedAt cannot be empty.");
  }
  requirePendingWorkingSpec(semanticSpec);
  requireSemanticSpecEvidence(semanticSpec, session.evidenceRefs);
  const revision = session.revision + 1;
  const historyEntry = makeHistoryEntry(
    revision,
    semanticSpec,
    "analysis_attached",
    session.evidenceRefs,
    updatedAt
  );
  return deepFreeze(deepClone({
    ...session,
    semanticSpec,
    semanticReviewPresentation,
    hypothesisHistory: [...session.hypothesisHistory, historyEntry],
    state: deriveState(semanticSpec),
    revision,
    updatedAt
  })) as ChatSemanticSession;
}

export function getBlockingAmbiguityQuestions(
  session: Readonly<ChatSemanticSession>
): readonly SemanticAmbiguity[] {
  if (session.semanticSpec === undefined) {
    return deepFreeze([]);
  }
  return deepFreeze(deepClone(
    getUnresolvedBlockingAmbiguities(session.semanticSpec)
  ));
}

/** Record user evidence; this does not itself change semantic meaning. */
export function recordChatClarificationAnswer(
  session: Readonly<ChatSemanticSession>,
  ambiguityId: string,
  answerText: string,
  updatedAt: string,
  selectedChoiceId?: string
): ChatSemanticSession {
  if (session.state !== "needs_clarification" ||
      session.semanticSpec === undefined) {
    throw new Error("Clarification answers require a blocking ambiguity.");
  }
  if (!nonEmpty(updatedAt)) {
    throw new Error("updatedAt cannot be empty.");
  }
  const semanticSpec = resolveAmbiguity(
    session.semanticSpec,
    ambiguityId,
    answerText,
    selectedChoiceId
  );
  const resolution = semanticSpec.resolutions.find(
    (item) => item.ambiguityId === ambiguityId
  );
  if (resolution === undefined) {
    throw new Error("Semantic resolution was not recorded.");
  }
  const revision = session.revision + 1;
  const answer: ChatClarificationAnswer = {
    ambiguityId,
    resolutionId: resolution.id,
    answerText: resolution.answerText,
    selectedChoiceId: resolution.selectedChoiceId,
    createdAt: resolution.createdAt
  };
  const historyEntry = makeHistoryEntry(
    revision,
    semanticSpec,
    "clarification_answer",
    session.evidenceRefs,
    updatedAt
  );
  return deepFreeze(deepClone({
    ...session,
    semanticSpec,
    clarificationAnswers: [...session.clarificationAnswers, answer],
    hypothesisHistory: [...session.hypothesisHistory, historyEntry],
    state: deriveState(semanticSpec),
    revision,
    updatedAt
  })) as ChatSemanticSession;
}

/** Apply the explicit semantic effect of a prior clarification answer. */
export function applyChatSemanticRevision(
  session: Readonly<ChatSemanticSession>,
  patch: Readonly<SemanticPatch>,
  updatedAt: string
): ChatSemanticSession {
  if (session.state !== "needs_clarification" ||
      session.semanticSpec === undefined) {
    throw new Error("Semantic patches require a session needing clarification.");
  }
  if (!nonEmpty(updatedAt)) {
    throw new Error("updatedAt cannot be empty.");
  }
  const semanticSpec = applySemanticPatch(session.semanticSpec, patch);
  const revision = session.revision + 1;
  const historyEntry = makeHistoryEntry(
    revision,
    semanticSpec,
    "semantic_patch",
    session.evidenceRefs,
    updatedAt
  );
  return deepFreeze(deepClone({
    ...session,
    semanticSpec,
    hypothesisHistory: [...session.hypothesisHistory, historyEntry],
    state: deriveState(semanticSpec),
    revision,
    updatedAt
  })) as ChatSemanticSession;
}

/**
 * Replace the current working hypothesis when later conversation changes the
 * best interpretation. The old hypothesis stays immutable in history; no
 * accept/reject event is involved.
 */
export function reviseSemanticHypothesis(
  session: Readonly<ChatSemanticSession>,
  params: ReviseSemanticHypothesisParams
): ChatSemanticSession {
  if (session.semanticSpec === undefined) {
    throw new Error("Attach an initial semantic analysis before refining it.");
  }
  if (!nonEmpty(params.updatedAt)) {
    throw new Error("updatedAt cannot be empty.");
  }
  requirePendingWorkingSpec(params.semanticSpec);

  const additions = params.additionalUserSourceRefs ?? [];
  additions.forEach((sourceRef, index) => {
    validateEvidenceRef(session.id, sourceRef, index, params.updatedAt);
  });
  const evidenceRefs = deepFreeze(deepClone([
    ...session.evidenceRefs,
    ...additions
  ]));
  requireSemanticSpecEvidence(params.semanticSpec, evidenceRefs);

  const revision = session.revision + 1;
  const historyEntry = makeHistoryEntry(
    revision,
    params.semanticSpec,
    "conversation_refinement",
    evidenceRefs,
    params.updatedAt
  );
  return deepFreeze(deepClone({
    ...session,
    evidenceRefs,
    semanticSpec: params.semanticSpec,
    semanticReviewPresentation: params.semanticReviewPresentation,
    hypothesisHistory: [...session.hypothesisHistory, historyEntry],
    state: deriveState(params.semanticSpec),
    revision,
    updatedAt: params.updatedAt
  })) as ChatSemanticSession;
}
