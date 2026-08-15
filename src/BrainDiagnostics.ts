import type { ConceptNode } from "./BrainGrowth";
import { normalizeConceptLookupText } from "./BrainGrowthIndex";
import type { ConceptMarkdownInspection } from "./BrainGrowthPersistence";
import type { SemanticDeltaState } from "./SemanticDeltaState";

export type BrainDiagnosticSeverity = "warning" | "error";
export type BrainDiagnosticCode =
  | "duplicate_concept_id"
  | "same_title_candidates"
  | "missing_user_definition"
  | "unresolved_ambiguity"
  | "unresolved_relationship"
  | "missing_relationship_target"
  | "malformed_revision_history"
  | "invalid_persistence_metadata"
  | "orphan_semantic_delta"
  | "incomplete_propagation"
  | "failed_propagation"
  | "unknown_delta_revision_reference"
  | "structural_conflict"
  | "structural_tension"
  | "structural_integrity_anomaly";

export interface BrainDiagnostic {
  readonly code: BrainDiagnosticCode;
  readonly severity: BrainDiagnosticSeverity;
  readonly conceptIds: readonly string[];
  readonly message: string;
  readonly relationshipId?: string;
  readonly persistenceRef?: string;
}

export interface BrainPersistenceInspectionInput {
  /** Caller-owned vault-relative path or other safe display reference. */
  readonly ref: string;
  readonly inspection: ConceptMarkdownInspection;
}

export interface BrainDiagnostics {
  readonly conceptCount: number;
  readonly issueCount: number;
  readonly issues: readonly BrainDiagnostic[];
}

function issue(input: BrainDiagnostic): BrainDiagnostic {
  return Object.freeze({
    ...input,
    conceptIds: Object.freeze([...input.conceptIds])
  });
}

function hasMalformedRevisionHistory(concept: Readonly<ConceptNode>): boolean {
  if (!Number.isInteger(concept.revision) || concept.revision < 1) {
    return true;
  }

  let previousRevision = 0;
  const seen = new Set<number>();
  for (const entry of concept.history) {
    if (
      !Number.isInteger(entry.revision) ||
      entry.revision < 1 ||
      entry.revision >= concept.revision ||
      entry.snapshot.revision !== entry.revision ||
      seen.has(entry.revision) ||
      entry.revision <= previousRevision
    ) {
      return true;
    }
    seen.add(entry.revision);
    previousRevision = entry.revision;
  }

  return false;
}

/** Pure read-only integrity inspection. It never repairs or persists issues. */
export function diagnoseBrain(
  concepts: readonly ConceptNode[],
  persistenceInputs: readonly BrainPersistenceInspectionInput[] = [],
  semanticDeltaState?: Readonly<SemanticDeltaState>
): BrainDiagnostics {
  const issues: BrainDiagnostic[] = [];
  const byId = new Map<string, ConceptNode[]>();
  const byTitle = new Map<string, ConceptNode[]>();

  for (const concept of concepts) {
    const idGroup = byId.get(concept.id) ?? [];
    idGroup.push(concept);
    byId.set(concept.id, idGroup);

    const titleKey = normalizeConceptLookupText(concept.title);
    const titleGroup = byTitle.get(titleKey) ?? [];
    titleGroup.push(concept);
    byTitle.set(titleKey, titleGroup);
  }

  for (const [conceptId, group] of byId) {
    if (group.length > 1) {
      issues.push(issue({
        code: "duplicate_concept_id",
        severity: "error",
        conceptIds: group.map((concept) => concept.id),
        message: `Stable concept ID "${conceptId}" occurs ${group.length} times.`
      }));
    }
  }

  for (const group of byTitle.values()) {
    const ids = [...new Set(group.map((concept) => concept.id))];
    if (ids.length > 1) {
      issues.push(issue({
        code: "same_title_candidates",
        severity: "warning",
        conceptIds: ids,
        message:
          `Multiple distinct concepts use the title "${group[0]!.title}".`
      }));
    }
  }

  const knownIds = new Set(concepts.map((concept) => concept.id));
  for (const concept of concepts) {
    if (concept.userDefinition === undefined) {
      issues.push(issue({
        code: "missing_user_definition",
        severity: "warning",
        conceptIds: [concept.id],
        message: "Concept has no approved exact user definition."
      }));
    }

    if (
      concept.alternativeUserDefinitions.length > 0 ||
      concept.unresolvedItems.some((item) =>
        item.status === "open" &&
        (item.kind === "meaning" || item.kind === "interpretation_conflict")
      )
    ) {
      issues.push(issue({
        code: "unresolved_ambiguity",
        severity: "warning",
        conceptIds: [concept.id],
        message: "Concept has unresolved semantic ambiguity."
      }));
    }

    for (const unresolved of concept.unresolvedItems) {
      if (unresolved.kind === "relationship" && unresolved.status === "open") {
        issues.push(issue({
          code: "unresolved_relationship",
          severity: "warning",
          conceptIds: [concept.id],
          message: unresolved.text,
          relationshipId: unresolved.id
        }));
      }
    }

    for (const relationship of concept.relationships) {
      if (!knownIds.has(relationship.targetConceptId)) {
        issues.push(issue({
          code: "missing_relationship_target",
          severity: "error",
          conceptIds: [concept.id, relationship.targetConceptId],
          relationshipId: relationship.id,
          message:
            `Relationship target "${relationship.targetConceptId}" is missing.`
        }));
      }
    }

    if (hasMalformedRevisionHistory(concept)) {
      issues.push(issue({
        code: "malformed_revision_history",
        severity: "error",
        conceptIds: [concept.id],
        message: "Concept revision history is malformed."
      }));
    }
  }

  for (const input of persistenceInputs) {
    if (input.inspection.kind === "invalid_concept") {
      issues.push(issue({
        code: "invalid_persistence_metadata",
        severity: "error",
        conceptIds: [],
        persistenceRef: input.ref,
        message: input.inspection.message
      }));
    }
  }

  if (semanticDeltaState !== undefined) {
    const deltaIds = new Set(
      semanticDeltaState.deltas.map((delta) => delta.id)
    );
    for (const delta of semanticDeltaState.deltas) {
      if (!knownIds.has(delta.conceptId)) {
        issues.push(issue({
          code: "orphan_semantic_delta",
          severity: "error",
          conceptIds: [delta.conceptId],
          message: `SemanticDelta "${delta.id}" points to a missing concept.`
        }));
      }
    }
    for (const job of semanticDeltaState.jobs) {
      if (job.status === "failed") {
        issues.push(issue({
          code: "failed_propagation",
          severity: "error",
          conceptIds: [],
          message: `Semantic propagation failed for delta "${job.deltaId}".`
        }));
      } else if (
        job.status === "awaiting_origin_write" ||
        job.status === "queued" ||
        job.status === "planning" ||
        job.status === "propagating"
      ) {
        issues.push(issue({
          code: "incomplete_propagation",
          severity: "warning",
          conceptIds: [],
          message: `Semantic propagation is incomplete for delta "${job.deltaId}".`
        }));
      }
    }
    for (const concept of concepts) {
      for (const history of concept.history) {
        const referenced = history.reason.match(
          /SemanticDelta\s+(semantic-delta:[^\s]+)/u
        )?.[1];
        if (referenced !== undefined && !deltaIds.has(referenced)) {
          issues.push(issue({
            code: "unknown_delta_revision_reference",
            severity: "warning",
            conceptIds: [concept.id],
            message:
              `Concept revision ${history.revision + 1} references an unknown SemanticDelta.`
          }));
        }
      }
    }
    for (const conflict of semanticDeltaState.structuralConflicts ?? []) {
      if (conflict.status !== "open") continue;
      issues.push(issue({
        code: conflict.category === "hard_conflict"
          ? "structural_conflict"
          : conflict.category === "structural_tension"
            ? "structural_tension"
            : "structural_integrity_anomaly",
        severity: conflict.severity === "conflict" ? "error" : "warning",
        conceptIds: conflict.affectedConceptIds,
        message: conflict.reason,
        relationshipId: conflict.relationshipEvidence[0]?.relationshipId
      }));
    }
  }

  return Object.freeze({
    conceptCount: concepts.length,
    issueCount: issues.length,
    issues: Object.freeze(issues)
  });
}
