import type {
  ConceptNode,
  ConceptRelationship,
  ConceptUserDefinition
} from "./BrainGrowth";
import type { UserTextProvenance } from "./KnowledgeProtocol";

export const SEMANTIC_DELTA_SCHEMA_VERSION = 1 as const;

export type SemanticDeltaKind =
  | "personal_definition_created"
  | "personal_definition_redefined"
  | "ambiguity_resolved"
  | "aliases_changed"
  | "relationship_changed";

export type SemanticDeltaValue =
  | {
      readonly kind: "personal_definition";
      readonly definition?: ConceptUserDefinition;
    }
  | {
      readonly kind: "aliases";
      readonly aliases: readonly string[];
    }
  | {
      readonly kind: "relationships";
      readonly relationships: readonly ConceptRelationship[];
    }
  | {
      readonly kind: "ambiguity";
      readonly openItemIds: readonly string[];
    };

export interface ProposedSemanticDelta {
  readonly schemaVersion: typeof SEMANTIC_DELTA_SCHEMA_VERSION;
  readonly authority: "proposed";
  readonly id: string;
  readonly conceptId: string;
  readonly originatingRevision: number;
  readonly resultingRevision: number;
  readonly kind: SemanticDeltaKind;
  readonly previous: SemanticDeltaValue;
  readonly next: SemanticDeltaValue;
  readonly proposedAt: string;
  readonly originRef: string;
  readonly reason: string;
  /** Proposal-only estimate; never grants semantic authority. */
  readonly proposalConfidence?: number;
}

export type PropagationAuthorization =
  | "refresh_relationship_labels"
  | "invalidate_derived_interpretations"
  | "refresh_dependency_revisions"
  | "record_pending_decisions"
  | "record_propagation_provenance";

export interface SemanticDeltaConfirmationProvenance {
  readonly kind: "maintenance_confirmation" | "chat_confirmation";
  readonly confirmationId: string;
  readonly interactionRef: string;
  readonly userEvidence: readonly UserTextProvenance[];
}

export interface ConfirmedSemanticDelta {
  readonly schemaVersion: typeof SEMANTIC_DELTA_SCHEMA_VERSION;
  readonly authority: "user_confirmed";
  readonly id: string;
  readonly conceptId: string;
  readonly originatingRevision: number;
  readonly resultingRevision: number;
  readonly kind: SemanticDeltaKind;
  readonly previous: SemanticDeltaValue;
  readonly next: SemanticDeltaValue;
  readonly proposedAt: string;
  readonly confirmedAt: string;
  readonly originRef: string;
  readonly reason: string;
  readonly confirmation: SemanticDeltaConfirmationProvenance;
  readonly authorization: readonly PropagationAuthorization[];
}

export type SemanticDeltaProposalResult =
  | { readonly kind: "proposed"; readonly delta: ProposedSemanticDelta }
  | { readonly kind: "no_semantic_delta" };

export type SemanticDeltaConfirmationResult =
  | { readonly kind: "confirmed"; readonly delta: ConfirmedSemanticDelta }
  | { readonly kind: "invalid_confirmation"; readonly message: string };

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

function definitionValue(
  definition: ConceptUserDefinition | undefined
): SemanticDeltaValue {
  return deepFreeze({
    kind: "personal_definition",
    ...(definition === undefined ? {} : { definition })
  });
}

function relationshipKey(value: Readonly<ConceptRelationship>): string {
  return `${value.relation}\u0000${value.targetConceptId}`;
}

function openMeaningIds(concept: Readonly<ConceptNode>): readonly string[] {
  return Object.freeze(concept.unresolvedItems
    .filter((item) =>
      item.status === "open" &&
      (item.kind === "meaning" || item.kind === "interpretation_conflict")
    )
    .map((item) => item.id));
}

function proposalId(input: {
  conceptId: string;
  originatingRevision: number;
  resultingRevision: number;
  kind: SemanticDeltaKind;
  originRef: string;
  next: SemanticDeltaValue;
}): string {
  return `semantic-delta:${stableHash(JSON.stringify(input))}`;
}

/** Select exactly one principal semantic change from an already reviewed node update. */
export function proposePrincipalSemanticDelta(input: {
  readonly previous: ConceptNode;
  readonly next: ConceptNode;
  readonly proposedAt: string;
  readonly originRef: string;
  readonly reason: string;
  readonly proposalConfidence?: number;
}): SemanticDeltaProposalResult {
  if (
    input.previous.id !== input.next.id ||
    input.next.revision !== input.previous.revision + 1
  ) {
    throw new Error("Semantic delta requires consecutive revisions of one concept.");
  }

  let kind: SemanticDeltaKind | undefined;
  let previous: SemanticDeltaValue | undefined;
  let next: SemanticDeltaValue | undefined;

  if (
    input.previous.userDefinition?.text !== input.next.userDefinition?.text
  ) {
    kind = input.previous.userDefinition === undefined
      ? "personal_definition_created"
      : "personal_definition_redefined";
    previous = definitionValue(input.previous.userDefinition);
    next = definitionValue(input.next.userDefinition);
  } else {
    const previousOpen = openMeaningIds(input.previous);
    const nextOpen = openMeaningIds(input.next);
    if (previousOpen.join("\u0000") !== nextOpen.join("\u0000")) {
      kind = "ambiguity_resolved";
      previous = deepFreeze({ kind: "ambiguity", openItemIds: previousOpen });
      next = deepFreeze({ kind: "ambiguity", openItemIds: nextOpen });
    } else if (
      input.previous.aliases.join("\u0000") !==
      input.next.aliases.join("\u0000")
    ) {
      kind = "aliases_changed";
      previous = deepFreeze({ kind: "aliases", aliases: input.previous.aliases });
      next = deepFreeze({ kind: "aliases", aliases: input.next.aliases });
    } else if (
      input.previous.relationships.map(relationshipKey).join("\u0000") !==
      input.next.relationships.map(relationshipKey).join("\u0000")
    ) {
      kind = "relationship_changed";
      previous = deepFreeze({
        kind: "relationships",
        relationships: input.previous.relationships
      });
      next = deepFreeze({
        kind: "relationships",
        relationships: input.next.relationships
      });
    }
  }

  if (kind === undefined || previous === undefined || next === undefined) {
    return Object.freeze({ kind: "no_semantic_delta" });
  }
  if (
    input.proposalConfidence !== undefined &&
    (!Number.isFinite(input.proposalConfidence) ||
      input.proposalConfidence < 0 || input.proposalConfidence > 1)
  ) {
    throw new Error("Proposal confidence must be between zero and one.");
  }
  const identity = {
    conceptId: input.next.id,
    originatingRevision: input.previous.revision,
    resultingRevision: input.next.revision,
    kind,
    originRef: input.originRef,
    next
  };
  return Object.freeze({
    kind: "proposed",
    delta: deepFreeze({
      schemaVersion: SEMANTIC_DELTA_SCHEMA_VERSION,
      authority: "proposed" as const,
      id: proposalId(identity),
      ...identity,
      previous,
      proposedAt: input.proposedAt,
      reason: input.reason,
      ...(input.proposalConfidence === undefined
        ? {}
        : { proposalConfidence: input.proposalConfidence })
    })
  });
}

export function confirmSemanticDelta(
  proposal: Readonly<ProposedSemanticDelta>,
  input: {
    readonly kind: "explicit_semantic_delta_confirmation";
    readonly confirmedAt: string;
    readonly confirmation: SemanticDeltaConfirmationProvenance;
  }
): SemanticDeltaConfirmationResult {
  if (
    proposal.authority !== "proposed" ||
    input.kind !== "explicit_semantic_delta_confirmation" ||
    input.confirmedAt.trim() === "" ||
    input.confirmation.confirmationId.trim() === "" ||
    input.confirmation.interactionRef.trim() === ""
  ) {
    return Object.freeze({
      kind: "invalid_confirmation",
      message: "An explicit semantic-delta confirmation is required."
    });
  }
  return Object.freeze({
    kind: "confirmed",
    delta: deepFreeze({
      schemaVersion: SEMANTIC_DELTA_SCHEMA_VERSION,
      authority: "user_confirmed" as const,
      id: proposal.id,
      conceptId: proposal.conceptId,
      originatingRevision: proposal.originatingRevision,
      resultingRevision: proposal.resultingRevision,
      kind: proposal.kind,
      previous: proposal.previous,
      next: proposal.next,
      proposedAt: proposal.proposedAt,
      confirmedAt: input.confirmedAt,
      originRef: proposal.originRef,
      reason: proposal.reason,
      confirmation: input.confirmation,
      authorization: Object.freeze([
        "refresh_relationship_labels",
        "invalidate_derived_interpretations",
        "refresh_dependency_revisions",
        "record_pending_decisions",
        "record_propagation_provenance"
      ] as PropagationAuthorization[])
    })
  });
}
