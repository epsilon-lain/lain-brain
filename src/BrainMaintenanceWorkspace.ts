import {
  getConceptMeaningStatus,
  type ConceptNode,
  type ConceptRelationship,
  type ConceptUnresolvedItem,
  type ConceptUserDefinition
} from "./BrainGrowth";
import {
  preparePersistedConceptRestore,
  preparePersistedConceptUpdate,
  type PersistedConceptMaintenanceResult
} from "./BrainMaintenance";
import { normalizeConceptLookupText } from "./BrainGrowthIndex";
import type { UserTextProvenance } from "./KnowledgeProtocol";

export type PersonalDefinitionSource =
  | { readonly kind: "existing" }
  | {
      readonly kind: "user_evidence";
      readonly evidence: UserTextProvenance;
    }
  | { readonly kind: "maintenance_input" };

export interface ConceptMaintenanceDraft {
  readonly conceptId: string;
  readonly expectedRevision: number;
  readonly personalDefinitionText: string;
  readonly personalDefinitionSource: PersonalDefinitionSource;
  readonly aliases: readonly string[];
  readonly relationships: readonly ConceptRelationship[];
  readonly resolveUnresolvedItemIds: readonly string[];
}

export type ConceptSemanticDiffKind =
  | "personal_definition"
  | "aliases"
  | "meaning_status"
  | "relationship"
  | "ambiguity"
  | "revision"
  | "history_restore";

export interface ConceptSemanticDiff {
  readonly kind: ConceptSemanticDiffKind;
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

export type PreparedConceptWorkspaceChange =
  | {
      readonly kind: "updated";
      readonly previous: ConceptNode;
      readonly concept: ConceptNode;
      readonly markdown: string;
      readonly diff: readonly ConceptSemanticDiff[];
      readonly restoredRevision?: number;
    }
  | {
      readonly kind: "no_change";
      readonly concept: ConceptNode;
      readonly markdown: string;
    }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly message: string;
      readonly markdown: string;
    };

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function provenanceSnapshot(value: Readonly<UserTextProvenance>): string {
  return value.snapshot;
}

function stableTextHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeAliases(values: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    const key = normalizeConceptLookupText(value);
    if (value === "" || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return freezeArray(result);
}

export function createConceptMaintenanceDraft(
  concept: Readonly<ConceptNode>
): ConceptMaintenanceDraft {
  return Object.freeze({
    conceptId: concept.id,
    expectedRevision: concept.revision,
    personalDefinitionText: concept.userDefinition?.text ?? "",
    personalDefinitionSource: Object.freeze({ kind: "existing" }),
    aliases: freezeArray(concept.aliases),
    relationships: freezeArray(concept.relationships),
    resolveUnresolvedItemIds: Object.freeze([])
  });
}

export function createMaintenanceRelationship(input: {
  readonly sourceConceptId: string;
  readonly relation: string;
  readonly targetConceptId: string;
  readonly targetLabel: string;
}): ConceptRelationship {
  const relation = input.relation.trim();
  const targetConceptId = input.targetConceptId.trim();
  const targetLabel = input.targetLabel.trim();
  if (relation === "" || targetConceptId === "" || targetLabel === "") {
    throw new Error("Relation type and target are required.");
  }
  const identity = [
    input.sourceConceptId,
    relation,
    targetConceptId
  ].join("\u0000");
  return Object.freeze({
    id: `relationship:maintenance:${stableTextHash(identity)}`,
    relation,
    targetConceptId,
    targetLabel,
    sourceReferences: Object.freeze(["user-reviewed maintenance"])
  });
}

function createDefinition(
  concept: Readonly<ConceptNode>,
  draft: Readonly<ConceptMaintenanceDraft>
): ConceptUserDefinition | undefined {
  const text = draft.personalDefinitionText.trim();
  if (text === "") {
    return undefined;
  }
  if (
    draft.personalDefinitionSource.kind === "existing" &&
    concept.userDefinition?.text === text
  ) {
    return concept.userDefinition;
  }
  const sourceRefs: readonly UserTextProvenance[] =
    draft.personalDefinitionSource.kind === "user_evidence" &&
    provenanceSnapshot(draft.personalDefinitionSource.evidence) === text
      ? Object.freeze([draft.personalDefinitionSource.evidence])
      : Object.freeze([{
          sourceKind: "user_edit",
          editId:
            `maintenance:${concept.id}:r${concept.revision}:` +
            stableTextHash(text),
          snapshot: text,
          actor: "user"
        }]);
  return Object.freeze({
    id:
      `definition:maintenance:${concept.id}:r${concept.revision}:` +
      stableTextHash(text),
    text,
    sourceRefs
  });
}

function resolveReviewedItems(
  items: readonly ConceptUnresolvedItem[],
  selectedIds: readonly string[],
  definitionText: string
): readonly ConceptUnresolvedItem[] {
  const selected = new Set(selectedIds);
  return freezeArray(items.map((item) =>
    selected.has(item.id) && item.status === "open"
      ? Object.freeze({
          ...item,
          status: "resolved" as const,
          resolution:
            definitionText.trim() === ""
              ? "Resolved during explicit concept maintenance review."
              : "Resolved by the explicitly reviewed personal definition."
        })
      : item
  ));
}

function relationshipSummary(
  values: readonly ConceptRelationship[]
): string {
  return values.length === 0
    ? "None"
    : values.map((item) =>
        `${item.relation} → ${item.targetLabel} (${item.targetConceptId})`
      ).join("\n");
}

function ambiguitySummary(concept: Readonly<ConceptNode>): string {
  const open = concept.unresolvedItems.filter((item) =>
    item.status === "open"
  ).length;
  return [
    getConceptMeaningStatus(concept),
    `${concept.alternativeUserDefinitions.length} alternative definitions`,
    `${open} open items`
  ].join(" · ");
}

export function createConceptSemanticDiff(
  previous: Readonly<ConceptNode>,
  next: Readonly<ConceptNode>,
  restoredRevision?: number
): readonly ConceptSemanticDiff[] {
  const result: ConceptSemanticDiff[] = [];
  const add = (
    kind: ConceptSemanticDiffKind,
    label: string,
    before: string,
    after: string
  ): void => {
    if (before !== after) {
      result.push(Object.freeze({ kind, label, before, after }));
    }
  };
  add(
    "personal_definition",
    "Personal definition",
    previous.userDefinition?.text ?? "Not defined",
    next.userDefinition?.text ?? "Not defined"
  );
  add("aliases", "Aliases", previous.aliases.join(", ") || "None",
    next.aliases.join(", ") || "None");
  add("meaning_status", "Meaning status", getConceptMeaningStatus(previous),
    getConceptMeaningStatus(next));
  add("relationship", "Relationships", relationshipSummary(previous.relationships),
    relationshipSummary(next.relationships));
  add("ambiguity", "Ambiguity", ambiguitySummary(previous),
    ambiguitySummary(next));
  if (restoredRevision !== undefined) {
    result.push(Object.freeze({
      kind: "history_restore",
      label: "History restore",
      before: `Current semantic state at revision ${previous.revision}`,
      after:
        `Semantic state from revision ${restoredRevision}, saved as a new revision`
    }));
  }
  result.push(Object.freeze({
    kind: "revision",
    label: "Revision",
    before: String(previous.revision),
    after: String(next.revision)
  }));
  return Object.freeze(result);
}

function projectResult(
  result: PersistedConceptMaintenanceResult,
  restoredRevision?: number
): PreparedConceptWorkspaceChange {
  if (result.kind === "failed") {
    return Object.freeze({ ...result });
  }
  if (result.kind === "no_change") {
    return Object.freeze({ ...result });
  }
  return Object.freeze({
    ...result,
    diff: createConceptSemanticDiff(
      result.previous,
      result.concept,
      restoredRevision
    ),
    ...(restoredRevision === undefined ? {} : { restoredRevision })
  });
}

export function prepareConceptMaintenanceDraft(input: {
  readonly markdown: string;
  readonly concept: ConceptNode;
  readonly draft: ConceptMaintenanceDraft;
  readonly reviewedAt: string;
}): PreparedConceptWorkspaceChange {
  if (
    input.draft.conceptId !== input.concept.id ||
    input.draft.expectedRevision !== input.concept.revision
  ) {
    return Object.freeze({
      kind: "failed",
      code: "stale_revision",
      message: "The concept changed after this workspace was opened.",
      markdown: input.markdown
    });
  }
  const definition = createDefinition(input.concept, input.draft);
  const unresolvedItems = resolveReviewedItems(
    input.concept.unresolvedItems,
    input.draft.resolveUnresolvedItemIds,
    input.draft.personalDefinitionText
  );
  const result = preparePersistedConceptUpdate(input.markdown, {
    approval: {
      kind: "confirmed_concept_update",
      approvedAt: input.reviewedAt
    },
    conceptId: input.concept.id,
    expectedRevision: input.concept.revision,
    update: {
      aliases: normalizeAliases(input.draft.aliases),
      aliasesMode: "replace",
      ...(definition === undefined ? {} : {
        userDefinition: definition,
        userDefinitionMode: "explicit_user_redefinition" as const
      }),
      relationships: input.draft.relationships,
      relationshipsMode: "replace",
      unresolvedItems,
      unresolvedItemsMode: "replace"
    },
    change: {
      changedAt: input.reviewedAt,
      reason: "Explicit Concept Maintenance workspace review"
    }
  });
  return projectResult(result);
}

export function prepareConceptMaintenanceRestore(input: {
  readonly markdown: string;
  readonly concept: ConceptNode;
  readonly restoreRevision: number;
  readonly reviewedAt: string;
}): PreparedConceptWorkspaceChange {
  return projectResult(preparePersistedConceptRestore(input.markdown, {
    approval: {
      kind: "confirmed_concept_update",
      approvedAt: input.reviewedAt
    },
    conceptId: input.concept.id,
    expectedRevision: input.concept.revision,
    restoreRevision: input.restoreRevision,
    change: {
      changedAt: input.reviewedAt,
      reason: `Explicitly restore semantic state from revision ${input.restoreRevision}`
    }
  }), input.restoreRevision);
}

export function findConceptsSharingLabels(
  concepts: readonly ConceptNode[],
  current: Readonly<ConceptNode>
): readonly ConceptNode[] {
  const labels = new Set([
    normalizeConceptLookupText(current.title),
    ...current.aliases.map(normalizeConceptLookupText)
  ]);
  return Object.freeze(concepts.filter((concept) =>
    concept.id !== current.id && [
      concept.title,
      ...concept.aliases
    ].some((label) => labels.has(normalizeConceptLookupText(label)))
  ));
}
