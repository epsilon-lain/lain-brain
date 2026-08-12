import type {
  ActivatedContextContentPart,
  ActivatedContextDiagnosticCode,
  ActivatedContextTargetResolution,
  ActivatedSemanticEpisodeContextResolver,
  ActivatedSemanticEpisodeContextResolverSession
} from "./ActivatedContextMaterialization";
import type { SemanticPriorEpisode } from "./SemanticPrior";
import type {
  SemanticAmbiguity,
  SemanticExpression,
  SemanticSpec,
  SemanticStatement,
  SemanticSymbol
} from "./SemanticSpec";
import type { UserTextProvenance } from "./KnowledgeProtocol";

export type SemanticPriorEpisodeByIdResolver = (
  episodeId: string
) => Readonly<SemanticPriorEpisode> | undefined;

function cloneStringArray(values: readonly string[]): readonly string[] {
  return [...values];
}

function projectSymbol(symbol: Readonly<SemanticSymbol>): object {
  return {
    id: symbol.id,
    surface: symbol.surface,
    role: symbol.role,
    ...(symbol.description === undefined
      ? {} : { description: symbol.description }),
    ...(symbol.userDefined === undefined
      ? {} : { userDefined: symbol.userDefined })
  };
}

function projectExpression(expression: Readonly<SemanticExpression>): object {
  return {
    id: expression.id,
    kind: expression.kind,
    ...(expression.symbolId === undefined
      ? {} : { symbolId: expression.symbolId }),
    ...(expression.value === undefined
      ? {} : { value: expression.value }),
    ...(expression.operatorSymbolId === undefined
      ? {} : { operatorSymbolId: expression.operatorSymbolId }),
    ...(expression.argumentExprIds === undefined
      ? {} : { argumentExprIds: cloneStringArray(expression.argumentExprIds) }),
    ...(expression.leftExprId === undefined
      ? {} : { leftExprId: expression.leftExprId }),
    ...(expression.rightExprId === undefined
      ? {} : { rightExprId: expression.rightExprId }),
    ...(expression.elementExprId === undefined
      ? {} : { elementExprId: expression.elementExprId }),
    ...(expression.collectionExprId === undefined
      ? {} : { collectionExprId: expression.collectionExprId }),
    ...(expression.operandExprId === undefined
      ? {} : { operandExprId: expression.operandExprId }),
    ...(expression.operandExprIds === undefined
      ? {} : { operandExprIds: cloneStringArray(expression.operandExprIds) }),
    ...(expression.binderSymbolId === undefined
      ? {} : { binderSymbolId: expression.binderSymbolId }),
    ...(expression.bodyExprId === undefined
      ? {} : { bodyExprId: expression.bodyExprId }),
    ...(expression.domainExprId === undefined
      ? {} : { domainExprId: expression.domainExprId }),
    ...(expression.targetId === undefined
      ? {} : { targetId: expression.targetId }),
    ...(expression.targetKind === undefined
      ? {} : { targetKind: expression.targetKind }),
    ...(expression.label === undefined
      ? {} : { label: expression.label })
  };
}

function projectStatement(statement: Readonly<SemanticStatement>): object {
  return {
    id: statement.id,
    kind: statement.kind,
    ...(statement.subjectSymbolId === undefined
      ? {} : { subjectSymbolId: statement.subjectSymbolId }),
    ...(statement.bodyExprId === undefined
      ? {} : { bodyExprId: statement.bodyExprId }),
    ...(statement.premiseExprIds === undefined
      ? {} : { premiseExprIds: cloneStringArray(statement.premiseExprIds) }),
    ...(statement.conclusionExprId === undefined
      ? {} : { conclusionExprId: statement.conclusionExprId }),
    ...(statement.exprId === undefined
      ? {} : { exprId: statement.exprId }),
    ...(statement.description === undefined
      ? {} : { description: statement.description })
  };
}

function projectAmbiguity(ambiguity: Readonly<SemanticAmbiguity>): object {
  return {
    id: ambiguity.id,
    kind: ambiguity.kind,
    question: ambiguity.question,
    affectedIds: cloneStringArray(ambiguity.affectedIds),
    blocking: ambiguity.blocking,
    ...(ambiguity.choices === undefined
      ? {}
      : {
          choices: ambiguity.choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
            ...(choice.description === undefined
              ? {} : { description: choice.description })
          }))
        })
  };
}

/**
 * Stable, explicit AI-interpretation projection. Provenance, user resolutions,
 * patches, timestamps, review state, anchors, and future fields are excluded.
 */
export function serializeProvisionalSemanticSpec(
  spec: Readonly<SemanticSpec>
): string {
  const projection = {
    ...(spec.description === undefined
      ? {} : { description: spec.description }),
    symbols: spec.symbols.map(projectSymbol),
    expressions: spec.expressions.map(projectExpression),
    statements: spec.statements.map(projectStatement),
    ambiguities: spec.ambiguities.map(projectAmbiguity)
  };

  return JSON.stringify(projection);
}

function evidenceText(
  evidence: Readonly<UserTextProvenance>
): string | undefined {
  if (typeof evidence.snapshot !== "string") {
    return undefined;
  }
  if (evidence.sourceKind === "user_edit") {
    return evidence.snapshot;
  }

  const hasStart = evidence.startOffset !== undefined;
  const hasEnd = evidence.endOffset !== undefined;
  if (!hasStart && !hasEnd) {
    return evidence.snapshot;
  }
  if (!hasStart || !hasEnd) {
    return undefined;
  }

  const start = evidence.startOffset!;
  const end = evidence.endOffset!;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > end ||
    end > evidence.snapshot.length
  ) {
    return undefined;
  }
  return evidence.snapshot.slice(start, end);
}

function evidencePart(
  episodeId: string,
  evidence: Readonly<UserTextProvenance>,
  evidenceIndex: number,
  text: string
): ActivatedContextContentPart {
  return Object.freeze({
    sourceRole: "user_evidence",
    text,
    provenance: evidence.sourceKind === "message_span"
      ? Object.freeze({
          kind: "episode_evidence",
          episodeId,
          evidenceIndex,
          messageId: evidence.messageId,
          ...(evidence.startOffset === undefined
            ? {} : { startOffset: evidence.startOffset }),
          ...(evidence.endOffset === undefined
            ? {} : { endOffset: evidence.endOffset })
        })
      : Object.freeze({
          kind: "episode_evidence",
          episodeId,
          evidenceIndex,
          editId: evidence.editId
        }),
    truncated: false
  });
}

function resolveEpisode(
  episodeId: string,
  lookup: SemanticPriorEpisodeByIdResolver
): ActivatedContextTargetResolution {
  const episode = lookup(episodeId);
  if (episode === undefined || episode.id !== episodeId) {
    const code: ActivatedContextDiagnosticCode = "episode_missing";
    return Object.freeze({
      contentParts: Object.freeze([]),
      diagnostics: Object.freeze([code])
    });
  }

  const parts: ActivatedContextContentPart[] = [];
  const diagnostics: ActivatedContextDiagnosticCode[] = [];

  for (let index = 0; index < episode.evidenceRefs.length; index++) {
    const evidence = episode.evidenceRefs[index]!;
    const text = evidenceText(evidence);
    if (text === undefined) {
      diagnostics.push("invalid_evidence");
      continue;
    }
    if (text.length > 0) {
      parts.push(evidencePart(episode.id, evidence, index, text));
    }
  }

  const interpretation = serializeProvisionalSemanticSpec(
    episode.semanticSpec
  );
  if (interpretation.length > 0) {
    parts.push(Object.freeze({
      sourceRole: "provisional_semantic_interpretation",
      text: interpretation,
      provenance: Object.freeze({
        kind: "episode_interpretation",
        episodeId: episode.id,
        semanticSpecId: episode.semanticSpec.id
      }),
      truncated: false
    }));
  }

  return Object.freeze({
    contentParts: Object.freeze(parts),
    ...(diagnostics.length === 0
      ? {} : { diagnostics: Object.freeze(diagnostics) })
  });
}

/** Exact-ID episode adapter. Relevance selection remains entirely upstream. */
export function createSemanticPriorActivatedContextResolver(
  lookup: SemanticPriorEpisodeByIdResolver
): ActivatedSemanticEpisodeContextResolver {
  return Object.freeze({
    beginMaterialization(): ActivatedSemanticEpisodeContextResolverSession {
      return Object.freeze({
        async resolveSemanticEpisode(
          episodeId: string
        ): Promise<ActivatedContextTargetResolution> {
          return resolveEpisode(episodeId, lookup);
        }
      });
    }
  });
}
