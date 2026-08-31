import type { ConceptIndex } from "./BrainGrowthIndex";
import { lookupConcept } from "./BrainGrowthIndex";
import type { UserTextProvenance } from "./KnowledgeProtocol";

export const CHAT_SEMANTIC_DELTA_SCHEMA_VERSION = 1 as const;

export const CHAT_STRUCTURAL_RELATION_TYPES = [
  "depends_on",
  "example_of",
  "derived_from",
  "analogous_to",
  "related_to",
  "part_of"
] as const;
export type ChatStructuralRelationType =
  typeof CHAT_STRUCTURAL_RELATION_TYPES[number];
export const CHAT_DISTINCTION_RELATION = "explicitly_distinct_from" as const;

export type ChatSemanticDeltaChangeKind =
  | "personal_definition"
  | "relationship_confirmed"
  | "relationship_removed"
  | "concept_distinction"
  | "ambiguity_resolved";

export interface ChatSemanticDeltaConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ChatSemanticDeltaAnalysisRequest {
  readonly currentUserMessageId: string;
  readonly conversation: readonly ChatSemanticDeltaConversationMessage[];
}

interface ChatSemanticDeltaAnalysisBase {
  readonly kind: "possible_principal_change";
  readonly reason: string;
  readonly confidence: number;
  readonly evidence: readonly UserTextProvenance[];
}

export type ChatSemanticDeltaAnalysis =
  | { readonly kind: "no_meaningful_change" }
  | {
      readonly kind: "ambiguous_change";
      readonly reason: string;
    }
  | (ChatSemanticDeltaAnalysisBase & {
      readonly changeKind: "personal_definition";
      readonly conceptQuery: string;
      readonly proposedMeaning: string;
    })
  | (ChatSemanticDeltaAnalysisBase & {
      readonly changeKind: "relationship_confirmed" | "relationship_removed";
      readonly sourceConceptQuery: string;
      readonly targetConceptQuery: string;
      readonly relationType: ChatStructuralRelationType;
    })
  | (ChatSemanticDeltaAnalysisBase & {
      readonly changeKind: "concept_distinction";
      readonly sourceConceptQuery: string;
      readonly targetConceptQuery: string;
      readonly distinctionText: string;
    })
  | (ChatSemanticDeltaAnalysisBase & {
      readonly changeKind: "ambiguity_resolved";
      readonly sourceConceptQuery: string;
      readonly selectedConceptQuery: string;
      readonly ambiguityLabel: string;
    });

export type ChatSemanticDeltaAnalyzer = (
  apiKey: string,
  request: Readonly<ChatSemanticDeltaAnalysisRequest>
) => Promise<ChatSemanticDeltaAnalysis>;

export interface ChatSemanticDeltaConceptChoice {
  readonly conceptId: string;
  readonly title: string;
  readonly revision: number;
  readonly vaultPath: string;
  readonly previousMeaning?: string;
}

export type ChatSemanticDeltaProposalTarget =
  | ({ readonly kind: "known_concept" } & ChatSemanticDeltaConceptChoice)
  | {
      readonly kind: "ambiguous_concept";
      readonly query: string;
      readonly choices: readonly ChatSemanticDeltaConceptChoice[];
    }
  | {
      readonly kind: "new_concept";
      readonly suggestedTitle: string;
    };

export type ChatSemanticDeltaProposalStatus =
  | "active"
  | "confirmed"
  | "rejected"
  | "superseded"
  | "expired";

export interface ChatSemanticDeltaProposal {
  readonly schemaVersion: typeof CHAT_SEMANTIC_DELTA_SCHEMA_VERSION;
  readonly authority: "proposed";
  readonly id: string;
  readonly fingerprint: string;
  readonly status: ChatSemanticDeltaProposalStatus;
  readonly changeKind: ChatSemanticDeltaChangeKind;
  /** Definition target or structural source/origin. */
  readonly target: ChatSemanticDeltaProposalTarget;
  /** Structural target or selected meaning. */
  readonly secondaryTarget?: ChatSemanticDeltaProposalTarget;
  readonly relationType?: ChatStructuralRelationType |
    typeof CHAT_DISTINCTION_RELATION;
  readonly ambiguityLabel?: string;
  readonly proposedMeaning: string;
  readonly reason: string;
  readonly confidence: number;
  readonly evidence: readonly UserTextProvenance[];
  readonly sourceMessageIds: readonly string[];
  readonly createdAt: string;
  readonly createdAtUserTurn: number;
  readonly statusMessage?: string;
}

export interface ChatSemanticDeltaConceptRecord {
  readonly vaultPath: string;
  readonly concept: {
    readonly id: string;
    readonly title: string;
    readonly revision: number;
    readonly userDefinition?: { readonly text: string };
    readonly relationships?: readonly {
      readonly id: string;
      readonly relation: string;
      readonly targetConceptId: string;
    }[];
    readonly unresolvedItems?: readonly {
      readonly id: string;
      readonly kind: string;
      readonly text: string;
      readonly alternatives: readonly string[];
      readonly status: string;
    }[];
  };
}

export type ChatSemanticDeltaProposalResult =
  | { readonly kind: "no_proposal" }
  | {
      readonly kind: "ambiguous_change";
      readonly reason: string;
    }
  | {
      readonly kind: "proposal";
      readonly proposal: ChatSemanticDeltaProposal;
    };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function requireRecord(name: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(name: string, value: unknown, maximum = 4000): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be text.`);
  }
  const text = value.trim();
  if (text === "" || text.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw new Error(`${name} is invalid.`);
  }
  return text;
}

function requireLabel(name: string, value: unknown): string {
  const text = requireText(name, value, 70);
  if (/\r|\n/u.test(text)) {
    throw new Error(`${name} must be a single line.`);
  }
  return text;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("Principal semantic-change analysis must be strict JSON.");
  }
  return requireRecord("Principal semantic-change analysis", JSON.parse(trimmed));
}

function parseEvidence(
  value: unknown,
  request: Readonly<ChatSemanticDeltaAnalysisRequest>
): readonly UserTextProvenance[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("A principal change requires exact user evidence.");
  }
  const byId = new Map(
    request.conversation.map((message) => [message.id, message])
  );
  const evidence: UserTextProvenance[] = [];
  const seen = new Set<string>();
  for (const rawEvidence of value.slice(0, 4)) {
    const item = requireRecord("User evidence", rawEvidence);
    const messageId = requireText("Evidence message ID", item.messageId, 200);
    const quote = requireText("Evidence quote", item.quote, 2000);
    const message = byId.get(messageId);
    if (message?.role !== "user") {
      throw new Error("Semantic-change evidence must reference a user message.");
    }
    const startOffset = message.content.indexOf(quote);
    if (startOffset < 0) {
      throw new Error("Semantic-change evidence quote is not exact user text.");
    }
    const key = `${messageId}:${startOffset}:${quote.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      sourceKind: "message_span",
      messageId,
      startOffset,
      endOffset: startOffset + quote.length,
      snapshot: message.content,
      actor: "user"
    });
  }
  if (evidence.length === 0) {
    throw new Error("A principal change requires distinct user evidence.");
  }
  return Object.freeze(evidence);
}

/** Parse and validate model interpretation without granting any authority. */
export function parseChatSemanticDeltaAnalysisJson(
  raw: string,
  request: Readonly<ChatSemanticDeltaAnalysisRequest>
): ChatSemanticDeltaAnalysis {
  const value = parseJsonObject(raw);
  if (value.outcome === "no_meaningful_change") {
    return Object.freeze({ kind: "no_meaningful_change" });
  }
  if (value.outcome === "ambiguous_change") {
    return Object.freeze({
      kind: "ambiguous_change",
      reason: requireText("Ambiguity reason", value.reason, 500)
    });
  }
  if (value.outcome !== "possible_principal_change") {
    throw new Error("Unsupported principal semantic-change outcome.");
  }
  if (value.explicitness !== "explicit" || value.tentative !== false) {
    return Object.freeze({ kind: "no_meaningful_change" });
  }
  if (
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 || value.confidence > 1
  ) {
    throw new Error("Proposal confidence must be between zero and one.");
  }
  const common = {
    kind: "possible_principal_change" as const,
    reason: requireText("Proposal reason", value.reason, 500),
    confidence: value.confidence,
    evidence: parseEvidence(value.evidence, request)
  };
  if (value.changeKind === "personal_definition") {
    const conceptQuery = requireLabel("Concept query", value.conceptQuery);
    if (isExclusivelyScopedBindingEvidence(
      common.evidence, request, conceptQuery
    )) {
      // Scoped bindings ("设 X 为…", "let x = …") are local reasoning
      // scope, not durable personal semantics.
      return Object.freeze({ kind: "no_meaningful_change" });
    }
    return deepFreeze({
      ...common,
      changeKind: "personal_definition" as const,
      conceptQuery,
      proposedMeaning: requireText("Proposed meaning", value.proposedMeaning)
    });
  }
  if (
    value.changeKind === "relationship_confirmed" ||
    value.changeKind === "relationship_removed"
  ) {
    if (!CHAT_STRUCTURAL_RELATION_TYPES.includes(
      value.relationType as ChatStructuralRelationType
    )) {
      throw new Error("Unsupported structural relation type.");
    }
    return deepFreeze({
      ...common,
      changeKind: value.changeKind,
      sourceConceptQuery: requireLabel(
        "Source concept query",
        value.sourceConceptQuery
      ),
      targetConceptQuery: requireLabel(
        "Target concept query",
        value.targetConceptQuery
      ),
      relationType: value.relationType as ChatStructuralRelationType
    });
  }
  if (value.changeKind === "concept_distinction") {
    return deepFreeze({
      ...common,
      changeKind: "concept_distinction" as const,
      sourceConceptQuery: requireLabel(
        "Source concept query",
        value.sourceConceptQuery
      ),
      targetConceptQuery: requireLabel(
        "Target concept query",
        value.targetConceptQuery
      ),
      distinctionText: requireText(
        "Distinction text",
        value.distinctionText,
        500
      )
    });
  }
  if (value.changeKind === "ambiguity_resolved") {
    return deepFreeze({
      ...common,
      changeKind: "ambiguity_resolved" as const,
      sourceConceptQuery: requireLabel(
        "Source concept query",
        value.sourceConceptQuery
      ),
      selectedConceptQuery: requireLabel(
        "Selected concept query",
        value.selectedConceptQuery
      ),
      ambiguityLabel: requireLabel("Ambiguous label", value.ambiguityLabel)
    });
  }
  return Object.freeze({ kind: "no_meaningful_change" });
}

// ── Scoped-binding durability gate ─────────────────────────────────────
//
// LOCAL DISCOURSE MEANING != PERSONAL SEMANTIC MEANING.
//
// Binder statements introduce or constrain a symbol inside a LOCAL
// reasoning scope. They do not, by themselves, establish durable personal
// semantics:
//   "设 X 为一个未知变量" / "令 G 为一个群" / "记 f 为这个映射" /
//   "假设 n 是偶数" / "let x be a group" / "let x = 3"
//
// They must not create a personal_definition proposal like
// "Concept X → userDefinition: unknown variable". A personal_definition
// whose entire evidence is binder-framed is downgraded to
// no_meaningful_change. Durable framing ("以后我说 X 就是指…",
// "对我来说 X 一直表示…") keeps the proposal alive.
//
// Guards keep compound words out of the verb set (设计/设想/设定,
// 记住/记录/记得, 命令/下令). Symbols are short Latin tokens, matching
// the mathematical binder use. Quotes are exact substrings of user
// messages.

export const SCOPED_BINDING_PATTERN = new RegExp([
  // 设 X 为 Y / 令 G 为 Y / 记 f 为 Y
  // (no \b after 为/是: between two CJK word chars there is no boundary)
  "(?:^|[，。！？;；\\s])" +
    "(?:设(?!计|想|法|置|备|立|定)" +
    "|令(?!人|牌|状)" +
    "|记(?!住|忆|录|得|载))" +
    "\\s*[A-Za-z][A-Za-z0-9_']{0,7}\\s*(?:为|是)",
  // 假设 n 是偶数 / 假设 n 为 0
  "(?:^|[，。！？;；\\s])假设\\s*[A-Za-z][A-Za-z0-9_']{0,7}\\s*(?:是|为)",
  // let x be … / let x = …
  "\\blet\\s+[A-Za-z_][A-Za-z0-9_']{0,7}\\s*(?:be\\b|=)"
].join("|"), "iu");

/**
 * Concept-linked durable/personal semantic FRAMES.
 *
 * Proximity/co-occurrence is not a semantic relation. A durable/personal
 * marker counts as evidence about the proposal's concept only when the
 * concept occupies the semantic subject/referent position of a recognized
 * frame. Comma-joined clauses like "设 X 为一个未知变量，这个问题对我来
 * 说很难。" put X and the marker in one clause without the marker framing
 * X — such text stays binder-only. False negatives are safer than
 * manufacturing a durable personal definition from local mathematical
 * syntax.
 */
const PERSONAL_FRAME_MARKERS = "(?:对我来说|对我而言|在我看来)";
const SEMANTIC_LINK_VERBS =
  "(?:就是指|是指|表示|代表|意味着|指|就是|是|为)";

/** Clause boundaries: sentence punctuation and line breaks, never commas. */
const CLAUSE_SPLIT_PATTERN = /[。！？!?；;\n.]+/u;

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * One recognizer per preserved frame shape, with the proposal's concept
 * symbol in the subject/referent position:
 *   对我来说，X 是某种自由。            X 对我来说是某种自由。
 *   以后我说 X，就是指未知变量。        X 一直表示未知变量。
 *   X 的定义是未知变量。                For me, x represents freedom.
 */
function conceptLinkedSemanticFramePattern(conceptQuery: string): RegExp {
  const normalized = conceptQuery.normalize("NFKC").trim();
  const latin = /^[A-Za-z_][A-Za-z0-9_']{0,7}$/iu.test(normalized);
  const literal = escapeRegExpLiteral(normalized);
  // Anchored symbol: needs its own boundary (frame provides none before).
  const symbolAnchored = latin
    ? `(?:^|[^a-z0-9])${literal}(?:[^a-z0-9]|$)`
    : literal;
  // Suffix-only symbol: a frame separator/gap class already precedes it,
  // so a leading boundary would conflict with the class it consumed.
  const symbolSuffix = latin
    ? `${literal}(?:[^a-z0-9]|$)`
    : literal;
  const frames = [
    // marker first: 对我来说，X 是某种自由。
    `${PERSONAL_FRAME_MARKERS}[，,\\s]+${symbolSuffix}` +
      `\\s*${SEMANTIC_LINK_VERBS}`,
    // symbol first: X 对我来说是某种自由。
    `${symbolAnchored}[，,\\s]{0,3}${PERSONAL_FRAME_MARKERS}` +
      `[，,\\s]{0,3}${SEMANTIC_LINK_VERBS}`,
    // durable, marker first: 以后我说 X，就是指未知变量。
    `(?:以后|从现在起|通常)[^。！？!?；;\\n]{0,10}${symbolSuffix}` +
      `[，,\\s]*${SEMANTIC_LINK_VERBS}`,
    // durable, symbol first: X 一直表示未知变量。
    `${symbolAnchored}[，,\\s]{0,3}(?:一直|总是|通常)` +
      `[，,\\s]{0,3}${SEMANTIC_LINK_VERBS}`,
    // definitional: X 的定义是未知变量。
    `${symbolAnchored}[，,\\s]{0,3}(?:的|之)?定义[，,\\s]{0,3}(?:是|为|就是)`,
    // English: For me, x represents freedom.
    // (\s* after the symbol: its trailing boundary already consumed the
    // separating space.)
    `\\bfor\\s+me[，,\\s]+${symbolSuffix}\\s*` +
    "(?:is|means|represents|stands\\s+for)\\b"
  ];
  return new RegExp(`(?:${frames.join("|")})`, latin ? "iu" : "u");
}

/**
 * True when some clause of the text carries a recognized durable/personal
 * frame whose subject/referent is the proposal's concept symbol.
 */
function hasDurablePersonalSemanticsForConcept(
  text: string,
  conceptQuery: string
): boolean {
  const frame = conceptLinkedSemanticFramePattern(conceptQuery);
  return text
    .split(CLAUSE_SPLIT_PATTERN)
    .some((clause) => frame.test(clause));
}

/** Does this user text carry a scoped-binding frame? */
export function isScopedBindingStatement(text: string): boolean {
  return SCOPED_BINDING_PATTERN.test(text);
}

function isScopedBindingOnly(text: string, conceptQuery: string): boolean {
  return isScopedBindingStatement(text) &&
    !hasDurablePersonalSemanticsForConcept(text, conceptQuery);
}

function evidenceQuote(
  span: Readonly<UserTextProvenance>,
  request: Readonly<ChatSemanticDeltaAnalysisRequest>
): string | undefined {
  if (span.sourceKind !== "message_span") {
    return undefined;
  }
  if (span.startOffset === undefined || span.endOffset === undefined) {
    return undefined;
  }
  const message = request.conversation.find(
    (candidate) => candidate.id === span.messageId
  );
  if (message === undefined) {
    return undefined;
  }
  return message.content.slice(span.startOffset, span.endOffset);
}

/**
 * True when the proposal's entire evidence support is binder-framed:
 * every quoted span is a scoped binding (with no concept-linked durable
 * framing), or all evidence comes from the current user message and that
 * whole message is a scoped binding. The fallback catches partial quotes
 * that omit the binder word ("X 为一个未知变量" quoted out of "设 X 为一
 * 个未知变量").
 */
function isExclusivelyScopedBindingEvidence(
  evidence: readonly UserTextProvenance[],
  request: Readonly<ChatSemanticDeltaAnalysisRequest>,
  conceptQuery: string
): boolean {
  if (evidence.length === 0) {
    return false;
  }
  const quotes = evidence
    .map((span) => evidenceQuote(span, request))
    .filter((quote): quote is string => quote !== undefined);
  if (quotes.length === 0) {
    return false;
  }
  if (quotes.every((quote) => isScopedBindingOnly(quote, conceptQuery))) {
    return true;
  }
  const current = request.conversation.find(
    (message) => message.id === request.currentUserMessageId
  );
  if (current === undefined || current.role !== "user") {
    return false;
  }
  if (!isScopedBindingOnly(current.content, conceptQuery)) {
    return false;
  }
  return evidence.every(
    (span) =>
      span.sourceKind === "message_span" &&
      span.messageId === request.currentUserMessageId
  );
}

function sourceMessageIds(evidence: readonly UserTextProvenance[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of evidence) {
    if (item.sourceKind === "message_span" && !seen.has(item.messageId)) {
      seen.add(item.messageId);
      result.push(item.messageId);
    }
  }
  return result;
}

function choiceFor(
  conceptId: string,
  records: readonly ChatSemanticDeltaConceptRecord[]
): ChatSemanticDeltaConceptChoice | undefined {
  const matches = records.filter((record) => record.concept.id === conceptId);
  if (matches.length !== 1) {
    return undefined;
  }
  const match = matches[0]!;
  return deepFreeze({
    conceptId: match.concept.id,
    title: match.concept.title,
    revision: match.concept.revision,
    vaultPath: match.vaultPath,
    ...(match.concept.userDefinition === undefined
      ? {}
      : { previousMeaning: match.concept.userDefinition.text })
  });
}

function resolveParticipant(
  query: string,
  index: Readonly<ConceptIndex>,
  records: readonly ChatSemanticDeltaConceptRecord[]
): ChatSemanticDeltaProposalTarget {
  const lookup = lookupConcept(index, query);
  if (lookup.kind === "unique_match") {
    const choice = choiceFor(lookup.match.concept.id, records);
    if (choice !== undefined) {
      return deepFreeze({ kind: "known_concept" as const, ...choice });
    }
  } else if (lookup.kind === "ambiguous_matches") {
    const choices = lookup.matches
      .map((match) => choiceFor(match.concept.id, records))
      .filter((choice): choice is ChatSemanticDeltaConceptChoice =>
        choice !== undefined
      );
    if (choices.length > 1) {
      return deepFreeze({
        kind: "ambiguous_concept" as const,
        query,
        choices
      });
    }
  }
  return deepFreeze({ kind: "new_concept" as const, suggestedTitle: query });
}

function participantIdentity(
  target: Readonly<ChatSemanticDeltaProposalTarget>
): string {
  return target.kind === "known_concept"
    ? `${target.conceptId}@${target.revision}`
    : target.kind === "ambiguous_concept"
      ? `ambiguous:${target.choices
          .map((choice) => choice.conceptId)
          .sort()
          .join("|")}`
      : `new:${target.suggestedTitle.normalize("NFKC").trim()}`;
}

function proposalFingerprint(input: {
  readonly changeKind: ChatSemanticDeltaChangeKind;
  readonly target: ChatSemanticDeltaProposalTarget;
  readonly secondaryTarget?: ChatSemanticDeltaProposalTarget;
  readonly relationType?: ChatSemanticDeltaProposal["relationType"];
  readonly proposedMeaning: string;
  readonly ambiguityLabel?: string;
  readonly sourceMessageIds: readonly string[];
}): string {
  return stableHash(JSON.stringify({
    category: input.changeKind,
    source: participantIdentity(input.target),
    target: input.secondaryTarget === undefined
      ? undefined
      : participantIdentity(input.secondaryTarget),
    relationType: input.relationType,
    proposedMeaning: input.proposedMeaning.normalize("NFKC").trim(),
    ambiguityLabel: input.ambiguityLabel,
    sourceIds: input.sourceMessageIds
  }));
}

/** Resolve model-proposed labels only through the existing conservative index. */
export function createChatSemanticDeltaProposal(
  analysis: Readonly<ChatSemanticDeltaAnalysis>,
  index: Readonly<ConceptIndex>,
  records: readonly ChatSemanticDeltaConceptRecord[],
  input: { readonly createdAt: string; readonly createdAtUserTurn: number }
): ChatSemanticDeltaProposalResult {
  if (analysis.kind === "no_meaningful_change") {
    return Object.freeze({ kind: "no_proposal" });
  }
  if (analysis.kind === "ambiguous_change") {
    return Object.freeze({ kind: "ambiguous_change", reason: analysis.reason });
  }
  let target: ChatSemanticDeltaProposalTarget;
  let secondaryTarget: ChatSemanticDeltaProposalTarget | undefined;
  let proposedMeaning: string;
  let relationType: ChatSemanticDeltaProposal["relationType"];
  let ambiguityLabel: string | undefined;

  if (analysis.changeKind === "personal_definition") {
    target = resolveParticipant(analysis.conceptQuery, index, records);
    if (
      target.kind === "known_concept" &&
      target.previousMeaning?.trim() === analysis.proposedMeaning.trim()
    ) {
      return Object.freeze({ kind: "no_proposal" });
    }
    proposedMeaning = analysis.proposedMeaning;
  } else {
    target = resolveParticipant(
      analysis.sourceConceptQuery,
      index,
      records
    );
    const secondaryQuery = analysis.changeKind === "ambiguity_resolved"
      ? analysis.selectedConceptQuery
      : analysis.targetConceptQuery;
    secondaryTarget = resolveParticipant(secondaryQuery, index, records);
    if (participantIdentity(target) === participantIdentity(secondaryTarget)) {
      return Object.freeze({
        kind: "ambiguous_change",
        reason: "A structural change requires two distinct concepts."
      });
    }
    if (
      analysis.changeKind === "relationship_confirmed" ||
      analysis.changeKind === "relationship_removed"
    ) {
      relationType = analysis.relationType;
      proposedMeaning = analysis.relationType;
      if (
        analysis.changeKind === "relationship_removed" &&
        (target.kind === "new_concept" ||
          secondaryTarget.kind === "new_concept")
      ) {
        return Object.freeze({ kind: "no_proposal" });
      }
    } else if (analysis.changeKind === "concept_distinction") {
      relationType = CHAT_DISTINCTION_RELATION;
      proposedMeaning = analysis.distinctionText;
    } else if (analysis.changeKind === "ambiguity_resolved") {
      ambiguityLabel = analysis.ambiguityLabel;
      proposedMeaning = analysis.ambiguityLabel;
      if (
        target.kind === "new_concept" ||
        secondaryTarget.kind === "new_concept"
      ) {
        return Object.freeze({ kind: "no_proposal" });
      }
    } else {
      return Object.freeze({ kind: "no_proposal" });
    }
  }
  const sourceIds = sourceMessageIds(analysis.evidence);
  const fingerprint = proposalFingerprint({
    changeKind: analysis.changeKind,
    target,
    ...(secondaryTarget === undefined ? {} : { secondaryTarget }),
    relationType,
    proposedMeaning,
    ambiguityLabel,
    sourceMessageIds: sourceIds
  });
  return Object.freeze({
    kind: "proposal",
    proposal: deepFreeze({
      schemaVersion: CHAT_SEMANTIC_DELTA_SCHEMA_VERSION,
      authority: "proposed" as const,
      id: `chat-semantic-delta:${fingerprint}`,
      fingerprint,
      status: "active" as const,
      changeKind: analysis.changeKind,
      target,
      ...(secondaryTarget === undefined ? {} : { secondaryTarget }),
      ...(relationType === undefined ? {} : { relationType }),
      ...(ambiguityLabel === undefined ? {} : { ambiguityLabel }),
      proposedMeaning,
      reason: analysis.reason,
      confidence: analysis.confidence,
      evidence: analysis.evidence,
      sourceMessageIds: sourceIds,
      createdAt: input.createdAt,
      createdAtUserTurn: input.createdAtUserTurn
    })
  });
}

export function selectChatSemanticDeltaParticipant(
  proposal: Readonly<ChatSemanticDeltaProposal>,
  participant: "source" | "target",
  conceptId: string
): ChatSemanticDeltaProposal | undefined {
  if (proposal.status !== "active") return undefined;
  const current = participant === "source"
    ? proposal.target
    : proposal.secondaryTarget;
  if (current?.kind !== "ambiguous_concept") return undefined;
  const choice = current.choices.find((item) => item.conceptId === conceptId);
  if (choice === undefined) return undefined;
  const revised = participant === "source"
    ? { ...proposal, target: { kind: "known_concept" as const, ...choice } }
    : {
        ...proposal,
        secondaryTarget: { kind: "known_concept" as const, ...choice }
      };
  const fingerprint = proposalFingerprint(revised);
  return deepFreeze({
    ...revised,
    id: `chat-semantic-delta:${fingerprint}`,
    fingerprint
  });
}

export function selectChatSemanticDeltaConcept(
  proposal: Readonly<ChatSemanticDeltaProposal>,
  conceptId: string
): ChatSemanticDeltaProposal | undefined {
  return selectChatSemanticDeltaParticipant(proposal, "source", conceptId);
}

/** User-reviewed relation correction; still proposal-only until Confirm. */
export function setChatSemanticDeltaRelationType(
  proposal: Readonly<ChatSemanticDeltaProposal>,
  relationType: ChatStructuralRelationType
): ChatSemanticDeltaProposal | undefined {
  if (
    proposal.status !== "active" ||
    (
      proposal.changeKind !== "relationship_confirmed" &&
      proposal.changeKind !== "relationship_removed"
    ) ||
    !CHAT_STRUCTURAL_RELATION_TYPES.includes(relationType)
  ) {
    return undefined;
  }
  const revised = {
    ...proposal,
    relationType,
    proposedMeaning: relationType
  };
  const fingerprint = proposalFingerprint(revised);
  return deepFreeze({
    ...revised,
    id: `chat-semantic-delta:${fingerprint}`,
    fingerprint
  });
}

export function transitionChatSemanticDeltaProposal(
  proposal: Readonly<ChatSemanticDeltaProposal>,
  status: Exclude<ChatSemanticDeltaProposalStatus, "active">,
  statusMessage?: string
): ChatSemanticDeltaProposal {
  if (proposal.status !== "active") {
    return proposal as ChatSemanticDeltaProposal;
  }
  return deepFreeze({
    ...proposal,
    status,
    ...(statusMessage === undefined ? {} : { statusMessage })
  });
}
