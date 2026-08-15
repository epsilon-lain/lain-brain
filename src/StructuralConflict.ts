import type {
  ConceptNode,
  ConceptRelationship
} from "./BrainGrowth";
import type { ConfirmedSemanticDelta } from "./SemanticDelta";
import {
  createPendingSemanticDecision,
  type PendingSemanticDecision
} from "./SemanticPropagation";

export const STRUCTURAL_CONFLICT_SCHEMA_VERSION = 1 as const;

export type RelationshipDiagnosticCategory =
  | "equivalence"
  | "distinction"
  | "dependency"
  | "analogy"
  | "containment"
  | "example"
  | "association"
  | "unclassified";

export type RelationshipSymmetry = "directional" | "symmetric";

export interface RelationshipDiagnosticSemantics {
  readonly category: RelationshipDiagnosticCategory;
  readonly symmetry: RelationshipSymmetry;
}

export type StructuralConflictCategory =
  | "hard_conflict"
  | "structural_tension"
  | "integrity_anomaly";

export type StructuralConflictSeverity = "info" | "review" | "conflict";
export type StructuralConflictStatus =
  | "open"
  | "resolved"
  | "dismissed"
  | "superseded";

export type StructuralConflictRuleId =
  | "DISTINCTION_VS_EQUIVALENCE"
  | "REMOVED_RELATIONSHIP_STILL_ACTIVE"
  | "DUPLICATE_DISTINCTION";

export interface StructuralRelationshipEvidence {
  readonly ownerConceptId: string;
  readonly ownerRevision: number;
  readonly relationshipId: string;
  readonly relationType: string;
  readonly targetConceptId: string;
  readonly sourceReferences: readonly string[];
}

export interface StructuralConflictProvenance {
  readonly detector: "deterministic_rule_registry";
  readonly detectedAt: string;
  readonly originatingSemanticDeltaIds: readonly string[];
}

export interface StructuralConflictDisposition {
  readonly kind: "dismissed" | "resolved" | "superseded";
  readonly recordedAt: string;
  readonly interactionRef: string;
  readonly reason: string;
}

export interface StructuralConflict {
  readonly schemaVersion: typeof STRUCTURAL_CONFLICT_SCHEMA_VERSION;
  readonly id: string;
  readonly ruleId: StructuralConflictRuleId;
  readonly category: StructuralConflictCategory;
  readonly severity: StructuralConflictSeverity;
  readonly status: StructuralConflictStatus;
  readonly affectedConceptIds: readonly string[];
  readonly relationshipEvidence: readonly StructuralRelationshipEvidence[];
  readonly relevantRevisions: Readonly<Record<string, number>>;
  readonly reason: string;
  readonly provenance: StructuralConflictProvenance;
  readonly disposition?: StructuralConflictDisposition;
}

export interface StructuralConflictReport {
  readonly inspectedConceptIds: readonly string[];
  readonly conflicts: readonly StructuralConflict[];
}

const RELATIONSHIP_TAXONOMY: Readonly<Record<
  string,
  RelationshipDiagnosticSemantics
>> = Object.freeze({
  equivalent_to: Object.freeze({ category: "equivalence", symmetry: "symmetric" }),
  same_as: Object.freeze({ category: "equivalence", symmetry: "symmetric" }),
  explicitly_distinct_from: Object.freeze({
    category: "distinction",
    symmetry: "symmetric"
  }),
  depends_on: Object.freeze({ category: "dependency", symmetry: "directional" }),
  derived_from: Object.freeze({ category: "dependency", symmetry: "directional" }),
  example_of: Object.freeze({ category: "example", symmetry: "directional" }),
  part_of: Object.freeze({ category: "containment", symmetry: "directional" }),
  analogous_to: Object.freeze({ category: "analogy", symmetry: "directional" }),
  related_to: Object.freeze({ category: "association", symmetry: "directional" })
});

export const STRUCTURAL_CONFLICT_RULES = Object.freeze([
  Object.freeze({
    id: "DISTINCTION_VS_EQUIVALENCE" as const,
    trigger: "relation_category_pair" as const,
    left: "distinction" as const,
    right: "equivalence" as const,
    category: "hard_conflict" as const,
    severity: "conflict" as const,
    reason:
      "The same concepts are both explicitly distinct and connected by an equivalence-like relation."
  }),
  Object.freeze({
    id: "REMOVED_RELATIONSHIP_STILL_ACTIVE" as const,
    trigger: "confirmed_removal_integrity" as const,
    category: "integrity_anomaly" as const,
    severity: "review" as const,
    reason:
      "A confirmed relationship removal exists, but the exact relationship remains active."
  }),
  Object.freeze({
    id: "DUPLICATE_DISTINCTION" as const,
    trigger: "duplicate_symmetric_relation" as const,
    category: "integrity_anomaly" as const,
    severity: "review" as const,
    reason:
      "The same symmetric explicit distinction is stored more than once."
  })
]);

function conflictRule(id: StructuralConflictRuleId) {
  return STRUCTURAL_CONFLICT_RULES.find((rule) => rule.id === id)!;
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

function normalizedRelation(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function classifyRelationshipForDiagnostics(
  relation: string
): RelationshipDiagnosticSemantics {
  return RELATIONSHIP_TAXONOMY[normalizedRelation(relation)] ??
    Object.freeze({ category: "unclassified", symmetry: "directional" });
}

function canonicalPair(first: string, second: string): readonly [string, string] {
  return first.localeCompare(second) <= 0
    ? [first, second]
    : [second, first];
}

function evidence(
  owner: Readonly<ConceptNode>,
  relationship: Readonly<ConceptRelationship>
): StructuralRelationshipEvidence {
  return deepFreeze({
    ownerConceptId: owner.id,
    ownerRevision: owner.revision,
    relationshipId: relationship.id,
    relationType: relationship.relation,
    targetConceptId: relationship.targetConceptId,
    sourceReferences: [...relationship.sourceReferences]
  });
}

function relationshipKey(
  ownerConceptId: string,
  relationship: Readonly<ConceptRelationship>
): string {
  return JSON.stringify([
    ownerConceptId,
    normalizedRelation(relationship.relation),
    relationship.targetConceptId
  ]);
}

function deltaRelationshipKeys(
  delta: Readonly<ConfirmedSemanticDelta>
): readonly string[] {
  const keys: string[] = [];
  for (const value of [delta.previous, delta.next]) {
    if (value.kind !== "relationships") continue;
    for (const relationship of value.relationships) {
      keys.push(relationshipKey(delta.conceptId, relationship));
    }
  }
  return keys;
}

function relevantDeltaIds(
  relationships: readonly StructuralRelationshipEvidence[],
  deltas: readonly ConfirmedSemanticDelta[]
): readonly string[] {
  const keys = new Set(relationships.map((item) => JSON.stringify([
    item.ownerConceptId,
    normalizedRelation(item.relationType),
    item.targetConceptId
  ])));
  return Object.freeze(deltas
    .filter((delta) => deltaRelationshipKeys(delta).some((key) => keys.has(key)))
    .map((delta) => delta.id)
    .sort());
}

function createConflict(input: {
  readonly ruleId: StructuralConflictRuleId;
  readonly category: StructuralConflictCategory;
  readonly severity: StructuralConflictSeverity;
  readonly reason: string;
  readonly evidence: readonly StructuralRelationshipEvidence[];
  readonly deltaIds: readonly string[];
  readonly detectedAt: string;
}): StructuralConflict {
  const relationshipEvidence = [...input.evidence].sort((left, right) =>
    JSON.stringify([
      left.ownerConceptId,
      left.relationshipId,
      left.relationType,
      left.targetConceptId
    ]).localeCompare(JSON.stringify([
      right.ownerConceptId,
      right.relationshipId,
      right.relationType,
      right.targetConceptId
    ]))
  );
  const affectedConceptIds = [...new Set(relationshipEvidence.flatMap((item) =>
    [item.ownerConceptId, item.targetConceptId]
  ))].sort();
  const relevantRevisions = Object.fromEntries(relationshipEvidence.map((item) =>
    [item.ownerConceptId, item.ownerRevision]
  ));
  const identity = {
    ruleId: input.ruleId,
    affectedConceptIds,
    relationships: relationshipEvidence.map((item) => [
      item.ownerConceptId,
      item.relationshipId,
      normalizedRelation(item.relationType),
      item.targetConceptId
    ]),
    deltaIds: [...input.deltaIds].sort()
  };
  return deepFreeze({
    schemaVersion: STRUCTURAL_CONFLICT_SCHEMA_VERSION,
    id: `structural-conflict:${stableHash(JSON.stringify(identity))}`,
    ruleId: input.ruleId,
    category: input.category,
    severity: input.severity,
    status: "open",
    affectedConceptIds,
    relationshipEvidence,
    relevantRevisions,
    reason: input.reason,
    provenance: {
      detector: "deterministic_rule_registry",
      detectedAt: input.detectedAt,
      originatingSemanticDeltaIds: [...input.deltaIds].sort()
    }
  });
}

function pairIsInScope(
  pair: readonly [string, string],
  scopedIds: ReadonlySet<string> | undefined
): boolean {
  return scopedIds === undefined || pair.some((id) => scopedIds.has(id));
}

/** Pure deterministic inspection. It never mutates concepts or relationships. */
export function detectStructuralConflicts(input: {
  readonly concepts: readonly ConceptNode[];
  readonly confirmedDeltas?: readonly ConfirmedSemanticDelta[];
  readonly detectedAt: string;
  readonly affectedConceptIds?: readonly string[];
}): StructuralConflictReport {
  const deltas = input.confirmedDeltas ?? [];
  const scope = input.affectedConceptIds === undefined
    ? undefined
    : new Set(input.affectedConceptIds);
  const distinctions = new Map<string, StructuralRelationshipEvidence[]>();
  const equivalences = new Map<string, StructuralRelationshipEvidence[]>();
  const conflicts: StructuralConflict[] = [];

  for (const concept of input.concepts) {
    for (const relationship of concept.relationships) {
      const semantics = classifyRelationshipForDiagnostics(relationship.relation);
      if (semantics.category !== "distinction" && semantics.category !== "equivalence") {
        continue;
      }
      const pair = canonicalPair(concept.id, relationship.targetConceptId);
      if (!pairIsInScope(pair, scope)) continue;
      const key = JSON.stringify(pair);
      const map = semantics.category === "distinction" ? distinctions : equivalences;
      map.set(key, [...(map.get(key) ?? []), evidence(concept, relationship)]);
    }
  }

  for (const [key, distinctionEvidence] of distinctions) {
    const equivalenceEvidence = equivalences.get(key);
    if (equivalenceEvidence === undefined) continue;
    const combined = [...distinctionEvidence, ...equivalenceEvidence];
    conflicts.push(createConflict({
      ruleId: "DISTINCTION_VS_EQUIVALENCE",
      category: "hard_conflict",
      severity: "conflict",
      reason: conflictRule("DISTINCTION_VS_EQUIVALENCE").reason,
      evidence: combined,
      deltaIds: relevantDeltaIds(combined, deltas),
      detectedAt: input.detectedAt
    }));
  }

  for (const distinctionEvidence of distinctions.values()) {
    if (distinctionEvidence.length < 2) continue;
    conflicts.push(createConflict({
      ruleId: "DUPLICATE_DISTINCTION",
      category: "integrity_anomaly",
      severity: "review",
      reason: conflictRule("DUPLICATE_DISTINCTION").reason,
      evidence: distinctionEvidence,
      deltaIds: relevantDeltaIds(distinctionEvidence, deltas),
      detectedAt: input.detectedAt
    }));
  }

  for (const delta of deltas) {
    if (
      delta.kind !== "relationship_changed" ||
      delta.previous.kind !== "relationships" ||
      delta.next.kind !== "relationships" ||
      (scope !== undefined && !scope.has(delta.conceptId))
    ) {
      continue;
    }
    const nextKeys = new Set(delta.next.relationships.map((relationship) =>
      relationshipKey(delta.conceptId, relationship)
    ));
    const removed = delta.previous.relationships.filter((relationship) =>
      !nextKeys.has(relationshipKey(delta.conceptId, relationship))
    );
    const owner = input.concepts.find((concept) => concept.id === delta.conceptId);
    if (owner === undefined) continue;
    for (const removedRelationship of removed) {
      const active = owner.relationships.find((relationship) =>
        relationshipKey(owner.id, relationship) ===
          relationshipKey(owner.id, removedRelationship)
      );
      if (active === undefined) continue;
      conflicts.push(createConflict({
        ruleId: "REMOVED_RELATIONSHIP_STILL_ACTIVE",
        category: "integrity_anomaly",
        severity: "review",
        reason: conflictRule("REMOVED_RELATIONSHIP_STILL_ACTIVE").reason,
        evidence: [evidence(owner, active)],
        deltaIds: [delta.id],
        detectedAt: input.detectedAt
      }));
    }
  }

  const unique = [...new Map(conflicts.map((conflict) => [
    conflict.id,
    conflict
  ])).values()].sort((left, right) => left.id.localeCompare(right.id));
  return deepFreeze({
    inspectedConceptIds: [...new Set(input.affectedConceptIds ??
      input.concepts.map((concept) => concept.id))].sort(),
    conflicts: unique
  });
}

/** Preserve reviewed history and supersede only records inside the inspected scope. */
export function reconcileStructuralConflicts(input: {
  readonly existing: readonly StructuralConflict[];
  readonly report: Readonly<StructuralConflictReport>;
  readonly recordedAt: string;
  readonly interactionRef: string;
}): readonly StructuralConflict[] {
  const detected = new Map(input.report.conflicts.map((item) => [item.id, item]));
  const scope = new Set(input.report.inspectedConceptIds);
  const result: StructuralConflict[] = [];
  for (const existing of input.existing) {
    const current = detected.get(existing.id);
    if (current !== undefined) {
      detected.delete(existing.id);
      result.push(existing.status === "dismissed" ? existing : deepFreeze({
        ...current,
        status: existing.status === "resolved" ? "resolved" : "open",
        ...(existing.disposition === undefined
          ? {}
          : { disposition: existing.disposition })
      }));
      continue;
    }
    const inspected = existing.affectedConceptIds.some((id) => scope.has(id));
    if (inspected && (existing.status === "open" || existing.status === "resolved")) {
      result.push(deepFreeze({
        ...existing,
        status: "superseded" as const,
        disposition: {
          kind: "superseded" as const,
          recordedAt: input.recordedAt,
          interactionRef: input.interactionRef,
          reason: "The underlying active structure no longer matches this diagnostic."
        }
      }));
    } else {
      result.push(existing);
    }
  }
  result.push(...detected.values());
  return deepFreeze(result.sort((left, right) => left.id.localeCompare(right.id)));
}

export function dismissStructuralConflict(
  conflicts: readonly StructuralConflict[],
  conflictId: string,
  input: {
    readonly dismissedAt: string;
    readonly interactionRef: string;
    readonly reason?: string;
  }
): readonly StructuralConflict[] {
  return deepFreeze(conflicts.map((conflict) =>
    conflict.id !== conflictId || conflict.status !== "open"
      ? conflict
      : {
          ...conflict,
          status: "dismissed" as const,
          disposition: {
            kind: "dismissed" as const,
            recordedAt: input.dismissedAt,
            interactionRef: input.interactionRef,
            reason: input.reason ??
              "The user reviewed this diagnostic and does not currently consider it a problem."
          }
        }
  ));
}

export function reconcileStructuralConflictPendingDecisions(
  conflicts: readonly StructuralConflict[],
  existing: readonly PendingSemanticDecision[]
): readonly PendingSemanticDecision[] {
  const result = existing.map((decision) => {
    if (decision.kind !== "structural_conflict" ||
      decision.structuralConflictId === undefined) return decision;
    const conflict = conflicts.find((item) => item.id === decision.structuralConflictId);
    if (conflict === undefined) {
      return deepFreeze({ ...decision, status: "superseded" as const });
    }
    if (conflict.status === "dismissed") {
      return deepFreeze({ ...decision, status: "dismissed" as const });
    }
    if (conflict.status === "superseded" || conflict.status === "resolved") {
      return deepFreeze({ ...decision, status: "superseded" as const });
    }
    return decision;
  });
  const known = new Set(result
    .map((decision) => decision.structuralConflictId)
    .filter((id): id is string => id !== undefined));
  for (const conflict of conflicts) {
    if (
      conflict.status !== "open" ||
      conflict.category !== "hard_conflict" ||
      known.has(conflict.id)
    ) continue;
    const deltaId = conflict.provenance.originatingSemanticDeltaIds[0];
    if (deltaId === undefined) continue;
    result.push(createPendingSemanticDecision({
      kind: "structural_conflict",
      structuralConflictId: conflict.id,
      deltaId,
      affectedConceptIds: conflict.affectedConceptIds,
      reason: conflict.reason,
      evidence: conflict.relationshipEvidence.map((item) => item.relationshipId),
      candidateActions: ["inspect", "review_relationship", "dismiss"],
      createdAt: conflict.provenance.detectedAt,
      revisionContext: conflict.relevantRevisions
    }));
    known.add(conflict.id);
  }
  return deepFreeze(result);
}
