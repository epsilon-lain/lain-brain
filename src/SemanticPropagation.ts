import {
  updateConceptNode,
  type ConceptContentEntry,
  type ConceptNode,
  type ConceptRelationship
} from "./BrainGrowth";
import type { ConceptIndex } from "./BrainGrowthIndex";
import type {
  ConfirmedSemanticDelta,
  PropagationAuthorization
} from "./SemanticDelta";

export const SEMANTIC_PROPAGATION_SCHEMA_VERSION = 1 as const;

export type PendingSemanticDecisionStatus =
  | "pending"
  | "resolved"
  | "dismissed"
  | "superseded";

export interface PendingSemanticDecision {
  readonly id: string;
  readonly kind?: "propagation" | "structural_conflict";
  readonly structuralConflictId?: string;
  readonly deltaId: string;
  readonly affectedConceptIds: readonly string[];
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly candidateActions: readonly string[];
  readonly status: PendingSemanticDecisionStatus;
  readonly createdAt: string;
  readonly revisionContext: Readonly<Record<string, number>>;
}

export type PropagationAutomaticOperation =
  | {
      readonly id: string;
      readonly kind: "refresh_relationship_label";
      readonly conceptId: string;
      readonly relationshipId: string;
      readonly targetConceptId: string;
      readonly previousLabel: string;
      readonly nextLabel: string;
    }
  | {
      readonly id: string;
      readonly kind: "invalidate_generated_interpretation";
      readonly conceptId: string;
      readonly contentEntryId: string;
      readonly dependencyConceptId: string;
      readonly previousDependencyRevision: number;
      readonly nextDependencyRevision: number;
    };

export interface PropagationAffectedConcept {
  readonly conceptId: string;
  readonly expectedRevision: number;
  readonly depth: number;
  readonly selectedBecause: readonly string[];
  readonly automaticOperations: readonly PropagationAutomaticOperation[];
  readonly pendingDecisionIds: readonly string[];
}

export interface PropagationSkippedConcept {
  readonly conceptId: string;
  readonly reason: string;
}

export interface PropagationPlan {
  readonly schemaVersion: typeof SEMANTIC_PROPAGATION_SCHEMA_VERSION;
  readonly deltaId: string;
  readonly sourceConceptId: string;
  readonly maxDepth: number;
  readonly maxConcepts: number;
  readonly affected: readonly PropagationAffectedConcept[];
  readonly pendingDecisions: readonly PendingSemanticDecision[];
  readonly skipped: readonly PropagationSkippedConcept[];
  readonly visitedConceptIds: readonly string[];
  readonly truncated: boolean;
}

export interface PropagatedConceptRevision {
  readonly deltaId: string;
  readonly conceptId: string;
  readonly previousRevision: number;
  readonly resultingRevision: number;
  readonly operations: readonly string[];
  readonly concept: ConceptNode;
}

export interface PropagationApplicationResult {
  readonly deltaId: string;
  readonly revisions: readonly PropagatedConceptRevision[];
  readonly pendingDecisions: readonly PendingSemanticDecision[];
  readonly skipped: readonly PropagationSkippedConcept[];
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

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createPendingSemanticDecision(
  input: Omit<PendingSemanticDecision, "id" | "status">
):
PendingSemanticDecision {
  return deepFreeze({
    id: `pending-semantic-decision:${stableHash(JSON.stringify(input))}`,
    ...input,
    status: "pending"
  });
}

function operationId(
  deltaId: string,
  conceptId: string,
  kind: string,
  target: string
): string {
  return `propagation-operation:${stableHash(
    [deltaId, conceptId, kind, target].join("\u0000")
  )}`;
}

function relationIsSemanticDependency(relation: string): boolean {
  return ["depends_on", "derived_from", "defined_by"]
    .includes(relation.trim().toLocaleLowerCase());
}

function referencesConcept(
  entry: Readonly<ConceptContentEntry>,
  conceptId: string
): boolean {
  return (entry.dependencies ?? []).some(
    (dependency) => dependency.conceptId === conceptId
  ) || entry.sourceReferences.some((reference) =>
    reference === `concept:${conceptId}` ||
    reference.startsWith(`concept:${conceptId}@revision:`)
  );
}

function dependentRevision(
  entry: Readonly<ConceptContentEntry>,
  conceptId: string,
  fallback: number
): number {
  const dependency = (entry.dependencies ?? []).find(
    (item) => item.conceptId === conceptId
  );
  if (dependency !== undefined) {
    return dependency.conceptRevision;
  }
  const prefix = `concept:${conceptId}@revision:`;
  const parsed = entry.sourceReferences
    .find((reference) => reference.startsWith(prefix))
    ?.slice(prefix.length);
  const revision = parsed === undefined ? Number.NaN : Number(parsed);
  return Number.isInteger(revision) && revision > 0 ? revision : fallback;
}

function requiresPendingDefinitionReview(
  concept: Readonly<ConceptNode>,
  relationships: readonly ConceptRelationship[]
): boolean {
  return concept.userDefinition !== undefined &&
    relationships.some((relationship) =>
      relationIsSemanticDependency(relationship.relation)
    );
}

/** Pure deterministic explicit-structure discovery and bounded planning. */
export function planSemanticPropagation(
  delta: Readonly<ConfirmedSemanticDelta>,
  index: Readonly<ConceptIndex>,
  options: {
    readonly maxDepth?: number;
    readonly maxConcepts?: number;
  } = {}
): PropagationPlan {
  if (delta.authority !== "user_confirmed") {
    throw new Error("Only a confirmed SemanticDelta may be propagated.");
  }
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 2));
  const maxConcepts = Math.max(1, Math.floor(options.maxConcepts ?? 50));
  const source = index.concepts.find((concept) => concept.id === delta.conceptId);
  if (source === undefined) {
    return deepFreeze({
      schemaVersion: SEMANTIC_PROPAGATION_SCHEMA_VERSION,
      deltaId: delta.id,
      sourceConceptId: delta.conceptId,
      maxDepth,
      maxConcepts,
      affected: [],
      pendingDecisions: [],
      skipped: [{ conceptId: delta.conceptId, reason: "Source concept is missing." }],
      visitedConceptIds: [],
      truncated: false
    });
  }

  const visited = new Set<string>([source.id]);
  const queue: Array<{ conceptId: string; depth: number }> = [
    { conceptId: source.id, depth: 0 }
  ];
  const affected: PropagationAffectedConcept[] = [];
  const pending: PendingSemanticDecision[] = [];
  const skipped: PropagationSkippedConcept[] = [];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) {
      continue;
    }
    const currentConcept = index.concepts.find(
      (concept) => concept.id === current.conceptId
    );
    if (currentConcept === undefined) {
      continue;
    }

    for (const concept of index.concepts) {
      if (concept.id === current.conceptId || visited.has(concept.id)) {
        continue;
      }
      const incoming = concept.relationships.filter(
        (relationship) => relationship.targetConceptId === current.conceptId
      );
      const dependencyIncoming = incoming.filter((relationship) =>
        relationIsSemanticDependency(relationship.relation)
      );
      const derived = concept.generatedInterpretations.filter((entry) =>
        referencesConcept(entry, current.conceptId)
      );
      const unresolved = concept.unresolvedItems.filter((item) =>
        item.status === "open" && item.kind === "relationship" &&
        item.alternatives.some((alternative) =>
          alternative === current.conceptId ||
          alternative === currentConcept.title
        )
      );
      if (incoming.length === 0 && derived.length === 0 && unresolved.length === 0) {
        continue;
      }
      if (affected.length >= maxConcepts) {
        truncated = true;
        break;
      }
      const depth = current.depth + 1;
      const operations: PropagationAutomaticOperation[] = [];
      for (const relationship of incoming) {
        if (relationship.targetLabel !== currentConcept.title) {
          operations.push(deepFreeze({
            id: operationId(delta.id, concept.id,
              "refresh_relationship_label", relationship.id),
            kind: "refresh_relationship_label",
            conceptId: concept.id,
            relationshipId: relationship.id,
            targetConceptId: currentConcept.id,
            previousLabel: relationship.targetLabel,
            nextLabel: currentConcept.title
          }));
        }
      }
      for (const entry of derived) {
        const previousRevision = dependentRevision(
          entry,
          currentConcept.id,
          Math.max(1, currentConcept.revision - 1)
        );
        if (
          previousRevision < currentConcept.revision &&
          (entry.derivedStatus ?? "current") !== "stale"
        ) {
          operations.push(deepFreeze({
            id: operationId(delta.id, concept.id,
              "invalidate_generated_interpretation", entry.id),
            kind: "invalidate_generated_interpretation",
            conceptId: concept.id,
            contentEntryId: entry.id,
            dependencyConceptId: currentConcept.id,
            previousDependencyRevision: previousRevision,
            nextDependencyRevision: currentConcept.revision
          }));
        }
      }
      const decisions: PendingSemanticDecision[] = [];
      if (requiresPendingDefinitionReview(concept, dependencyIncoming)) {
        decisions.push(createPendingSemanticDecision({
          deltaId: delta.id,
          affectedConceptIds: [concept.id, currentConcept.id],
          reason:
            "A personal definition explicitly depends on the changed concept and cannot be rewritten automatically.",
          evidence: incoming.map((relationship) => relationship.id),
          candidateActions: ["review_personal_definition", "leave_unchanged"],
          createdAt: delta.confirmedAt,
          revisionContext: {
            [concept.id]: concept.revision,
            [currentConcept.id]: currentConcept.revision
          }
        }));
      }
      if (unresolved.length > 0) {
        decisions.push(createPendingSemanticDecision({
          deltaId: delta.id,
          affectedConceptIds: [concept.id, currentConcept.id],
          reason:
            "An unresolved relationship may refer to this concept and requires an explicit target decision.",
          evidence: unresolved.map((item) => item.id),
          candidateActions: ["choose_exact_target", "leave_unresolved"],
          createdAt: delta.confirmedAt,
          revisionContext: {
            [concept.id]: concept.revision,
            [currentConcept.id]: currentConcept.revision
          }
        }));
      }
      pending.push(...decisions);
      if (operations.length === 0 && decisions.length === 0) {
        skipped.push(deepFreeze({
          conceptId: concept.id,
          reason: "Explicit adjacency exists but no safe deterministic consequence applies."
        }));
      }
      affected.push(deepFreeze({
        conceptId: concept.id,
        expectedRevision: concept.revision,
        depth,
        selectedBecause: Object.freeze([
          ...(incoming.length > 0 ? ["explicit_relationship"] : []),
          ...(derived.length > 0 ? ["explicit_derived_dependency"] : []),
          ...(unresolved.length > 0 ? ["unresolved_exact_reference"] : [])
        ]),
        automaticOperations: Object.freeze(operations),
        pendingDecisionIds: Object.freeze(decisions.map((item) => item.id))
      }));
      if (dependencyIncoming.length > 0 || derived.length > 0) {
        visited.add(concept.id);
        queue.push({ conceptId: concept.id, depth });
      }
    }
    if (truncated) {
      break;
    }
  }

  return deepFreeze({
    schemaVersion: SEMANTIC_PROPAGATION_SCHEMA_VERSION,
    deltaId: delta.id,
    sourceConceptId: delta.conceptId,
    maxDepth,
    maxConcepts,
    affected,
    pendingDecisions: pending,
    skipped,
    visitedConceptIds: [...visited],
    truncated
  });
}

function hasAuthorization(
  delta: Readonly<ConfirmedSemanticDelta>,
  value: PropagationAuthorization
): boolean {
  return delta.authorization.includes(value);
}

function updateGeneratedEntry(
  entry: Readonly<ConceptContentEntry>,
  operation: Extract<PropagationAutomaticOperation, {
    kind: "invalidate_generated_interpretation";
  }>,
  deltaId: string
): ConceptContentEntry {
  if (entry.id !== operation.contentEntryId) {
    return entry;
  }
  const dependencies = [
    ...(entry.dependencies ?? []).filter((dependency) =>
      dependency.conceptId !== operation.dependencyConceptId
    ),
    {
      conceptId: operation.dependencyConceptId,
      conceptRevision: operation.nextDependencyRevision
    }
  ];
  return deepFreeze({
    ...entry,
    derivedStatus: "stale",
    dependencies,
    staleBecauseDeltaId: deltaId
  });
}

/** Apply only authorization-listed mechanical operations in memory. */
export function applySemanticPropagationPlan(
  delta: Readonly<ConfirmedSemanticDelta>,
  plan: Readonly<PropagationPlan>,
  concepts: readonly ConceptNode[],
  appliedAt: string
): PropagationApplicationResult {
  if (plan.deltaId !== delta.id || delta.authority !== "user_confirmed") {
    throw new Error("Propagation plan does not match a confirmed delta.");
  }
  const revisions: PropagatedConceptRevision[] = [];
  const pending = [...plan.pendingDecisions];
  const skipped = [...plan.skipped];

  for (const affected of plan.affected) {
    const concept = concepts.find((item) => item.id === affected.conceptId);
    if (concept === undefined) {
      skipped.push(deepFreeze({
        conceptId: affected.conceptId,
        reason: "Affected concept is missing."
      }));
      continue;
    }
    if (concept.revision !== affected.expectedRevision) {
      pending.push(createPendingSemanticDecision({
        deltaId: delta.id,
        affectedConceptIds: [concept.id],
        reason:
          "The concept changed after propagation planning; newer user state was preserved.",
        evidence: [],
        candidateActions: ["replan", "dismiss"],
        createdAt: appliedAt,
        revisionContext: { [concept.id]: concept.revision }
      }));
      continue;
    }
    const allowed = affected.automaticOperations.filter((operation) =>
      operation.kind === "refresh_relationship_label"
        ? hasAuthorization(delta, "refresh_relationship_labels")
        : hasAuthorization(delta, "invalidate_derived_interpretations") &&
          hasAuthorization(delta, "refresh_dependency_revisions")
    );
    if (allowed.length === 0) {
      continue;
    }
    const relationshipOperations = allowed.filter((operation): operation is
    Extract<PropagationAutomaticOperation, { kind: "refresh_relationship_label" }> =>
      operation.kind === "refresh_relationship_label");
    const generatedOperations = allowed.filter((operation): operation is
    Extract<PropagationAutomaticOperation, { kind: "invalidate_generated_interpretation" }> =>
      operation.kind === "invalidate_generated_interpretation");
    const relationships = concept.relationships.map((relationship) => {
      const operation = relationshipOperations.find(
        (item) => item.relationshipId === relationship.id
      );
      return operation === undefined ? relationship : {
        ...relationship,
        targetLabel: operation.nextLabel
      };
    });
    const interpretations = concept.generatedInterpretations.map((entry) => {
      let current = entry;
      for (const operation of generatedOperations) {
        current = updateGeneratedEntry(current, operation, delta.id);
      }
      return current;
    });
    const next = updateConceptNode(concept, {
      relationships,
      relationshipsMode: "replace",
      generatedInterpretations: interpretations,
      generatedInterpretationsMode: "replace"
    }, {
      changedAt: appliedAt,
      reason: `Mechanical propagation from SemanticDelta ${delta.id}`
    });
    if (next === concept) {
      continue;
    }
    revisions.push(deepFreeze({
      deltaId: delta.id,
      conceptId: concept.id,
      previousRevision: concept.revision,
      resultingRevision: next.revision,
      operations: allowed.map((operation) => operation.id),
      concept: next
    }));
  }
  return deepFreeze({
    deltaId: delta.id,
    revisions,
    pendingDecisions: pending,
    skipped
  });
}

export function listPendingSemanticDecisions(
  decisions: readonly PendingSemanticDecision[],
  affectedConceptId?: string
): readonly PendingSemanticDecision[] {
  return Object.freeze(decisions.filter((item) =>
    item.status === "pending" &&
    (affectedConceptId === undefined ||
      item.affectedConceptIds.includes(affectedConceptId))
  ));
}

export function resolvePendingSemanticDecision(
  decisions: readonly PendingSemanticDecision[],
  decisionId: string,
  status: "resolved" | "dismissed" | "superseded"
): readonly PendingSemanticDecision[] {
  return Object.freeze(decisions.map((item) =>
    item.id === decisionId
      ? deepFreeze({ ...item, status })
      : item
  ));
}
