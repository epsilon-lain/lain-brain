import {
  createConceptNode,
  getConceptMeaningStatus,
  type ConceptNode,
  type ConceptUnresolvedItem,
  type ConceptUserDefinition
} from "./BrainGrowth";
import { normalizeConceptLookupText } from "./BrainGrowthIndex";
import {
  inspectConceptMarkdown,
  serializeConceptNodeIntoMarkdown,
  type OrdinaryMarkdownMigrationOrigin
} from "./BrainGrowthPersistence";
import type { UserTextProvenance } from "./KnowledgeProtocol";

export interface ConceptMigrationDraft {
  readonly conceptId: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly userDefinitionText: string;
  readonly userEvidenceText: string;
  readonly generatedInterpretationText: string;
  readonly standardDefinitionText: string;
  readonly unresolvedMaterialText: string;
}

export interface ConceptMigrationSemanticMapping {
  readonly userDefinitionText: string;
  readonly userEvidenceText: string;
  readonly generatedInterpretationText: string;
  readonly standardDefinitionText: string;
  readonly unresolvedMaterialText: string;
}

export type ConceptMigrationDiffKind =
  | "stable_identity"
  | "title"
  | "aliases"
  | "personal_definition"
  | "user_evidence"
  | "generated_interpretation"
  | "standard_definition"
  | "unresolved_material"
  | "meaning_status";

export interface ConceptMigrationDiff {
  readonly kind: ConceptMigrationDiffKind;
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

export interface ConceptMigrationLabelCollision {
  readonly conceptId: string;
  readonly title: string;
  readonly matchedLabels: readonly string[];
}

export interface PreparedConceptMigration {
  readonly kind: "prepared";
  readonly migrationId: string;
  readonly sourceVaultPath: string;
  readonly sourceMarkdown: string;
  readonly draft: ConceptMigrationDraft;
  readonly concept: ConceptNode;
  readonly origin: OrdinaryMarkdownMigrationOrigin;
  readonly mapping: ConceptMigrationSemanticMapping;
  readonly diff: readonly ConceptMigrationDiff[];
  readonly markdown: string;
  readonly labelCollisions: readonly ConceptMigrationLabelCollision[];
}

export type ConceptMigrationFailureCode =
  | "invalid_source_path"
  | "source_not_ordinary"
  | "source_invalid_concept_metadata"
  | "source_unsupported_schema_version"
  | "identity_required"
  | "conflicting_identity"
  | "invalid_draft";

export interface FailedConceptMigration {
  readonly kind: "failed";
  readonly code: ConceptMigrationFailureCode;
  readonly message: string;
}

export type ConceptMigrationPreparationResult =
  | PreparedConceptMigration
  | FailedConceptMigration;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function failure(
  code: ConceptMigrationFailureCode,
  message: string
): FailedConceptMigration {
  return Object.freeze({ kind: "failed", code, message });
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function hashConceptMigrationSourceMarkdown(markdown: string): string {
  return `fnv1a32:${stableHash(markdown)}`;
}

function titleFromVaultPath(vaultPath: string): string {
  const slashPath = vaultPath.replace(/\\/gu, "/");
  const fileName = slashPath.slice(slashPath.lastIndexOf("/") + 1);
  return fileName.replace(/\.md$/iu, "");
}

/** Create an inert draft. The complete note begins in the unresolved bucket. */
export function createConceptMigrationDraft(input: {
  readonly sourceVaultPath: string;
  readonly sourceMarkdown: string;
}): ConceptMigrationDraft {
  return deepFreeze({
    conceptId: "",
    title: titleFromVaultPath(input.sourceVaultPath),
    aliases: [],
    userDefinitionText: "",
    userEvidenceText: "",
    generatedInterpretationText: "",
    standardDefinitionText: "",
    unresolvedMaterialText: input.sourceMarkdown
  });
}

function reviewedText(value: string): string {
  return value.trim();
}

function userEdit(
  editId: string,
  snapshot: string
): UserTextProvenance {
  return Object.freeze({
    sourceKind: "user_edit",
    editId,
    snapshot,
    actor: "user"
  });
}

function createMapping(
  draft: Readonly<ConceptMigrationDraft>
): ConceptMigrationSemanticMapping {
  return deepFreeze({
    userDefinitionText: reviewedText(draft.userDefinitionText),
    userEvidenceText: reviewedText(draft.userEvidenceText),
    generatedInterpretationText: reviewedText(
      draft.generatedInterpretationText
    ),
    standardDefinitionText: reviewedText(draft.standardDefinitionText),
    // This bucket is also the lossless default, so its whitespace is meaningful.
    unresolvedMaterialText: draft.unresolvedMaterialText
  });
}

function migrationDiff(
  concept: Readonly<ConceptNode>,
  mapping: Readonly<ConceptMigrationSemanticMapping>
): readonly ConceptMigrationDiff[] {
  const mapped = (value: string): string => value === "" ? "Not mapped" : value;
  return deepFreeze([
    {
      kind: "stable_identity",
      label: "Stable identity",
      before: "Ordinary Markdown has no ConceptNode identity.",
      after: concept.id
    },
    {
      kind: "title",
      label: "Title handle",
      before: "Ordinary Markdown title or filename",
      after: concept.title
    },
    {
      kind: "aliases",
      label: "Aliases",
      before: "None",
      after: concept.aliases.join(", ") || "None"
    },
    {
      kind: "personal_definition",
      label: "Personal definition - authoritative",
      before: "Not a ConceptNode semantic layer",
      after: mapped(mapping.userDefinitionText)
    },
    {
      kind: "user_evidence",
      label: "Exact user evidence - not yet a definition",
      before: "Not a ConceptNode semantic layer",
      after: mapped(mapping.userEvidenceText)
    },
    {
      kind: "generated_interpretation",
      label: "Generated / AI interpretation - non-authoritative",
      before: "Not a ConceptNode semantic layer",
      after: mapped(mapping.generatedInterpretationText)
    },
    {
      kind: "standard_definition",
      label: "Standard / external meaning - non-authoritative",
      before: "Not a ConceptNode semantic layer",
      after: mapped(mapping.standardDefinitionText)
    },
    {
      kind: "unresolved_material",
      label: "Unresolved / ambiguous material",
      before: "Unclassified ordinary-note material",
      after: mapped(mapping.unresolvedMaterialText)
    },
    {
      kind: "meaning_status",
      label: "Meaning status",
      before: "ordinary_markdown",
      after: getConceptMeaningStatus(concept)
    }
  ]);
}

export function findConceptMigrationLabelCollisions(
  concept: Readonly<Pick<ConceptNode, "id" | "title" | "aliases">>,
  knownConcepts: readonly Readonly<
    Pick<ConceptNode, "id" | "title" | "aliases">
  >[]
): readonly ConceptMigrationLabelCollision[] {
  const labels = [concept.title, ...concept.aliases];
  return deepFreeze(knownConcepts.flatMap((known) => {
    if (known.id === concept.id) {
      return [];
    }
    const knownLabels = new Set(
      [known.title, ...known.aliases].map(normalizeConceptLookupText)
    );
    const matchedLabels = labels.filter((label) =>
      knownLabels.has(normalizeConceptLookupText(label))
    );
    return matchedLabels.length === 0
      ? []
      : [{
          conceptId: known.id,
          title: known.title,
          matchedLabels: [...matchedLabels]
        }];
  }));
}

/**
 * Prepare one explicit ordinary-note migration entirely in memory. No title,
 * filename, alias, or note text is ever used to infer stable identity.
 */
export function prepareConceptMigration(input: {
  readonly sourceVaultPath: string;
  readonly sourceMarkdown: string;
  readonly draft: Readonly<ConceptMigrationDraft>;
  readonly knownConcepts: readonly Readonly<
    Pick<ConceptNode, "id" | "title" | "aliases">
  >[];
  readonly preparedAt: string;
}): ConceptMigrationPreparationResult {
  if (input.sourceVaultPath.trim() === "") {
    return failure("invalid_source_path", "A source Vault path is required.");
  }

  const inspected = inspectConceptMarkdown(input.sourceMarkdown);
  if (inspected.kind === "concept_node") {
    return failure(
      "source_not_ordinary",
      "The selected note is already a ConceptNode."
    );
  }
  if (inspected.kind === "invalid_concept") {
    return inspected.code === "unsupported_schema_version"
      ? failure(
          "source_unsupported_schema_version",
          inspected.message
        )
      : failure("source_invalid_concept_metadata", inspected.message);
  }

  const conceptId = input.draft.conceptId.trim();
  if (conceptId === "") {
    return failure(
      "identity_required",
      "Choose an explicit stable ConceptNode identity before previewing."
    );
  }
  const preparedAt = input.preparedAt.trim();
  if (preparedAt === "" || input.draft.title.trim() === "") {
    return failure(
      "invalid_draft",
      "A reviewed title and migration preparation time are required."
    );
  }
  if (input.knownConcepts.some((concept) => concept.id === conceptId)) {
    return failure(
      "conflicting_identity",
      "A ConceptNode with the chosen stable identity already exists."
    );
  }

  const reviewedDraft: ConceptMigrationDraft = deepFreeze({
    conceptId: input.draft.conceptId,
    title: input.draft.title,
    aliases: [...input.draft.aliases],
    userDefinitionText: input.draft.userDefinitionText,
    userEvidenceText: input.draft.userEvidenceText,
    generatedInterpretationText: input.draft.generatedInterpretationText,
    standardDefinitionText: input.draft.standardDefinitionText,
    unresolvedMaterialText: input.draft.unresolvedMaterialText
  });
  const mapping = createMapping(reviewedDraft);
  const sourceMarkdownHash = hashConceptMigrationSourceMarkdown(
    input.sourceMarkdown
  );
  let reviewedIdentity: ConceptNode;
  try {
    reviewedIdentity = createConceptNode({
      id: conceptId,
      title: reviewedDraft.title,
      aliases: reviewedDraft.aliases,
      createdAt: preparedAt
    });
  } catch {
    return failure(
      "invalid_draft",
      "The reviewed identity or semantic-layer mapping is invalid."
    );
  }
  const labelCollisions = findConceptMigrationLabelCollisions(
    reviewedIdentity,
    input.knownConcepts
  );
  const migrationId = `concept-migration:${stableHash(JSON.stringify({
    sourceVaultPath: input.sourceVaultPath,
    sourceMarkdownHash,
    conceptId,
    title: reviewedDraft.title,
    aliases: reviewedDraft.aliases,
    mapping,
    preparedAt,
    labelCollisions
  }))}`;
  const sourceReference = `${migrationId}:source-note`;
  const definition: ConceptUserDefinition | undefined =
    mapping.userDefinitionText === ""
      ? undefined
      : {
          id: `${migrationId}:definition`,
          text: mapping.userDefinitionText,
          sourceRefs: [userEdit(
            `${migrationId}:definition-review`,
            mapping.userDefinitionText
          )]
        };
  const unresolvedItems: ConceptUnresolvedItem[] = [];
  if (mapping.unresolvedMaterialText.trim() !== "") {
    unresolvedItems.push({
      id: `${migrationId}:unresolved-material`,
      kind: "meaning",
      text: "Reviewed ordinary-note material remains unresolved after migration.",
      sourceMaterial: mapping.unresolvedMaterialText,
      alternatives: [],
      status: "open",
      sourceReferences: [sourceReference]
    });
  } else if (definition === undefined) {
    unresolvedItems.push({
      id: `${migrationId}:missing-definition`,
      kind: "meaning",
      text: "No exact personal definition was approved during migration.",
      alternatives: [],
      status: "open",
      sourceReferences: [sourceReference]
    });
  }

  let concept: ConceptNode;
  try {
    concept = createConceptNode({
      id: conceptId,
      title: reviewedDraft.title,
      aliases: reviewedDraft.aliases,
      userEvidence: mapping.userEvidenceText === ""
        ? []
        : [userEdit(
            `${migrationId}:evidence-review`,
            mapping.userEvidenceText
          )],
      ...(definition === undefined ? {} : { userDefinition: definition }),
      generatedInterpretations: mapping.generatedInterpretationText === ""
        ? []
        : [{
            id: `${migrationId}:generated-interpretation`,
            text: mapping.generatedInterpretationText,
            sourceReferences: [sourceReference]
          }],
      standardDefinitions: mapping.standardDefinitionText === ""
        ? []
        : [{
            id: `${migrationId}:standard-definition`,
            text: mapping.standardDefinitionText,
            sourceReferences: [sourceReference]
          }],
      unresolvedItems,
      createdAt: preparedAt
    });
  } catch {
    return failure(
      "invalid_draft",
      "The reviewed identity or semantic-layer mapping is invalid."
    );
  }

  const origin: OrdinaryMarkdownMigrationOrigin = deepFreeze({
    kind: "ordinary_markdown_migration",
    sourceVaultPath: input.sourceVaultPath,
    preparedAt,
    sourceMarkdownHash
  });
  let markdown: string;
  try {
    markdown = serializeConceptNodeIntoMarkdown(
      input.sourceMarkdown,
      concept,
      origin
    );
  } catch {
    return failure(
      "invalid_draft",
      "The reviewed migration could not be projected into Markdown."
    );
  }

  return deepFreeze({
    kind: "prepared",
    migrationId,
    sourceVaultPath: input.sourceVaultPath,
    sourceMarkdown: input.sourceMarkdown,
    draft: reviewedDraft,
    concept,
    origin,
    mapping,
    diff: migrationDiff(concept, mapping),
    markdown,
    labelCollisions
  });
}
