import {
  createConceptNode,
  type ConceptContentEntry,
  type ConceptNode,
  type ConceptRelationship,
  type ConceptUnresolvedItem,
  type ConceptUserDefinition
} from "./BrainGrowth";
import type { CandidatePrimaryConcept } from "./CandidateNoteRelations";
import type { UserTextProvenance } from "./KnowledgeProtocol";

export interface CandidateNoteConceptSnapshot {
  readonly id: string;
  readonly title: string;
  readonly primaryConcept: Readonly<CandidatePrimaryConcept>;
  readonly markdown: string;
  readonly sourceMessageIds: readonly string[];
  readonly revision: number;
}

export interface CandidateConceptSourceMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface CandidateConceptRelationshipInput {
  readonly id: string;
  readonly relation: string;
  readonly targetLabel: string;
  readonly targetConceptId?: string;
  readonly sourceReferences?: readonly string[];
}

export interface ApprovedCandidateConceptInput {
  readonly approval: {
    readonly kind: "confirmed_create_note";
    readonly approvedAt: string;
  };
  readonly candidate: Readonly<CandidateNoteConceptSnapshot>;
  readonly conceptId: string;
  readonly sourceMessages: readonly CandidateConceptSourceMessage[];
  /** Must already be exact user-authored language with KnowledgeProtocol provenance. */
  readonly userDefinition?: Readonly<ConceptUserDefinition>;
  readonly externalDefinitions?: readonly ConceptContentEntry[];
  readonly relationships?: readonly CandidateConceptRelationshipInput[];
}

export type CandidateConceptConflict =
  | { readonly kind: "new_concept" }
  | { readonly kind: "exact_identity"; readonly conceptId: string }
  | {
      readonly kind: "same_title_distinct_identity";
      readonly conflictingConceptIds: readonly string[];
    };

export interface KnownConceptIdentity {
  readonly id: string;
  readonly title: string;
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

function sourceReference(messageId: string): string {
  return `message:${messageId}`;
}

export function createConceptIdForCandidate(candidateId: string): string {
  const normalized = candidateId.trim();

  if (normalized === "") {
    throw new Error("Candidate ID cannot be empty.");
  }

  return `concept:${normalized}`;
}

/**
 * Report identity/title collisions without ever deciding that equal labels are
 * equal concepts. The caller must explicitly choose any future update/merge.
 */
export function assessCandidateConceptConflict(
  conceptId: string,
  candidateTitle: string,
  knownConcepts: readonly KnownConceptIdentity[]
): CandidateConceptConflict {
  const exact = knownConcepts.find((concept) => concept.id === conceptId);

  if (exact !== undefined) {
    return { kind: "exact_identity", conceptId: exact.id };
  }

  const titleKey = normalizeIdentity(candidateTitle);
  const titleConflicts = knownConcepts
    .filter((concept) => normalizeIdentity(concept.title) === titleKey)
    .map((concept) => concept.id);

  return titleConflicts.length === 0
    ? { kind: "new_concept" }
    : {
        kind: "same_title_distinct_identity",
        conflictingConceptIds: Object.freeze(titleConflicts)
      };
}

/** Extract only explicit links in the candidate's managed relationship section. */
export function extractCandidateRelationshipReferences(
  markdown: string
): readonly CandidateConceptRelationshipInput[] {
  const lines = markdown.split(/\r?\n/u);
  const relationships: CandidateConceptRelationshipInput[] = [];
  const seen = new Set<string>();
  let inRelationshipSection = false;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);

    if (heading !== null) {
      const level = heading[1]?.length ?? 0;
      const label = heading[2]?.trim().replace(/[:：]+$/u, "")
        .toLocaleLowerCase() ?? "";

      if (level === 2) {
        inRelationshipSection = [
          "关系",
          "relation",
          "relations",
          "relationship",
          "relationships"
        ].includes(label);
      } else if (inRelationshipSection && level <= 2) {
        inRelationshipSection = false;
      }

      continue;
    }

    if (!inRelationshipSection) {
      continue;
    }

    for (const match of line.matchAll(/\[\[([^\]|#^]+)(?:\|([^\]]+))?\]\]/gu)) {
      const target = match[1]?.trim() ?? "";
      const alias = match[2]?.trim();
      const targetParts = target.split("/");
      const label = alias === undefined || alias === ""
        ? targetParts[targetParts.length - 1] ?? target
        : alias;
      const key = normalizeIdentity(target);

      if (target === "" || seen.has(key)) {
        continue;
      }

      seen.add(key);
      relationships.push({
        id: `candidate-relation:${relationships.length + 1}:${key}`,
        relation: "related_to",
        targetLabel: label,
        sourceReferences: [`wikilink:${target}`]
      });
    }
  }

  return Object.freeze(relationships);
}

function validateDefinitionSources(
  definition: Readonly<ConceptUserDefinition>,
  candidateSourceIds: ReadonlySet<string>
): void {
  for (const source of definition.sourceRefs) {
    if (
      source.sourceKind === "message_span" &&
      !candidateSourceIds.has(source.messageId)
    ) {
      throw new Error(
        "A user definition source is not part of the approved candidate."
      );
    }
  }
}

/**
 * Pure review-first conversion. It creates no file and has no Obsidian API
 * dependency. Candidate wording is stored as generated interpretation only.
 */
export function createConceptNodeFromApprovedCandidate(
  input: Readonly<ApprovedCandidateConceptInput>
): ConceptNode {
  if (input.approval.kind !== "confirmed_create_note") {
    throw new Error("Candidate approval is required.");
  }

  const candidate = input.candidate;
  const sourceIds = new Set(candidate.sourceMessageIds);
  const userEvidence: UserTextProvenance[] = input.sourceMessages
    .filter((message) =>
      message.role === "user" && sourceIds.has(message.id)
    )
    .map((message) => ({
      sourceKind: "message_span",
      messageId: message.id,
      snapshot: message.content,
      actor: "user"
    }));

  if (input.userDefinition !== undefined) {
    validateDefinitionSources(input.userDefinition, sourceIds);
  }

  const relationshipInputs = input.relationships ??
    extractCandidateRelationshipReferences(candidate.markdown);
  const relationships: ConceptRelationship[] = [];
  const unresolvedItems: ConceptUnresolvedItem[] = [];

  if (input.userDefinition === undefined) {
    unresolvedItems.push({
      id: `candidate:${candidate.id}:user-meaning`,
      kind: "meaning",
      text:
        "No exact user-authored definition has been approved for this concept.",
      alternatives: [],
      status: "open",
      sourceReferences: candidate.sourceMessageIds.map(sourceReference)
    });
  }

  for (const relationship of relationshipInputs) {
    const references = relationship.sourceReferences ?? [];

    if (relationship.targetConceptId === undefined) {
      unresolvedItems.push({
        id: `unresolved:${relationship.id}`,
        kind: "relationship",
        text: `Relationship target "${relationship.targetLabel}" has no stable concept ID.`,
        alternatives: [],
        status: "open",
        sourceReferences: [...references]
      });
      continue;
    }

    relationships.push({
      id: relationship.id,
      relation: relationship.relation,
      targetConceptId: relationship.targetConceptId,
      targetLabel: relationship.targetLabel,
      sourceReferences: [...references]
    });
  }

  return createConceptNode({
    id: input.conceptId,
    title: candidate.title,
    aliases: candidate.primaryConcept.aliases,
    userEvidence,
    ...(input.userDefinition === undefined
      ? {}
      : { userDefinition: input.userDefinition }),
    generatedInterpretations: [{
      id: `candidate:${candidate.id}:markdown`,
      text: candidate.markdown,
      sourceReferences: [
        `candidate:${candidate.id}`,
        ...candidate.sourceMessageIds.map(sourceReference)
      ]
    }],
    standardDefinitions: input.externalDefinitions ?? [],
    relationships,
    unresolvedItems,
    createdAt: input.approval.approvedAt
  });
}
