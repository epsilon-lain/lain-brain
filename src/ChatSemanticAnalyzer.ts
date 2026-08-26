import { requestDeepSeek } from "./DeepSeekClient";
import type { DeepSeekConversationMessage } from "./DeepSeekClient";
import type { ChatSemanticSession } from "./ChatSemanticSession";
import {
  AMBIGUITY_KINDS,
  EXPRESSION_KINDS,
  SEMANTIC_ROLES,
  STATEMENT_KINDS,
  createSemanticSpec
} from "./SemanticSpec";
import type {
  AmbiguityKind,
  ExpressionKind,
  SemanticAmbiguity,
  SemanticExpression,
  SemanticRole,
  SemanticSpec,
  SemanticStatement,
  SemanticSymbol,
  StatementKind
} from "./SemanticSpec";

export interface ChatSemanticEvidence {
  readonly messageId: string;
  readonly text: string;
}

export interface ChatSemanticAnalysisRequest {
  readonly semanticSessionId: string;
  readonly conversation: readonly DeepSeekConversationMessage[];
  readonly userEvidence: readonly ChatSemanticEvidence[];
  readonly latestAssistantResponse: string;
  readonly currentSession?: Readonly<ChatSemanticSession>;
  /**
   * M2B.6a-v0: temporary advisory sense context for this exchange.
   * Context for the provisional hypothesis only — never user evidence,
   * never persisted.
   */
  readonly senseContext?: string;
}

export type ChatSemanticAnalyzer = (
  apiKey: string,
  request: Readonly<ChatSemanticAnalysisRequest>
) => Promise<SemanticSpec>;

interface SemanticAnalysisJson {
  description?: unknown;
  symbols?: unknown;
  expressions?: unknown;
  statements?: unknown;
  ambiguities?: unknown;
}

const GENERIC_CONFIRMATION =
  /(?:is this correct|does this match|please confirm|confirm my understanding)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 5000
): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  const result = value.trim();
  if (result === "" || result.length > maxLength) {
    throw new Error(`${field} is invalid.`);
  }
  return result;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  return value.map((item, index) =>
    requiredString(item, `${field}.${index}`, 500));
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} is invalid.`);
  }
  return value as T;
}

function optionalStringArray(
  value: unknown,
  field: string
): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, field);
}

function parseSymbol(
  value: unknown,
  index: number,
  sourceRefByMessageId: ReadonlyMap<string, string>,
  allSourceRefIds: readonly string[]
): SemanticSymbol {
  if (!isRecord(value)) {
    throw new Error(`symbols.${index} must be an object.`);
  }
  const requestedMessageIds = optionalStringArray(
    value.sourceMessageIds,
    `symbols.${index}.sourceMessageIds`
  );
  const sourceRefIds = requestedMessageIds === undefined
    ? [...allSourceRefIds]
    : requestedMessageIds.map((messageId) => {
        const sourceRefId = sourceRefByMessageId.get(messageId);
        if (sourceRefId === undefined) {
          throw new Error(`symbols.${index} cites an unknown message.`);
        }
        return sourceRefId;
      });
  if (sourceRefIds.length === 0) {
    throw new Error(`symbols.${index} has no user evidence.`);
  }
  return {
    id: requiredString(value.id, `symbols.${index}.id`, 200),
    surface: requiredString(value.surface, `symbols.${index}.surface`, 1000),
    role: oneOf<SemanticRole>(
      value.role,
      SEMANTIC_ROLES,
      `symbols.${index}.role`
    ),
    description: optionalString(
      value.description,
      `symbols.${index}.description`
    ),
    userDefined: value.userDefined === true,
    sourceRefIds
  };
}

function parseExpression(value: unknown, index: number): SemanticExpression {
  if (!isRecord(value)) {
    throw new Error(`expressions.${index} must be an object.`);
  }
  const expression: SemanticExpression = {
    id: requiredString(value.id, `expressions.${index}.id`, 200),
    kind: oneOf<ExpressionKind>(
      value.kind,
      EXPRESSION_KINDS,
      `expressions.${index}.kind`
    ),
    symbolId: optionalString(value.symbolId, `expressions.${index}.symbolId`),
    value: optionalString(value.value, `expressions.${index}.value`),
    operatorSymbolId: optionalString(
      value.operatorSymbolId,
      `expressions.${index}.operatorSymbolId`
    ),
    argumentExprIds: optionalStringArray(
      value.argumentExprIds,
      `expressions.${index}.argumentExprIds`
    ),
    leftExprId: optionalString(value.leftExprId, `expressions.${index}.leftExprId`),
    rightExprId: optionalString(value.rightExprId, `expressions.${index}.rightExprId`),
    elementExprId: optionalString(value.elementExprId, `expressions.${index}.elementExprId`),
    collectionExprId: optionalString(value.collectionExprId, `expressions.${index}.collectionExprId`),
    operandExprId: optionalString(value.operandExprId, `expressions.${index}.operandExprId`),
    operandExprIds: optionalStringArray(value.operandExprIds, `expressions.${index}.operandExprIds`),
    binderSymbolId: optionalString(value.binderSymbolId, `expressions.${index}.binderSymbolId`),
    bodyExprId: optionalString(value.bodyExprId, `expressions.${index}.bodyExprId`),
    domainExprId: optionalString(value.domainExprId, `expressions.${index}.domainExprId`),
    targetId: optionalString(value.targetId, `expressions.${index}.targetId`),
    targetKind: optionalString(value.targetKind, `expressions.${index}.targetKind`),
    label: optionalString(value.label, `expressions.${index}.label`)
  };
  return expression;
}

function parseStatement(value: unknown, index: number): SemanticStatement {
  if (!isRecord(value)) {
    throw new Error(`statements.${index} must be an object.`);
  }
  return {
    id: requiredString(value.id, `statements.${index}.id`, 200),
    kind: oneOf<StatementKind>(
      value.kind,
      STATEMENT_KINDS,
      `statements.${index}.kind`
    ),
    subjectSymbolId: optionalString(value.subjectSymbolId, `statements.${index}.subjectSymbolId`),
    bodyExprId: optionalString(value.bodyExprId, `statements.${index}.bodyExprId`),
    premiseExprIds: optionalStringArray(value.premiseExprIds, `statements.${index}.premiseExprIds`),
    conclusionExprId: optionalString(value.conclusionExprId, `statements.${index}.conclusionExprId`),
    exprId: optionalString(value.exprId, `statements.${index}.exprId`),
    description: optionalString(value.description, `statements.${index}.description`)
  };
}

function parseAmbiguity(value: unknown, index: number): SemanticAmbiguity {
  if (!isRecord(value)) {
    throw new Error(`ambiguities.${index} must be an object.`);
  }
  const choices = value.choices === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(value.choices)) {
          throw new Error(`ambiguities.${index}.choices must be an array.`);
        }
        return value.choices.map((choice, choiceIndex) => {
          if (!isRecord(choice)) {
            throw new Error(`ambiguities.${index}.choices.${choiceIndex} must be an object.`);
          }
          return {
            id: requiredString(choice.id, `ambiguities.${index}.choices.${choiceIndex}.id`, 200),
            label: requiredString(choice.label, `ambiguities.${index}.choices.${choiceIndex}.label`, 1000),
            description: optionalString(choice.description, `ambiguities.${index}.choices.${choiceIndex}.description`)
          };
        });
      })();
  const question = requiredString(
    value.question,
    `ambiguities.${index}.question`,
    1000
  );
  const requestedBlocking = value.blocking === true;
  const blocking = requestedBlocking &&
    choices !== undefined && choices.length >= 2 &&
    !GENERIC_CONFIRMATION.test(question);
  return {
    id: requiredString(value.id, `ambiguities.${index}.id`, 200),
    kind: oneOf<AmbiguityKind>(
      value.kind,
      AMBIGUITY_KINDS,
      `ambiguities.${index}.kind`
    ),
    question,
    affectedIds: stringArray(
      value.affectedIds,
      `ambiguities.${index}.affectedIds`
    ),
    blocking,
    choices
  };
}

function parseJsonObject(raw: string): SemanticAnalysisJson {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
    throw new Error("Semantic analysis must be strict JSON.");
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (!isRecord(parsed)) {
    throw new Error("Semantic analysis must be a JSON object.");
  }
  return parsed;
}

export function parseChatSemanticAnalysisJson(
  raw: string,
  evidence: readonly ChatSemanticEvidence[],
  claimId: string
): SemanticSpec {
  if (evidence.length === 0) {
    throw new Error("Semantic analysis requires user evidence.");
  }
  const parsed = parseJsonObject(raw);
  if (!Array.isArray(parsed.symbols) ||
      !Array.isArray(parsed.expressions) ||
      !Array.isArray(parsed.statements) ||
      !Array.isArray(parsed.ambiguities)) {
    throw new Error("Semantic analysis arrays are missing.");
  }
  const sourceRefs = evidence.map((item, index) => ({
    id: `chat-source-${index + 1}-${item.messageId}`,
    messageId: item.messageId,
    snapshot: item.text
  }));
  const sourceRefByMessageId = new Map(
    sourceRefs.map((sourceRef) => [sourceRef.messageId, sourceRef.id])
  );
  const allSourceRefIds = sourceRefs.map((sourceRef) => sourceRef.id);
  return createSemanticSpec({
    claimId,
    sourceRefs,
    symbols: parsed.symbols.map((item, index) =>
      parseSymbol(item, index, sourceRefByMessageId, allSourceRefIds)),
    expressions: parsed.expressions.map(parseExpression),
    statements: parsed.statements.map(parseStatement),
    ambiguities: parsed.ambiguities.map(parseAmbiguity),
    description: optionalString(parsed.description, "description")
  });
}

export function createChatSemanticAnalysisSystemPrompt(): string {
  return [
    "Maintain an invisible, provisional semantic hypothesis for an ordinary chat.",
    "This is analysis only: do not answer the user, create a UserConclusion, create a Candidate Note, classify claims, write to a Vault, invoke Lean, verify truth, or create empirical evidence.",
    "Preserve exact user wording in source snapshots and retain the user's coined names and linguistic relations. Mark a coined concept or relation userDefined=true instead of forcing a standard mathematical interpretation. A possible relation to a standard concept is only a mapping or analogy hypothesis, never automatic identity.",
    "Use the complete supplied conversation and current hypothesis. Later user messages may revise the hypothesis; do not request accept/reject confirmation.",
    "A blocking ambiguity is rare. Use blocking=true only when at least two plausible interpretations remain after using conversation context and their difference would materially change the next reasoning or action. A merely new, informal, metaphorical, or undefined user term is not blocking.",
    "Every blocking ambiguity must ask one concrete missing question and include at least two specific choices. Never ask generic questions such as 'Is this correct?' or 'Please confirm my understanding'.",
    "Return strict JSON only, without Markdown fences. Use this shape:",
    '{"description":"current working meaning","symbols":[{"id":"stable-id","surface":"exact user term","role":"unresolved|concept|entity|variable|domain|collection|function|relation|predicate|operator|proposition","description":"optional","userDefined":false,"sourceMessageIds":["message-id"]}],"expressions":[{"id":"stable-id","kind":"symbol_ref|literal|application|equals|membership|not|and|or|implies|iff|forall|exists|reference","symbolId":"optional","value":"optional","operatorSymbolId":"optional","argumentExprIds":[],"leftExprId":"optional","rightExprId":"optional","operandExprId":"optional","operandExprIds":[],"binderSymbolId":"optional","bodyExprId":"optional","domainExprId":"optional","targetId":"optional","targetKind":"optional"}],"statements":[{"id":"stable-id","kind":"assertion|definition|rule","exprId":"optional","subjectSymbolId":"optional","bodyExprId":"optional","premiseExprIds":[],"conclusionExprId":"optional","description":"optional"}],"ambiguities":[{"id":"stable-id","kind":"symbol_role|domain|operator_meaning|reference_target|quantifier_scope|definition_scope|other","question":"specific question","affectedIds":["id"],"blocking":false,"choices":[{"id":"stable-id","label":"specific interpretation"}]}]}'
  ].join("\n\n");
}

export const analyzeChatSemantics: ChatSemanticAnalyzer = async (
  apiKey,
  request
) => {
  const evidenceBlock = request.userEvidence.map((item) =>
    `[${item.messageId}] ${item.text}`).join("\n\n");
  const currentHypothesis = request.currentSession?.semanticSpec === undefined
    ? "None yet."
    : JSON.stringify(request.currentSession.semanticSpec);
  const senseContextBlock = request.senseContext === undefined
    ? []
    : [
        "Current sense context (temporary, advisory; context only, never user evidence):",
        request.senseContext
      ];
  const response = await requestDeepSeek(apiKey, [
    { role: "system", content: createChatSemanticAnalysisSystemPrompt() },
    {
      role: "user",
      content: [
        "Exact user evidence:",
        evidenceBlock,
        "Current provisional SemanticSpec:",
        currentHypothesis,
        ...senseContextBlock,
        "Conversation (context only):",
        JSON.stringify(request.conversation),
        "Latest assistant response (context only, never user evidence):",
        request.latestAssistantResponse
      ].join("\n\n")
    }
  ]);
  return parseChatSemanticAnalysisJson(
    response,
    request.userEvidence,
    request.semanticSessionId
  );
};
