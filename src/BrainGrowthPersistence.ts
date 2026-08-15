import {
  BRAIN_GROWTH_SCHEMA_VERSION,
  createConceptNode,
  getConceptMeaningStatus,
  type ConceptContentEntry,
  type ConceptHistoryEntry,
  type ConceptNode,
  type ConceptNodeSnapshot,
  type ConceptRelationship,
  type ConceptUnresolvedItem,
  type ConceptUserDefinition
} from "./BrainGrowth";
import type { UserTextProvenance } from "./KnowledgeProtocol";

export const BRAIN_GROWTH_PERSISTENCE_SCHEMA_VERSION = 1 as const;

export interface ConceptPersistenceOrigin {
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly approvedAt: string;
}

export interface PersistedConceptNote {
  readonly conceptNode: ConceptNode;
  readonly origin: ConceptPersistenceOrigin;
}

export type ConceptPersistenceErrorCode =
  | "not_concept_note"
  | "invalid_concept_metadata"
  | "unsupported_schema_version";

export type ConceptMarkdownInspection =
  | { readonly kind: "ordinary_markdown" }
  | {
      readonly kind: "concept_node";
      readonly persisted: PersistedConceptNote;
    }
  | {
      readonly kind: "invalid_concept";
      readonly code: Exclude<
        ConceptPersistenceErrorCode,
        "not_concept_note"
      >;
      readonly message: string;
    };

export class ConceptPersistenceError extends Error {
  constructor(
    readonly code: ConceptPersistenceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ConceptPersistenceError";
  }
}

interface ConceptPersistenceProjection {
  readonly schemaVersion: typeof BRAIN_GROWTH_PERSISTENCE_SCHEMA_VERSION;
  readonly origin: ConceptPersistenceOrigin;
  readonly concept: ConceptNode;
}

const DATA_PREFIX = "<!-- lain-brain-concept-data:v1:";
const DATA_SUFFIX = " -->";
const DATA_PATTERN =
  /<!-- lain-brain-concept-data:v1:([^\s]+) -->/u;
const ANY_DATA_PATTERN =
  /<!-- lain-brain-concept-data:v(\d+):([^\s]+) -->/u;
const MANAGED_FRONTMATTER_KEYS = new Set([
  "lain-brain-type",
  "lain-brain-concept-id",
  "lain-brain-concept-revision",
  "lain-brain-concept-status",
  "lain-brain-concept-aliases",
  "lain-brain-concept-relationships",
  "lain-brain-concept-unresolved",
  "lain-brain-candidate-id"
]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        deepFreeze(child);
      }
    } else {
      for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function requireRecord(name: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireInteger(name: string, value: unknown, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return value as number;
}

function requireArray(name: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  return value;
}

function normalizeDefinition(
  value: unknown,
  createdAt: string
): ConceptUserDefinition {
  const definition = requireRecord("Concept user definition", value);
  const validationNode = createConceptNode({
    id: "persistence-validation-definition",
    title: "Persistence validation",
    userDefinition: definition as unknown as ConceptUserDefinition,
    createdAt
  });

  return validationNode.userDefinition!;
}

function normalizeSnapshot(
  value: unknown,
  createdAt: string
): ConceptNodeSnapshot {
  const raw = requireRecord("Concept snapshot", value);
  const revision = requireInteger("Concept revision", raw.revision, 1);
  const validationNode = createConceptNode({
    id: "persistence-validation-snapshot",
    title: requireString("Concept title", raw.title),
    aliases: requireArray("Concept aliases", raw.aliases) as readonly string[],
    userEvidence: requireArray(
      "Concept user evidence",
      raw.userEvidence
    ) as readonly UserTextProvenance[],
    ...(raw.userDefinition === undefined
      ? {}
      : { userDefinition: raw.userDefinition as ConceptUserDefinition }),
    generatedInterpretations: requireArray(
      "Generated interpretations",
      raw.generatedInterpretations
    ) as readonly ConceptContentEntry[],
    standardDefinitions: requireArray(
      "Standard definitions",
      raw.standardDefinitions
    ) as readonly ConceptContentEntry[],
    examples: requireArray("Concept examples", raw.examples) as
      readonly ConceptContentEntry[],
    counterexamples: requireArray(
      "Concept counterexamples",
      raw.counterexamples
    ) as readonly ConceptContentEntry[],
    relationships: requireArray(
      "Concept relationships",
      raw.relationships
    ) as readonly ConceptRelationship[],
    unresolvedItems: requireArray(
      "Concept unresolved items",
      raw.unresolvedItems
    ) as readonly ConceptUnresolvedItem[],
    createdAt
  });
  const alternatives = requireArray(
    "Alternative user definitions",
    raw.alternativeUserDefinitions
  ).map((definition) => normalizeDefinition(definition, createdAt));

  return deepFreeze({
    revision,
    title: validationNode.title,
    aliases: validationNode.aliases,
    userEvidence: validationNode.userEvidence,
    ...(validationNode.userDefinition === undefined
      ? {}
      : { userDefinition: validationNode.userDefinition }),
    alternativeUserDefinitions: alternatives,
    generatedInterpretations: validationNode.generatedInterpretations,
    standardDefinitions: validationNode.standardDefinitions,
    examples: validationNode.examples,
    counterexamples: validationNode.counterexamples,
    relationships: validationNode.relationships,
    unresolvedItems: validationNode.unresolvedItems
  });
}

function normalizeConceptNode(value: unknown): ConceptNode {
  const raw = requireRecord("Persisted concept", value);

  if (raw.schemaVersion !== BRAIN_GROWTH_SCHEMA_VERSION) {
    throw new Error("Unsupported Brain Growth concept schema version.");
  }

  const id = requireString("Concept ID", raw.id);
  const createdAt = requireString("Concept creation time", raw.createdAt);
  const updatedAt = requireString("Concept update time", raw.updatedAt);
  const snapshot = normalizeSnapshot(raw, createdAt);
  const history = requireArray("Concept history", raw.history).map(
    (value): ConceptHistoryEntry => {
      const entry = requireRecord("Concept history entry", value);
      const revision = requireInteger(
        "History revision",
        entry.revision,
        1
      );
      const historySnapshot = normalizeSnapshot(entry.snapshot, createdAt);

      if (historySnapshot.revision !== revision) {
        throw new Error("History revision does not match its snapshot.");
      }

      return deepFreeze({
        revision,
        changedAt: requireString("History change time", entry.changedAt),
        reason: requireString("History reason", entry.reason),
        snapshot: historySnapshot
      });
    }
  );

  if (history.some((entry) => entry.revision >= snapshot.revision)) {
    throw new Error("Concept history must precede the current revision.");
  }

  return deepFreeze({
    schemaVersion: BRAIN_GROWTH_SCHEMA_VERSION,
    id,
    createdAt,
    updatedAt,
    ...snapshot,
    history
  });
}

function projectConceptNode(node: Readonly<ConceptNode>): ConceptNode {
  return {
    schemaVersion: node.schemaVersion,
    id: node.id,
    revision: node.revision,
    title: node.title,
    aliases: [...node.aliases],
    userEvidence: node.userEvidence.map((source) => ({ ...source })),
    ...(node.userDefinition === undefined
      ? {}
      : {
          userDefinition: {
            ...node.userDefinition,
            sourceRefs: node.userDefinition.sourceRefs.map((source) => ({
              ...source
            }))
          }
        }),
    alternativeUserDefinitions: node.alternativeUserDefinitions.map(
      (definition) => ({
        ...definition,
        sourceRefs: definition.sourceRefs.map((source) => ({ ...source }))
      })
    ),
    generatedInterpretations: node.generatedInterpretations.map((entry) => ({
      ...entry,
      sourceReferences: [...entry.sourceReferences]
    })),
    standardDefinitions: node.standardDefinitions.map((entry) => ({
      ...entry,
      sourceReferences: [...entry.sourceReferences]
    })),
    examples: node.examples.map((entry) => ({
      ...entry,
      sourceReferences: [...entry.sourceReferences]
    })),
    counterexamples: node.counterexamples.map((entry) => ({
      ...entry,
      sourceReferences: [...entry.sourceReferences]
    })),
    relationships: node.relationships.map((relationship) => ({
      ...relationship,
      sourceReferences: [...relationship.sourceReferences]
    })),
    unresolvedItems: node.unresolvedItems.map((item) => ({
      ...item,
      alternatives: [...item.alternatives],
      sourceReferences: [...item.sourceReferences]
    })),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    history: node.history.map((entry) => ({
      revision: entry.revision,
      changedAt: entry.changedAt,
      reason: entry.reason,
      snapshot: projectSnapshot(entry.snapshot)
    }))
  };
}

function projectSnapshot(
  snapshot: Readonly<ConceptNodeSnapshot>
): ConceptNodeSnapshot {
  return {
    revision: snapshot.revision,
    title: snapshot.title,
    aliases: [...snapshot.aliases],
    userEvidence: snapshot.userEvidence.map((source) => ({ ...source })),
    ...(snapshot.userDefinition === undefined
      ? {}
      : {
          userDefinition: {
            ...snapshot.userDefinition,
            sourceRefs: snapshot.userDefinition.sourceRefs.map((source) => ({
              ...source
            }))
          }
        }),
    alternativeUserDefinitions: snapshot.alternativeUserDefinitions.map(
      (definition) => ({
        ...definition,
        sourceRefs: definition.sourceRefs.map((source) => ({ ...source }))
      })
    ),
    generatedInterpretations: snapshot.generatedInterpretations.map(
      (entry) => ({ ...entry, sourceReferences: [...entry.sourceReferences] })
    ),
    standardDefinitions: snapshot.standardDefinitions.map(
      (entry) => ({ ...entry, sourceReferences: [...entry.sourceReferences] })
    ),
    examples: snapshot.examples.map(
      (entry) => ({ ...entry, sourceReferences: [...entry.sourceReferences] })
    ),
    counterexamples: snapshot.counterexamples.map(
      (entry) => ({ ...entry, sourceReferences: [...entry.sourceReferences] })
    ),
    relationships: snapshot.relationships.map((relationship) => ({
      ...relationship,
      sourceReferences: [...relationship.sourceReferences]
    })),
    unresolvedItems: snapshot.unresolvedItems.map((item) => ({
      ...item,
      alternatives: [...item.alternatives],
      sourceReferences: [...item.sourceReferences]
    }))
  };
}

function updateFrontmatter(
  markdown: string,
  node: Readonly<ConceptNode>,
  origin: Readonly<ConceptPersistenceOrigin>
): string {
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/u);
  let bodyLines = lines;
  let existingFrontmatter: string[] = [];

  if (lines[0]?.trim() === "---") {
    const closingIndex = lines.slice(1).findIndex(
      (line) => line.trim() === "---"
    );

    if (closingIndex !== -1) {
      const absoluteClosingIndex = closingIndex + 1;
      existingFrontmatter = lines.slice(1, absoluteClosingIndex).filter(
        (line) => {
          const key = line.match(/^([^:#]+):/u)?.[1]?.trim();
          return key === undefined || !MANAGED_FRONTMATTER_KEYS.has(key);
        }
      );
      bodyLines = lines.slice(absoluteClosingIndex + 1);
    }
  }

  const frontmatter = [
    "---",
    ...existingFrontmatter,
    "lain-brain-type: concept-node",
    `lain-brain-concept-id: ${JSON.stringify(node.id)}`,
    `lain-brain-concept-revision: ${node.revision}`,
    `lain-brain-concept-status: ${getConceptMeaningStatus(node)}`,
    `lain-brain-concept-aliases: ${JSON.stringify(node.aliases)}`,
    `lain-brain-concept-relationships: ${node.relationships.length}`,
    `lain-brain-concept-unresolved: ${node.unresolvedItems.filter(
      (item) => item.status === "open"
    ).length}`,
    `lain-brain-candidate-id: ${JSON.stringify(origin.candidateId)}`,
    "---"
  ];

  return [...frontmatter, ...bodyLines].join(newline).trimEnd();
}

/**
 * Persist a reviewed concept through Markdown only. The readable candidate body
 * stays intact; a versioned, explicitly projected machine record enables reload.
 */
export function serializeConceptNodeIntoMarkdown(
  markdown: string,
  node: Readonly<ConceptNode>,
  origin: Readonly<ConceptPersistenceOrigin>
): string {
  const withoutOldProjection = markdown.replace(DATA_PATTERN, "").trimEnd();
  const projection: ConceptPersistenceProjection = {
    schemaVersion: BRAIN_GROWTH_PERSISTENCE_SCHEMA_VERSION,
    origin: {
      candidateId: origin.candidateId,
      candidateRevision: origin.candidateRevision,
      approvedAt: origin.approvedAt
    },
    concept: projectConceptNode(node)
  };
  const encoded = encodeURIComponent(JSON.stringify(projection));
  const readableMarkdown = updateFrontmatter(
    withoutOldProjection,
    node,
    origin
  );

  return `${readableMarkdown}\n\n${DATA_PREFIX}${encoded}${DATA_SUFFIX}\n`;
}

/** Load one supported concept note without scanning or writing the Vault. */
export function deserializeConceptNodeFromMarkdown(
  markdown: string
): PersistedConceptNote {
  const inspected = inspectConceptMarkdown(markdown);

  if (inspected.kind === "concept_node") {
    return inspected.persisted;
  }
  if (inspected.kind === "ordinary_markdown") {
    throw new ConceptPersistenceError(
      "not_concept_note",
      "The Markdown note is not a Brain Growth concept node."
    );
  }
  throw new ConceptPersistenceError(inspected.code, inspected.message);
}

function hasConceptFrontmatter(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/u);

  if (lines[0]?.trim() !== "---") {
    return false;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "---") {
      return false;
    }
    if (/^lain-brain-type:\s*concept-node\s*$/u.test(line)) {
      return true;
    }
  }

  return false;
}

function loadCurrentProjection(encoded: string): PersistedConceptNote {

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(encoded));
  } catch {
    throw new ConceptPersistenceError(
      "invalid_concept_metadata",
      "Brain Growth concept data is invalid."
    );
  }

  const projection = requireRecord("Concept projection", parsed);

  if (projection.schemaVersion !== BRAIN_GROWTH_PERSISTENCE_SCHEMA_VERSION) {
    throw new ConceptPersistenceError(
      "unsupported_schema_version",
      "Unsupported Brain Growth persistence schema version."
    );
  }

  const rawOrigin = requireRecord("Concept origin", projection.origin);
  const origin = deepFreeze({
    candidateId: requireString("Candidate ID", rawOrigin.candidateId),
    candidateRevision: requireInteger(
      "Candidate revision",
      rawOrigin.candidateRevision
    ),
    approvedAt: requireString("Candidate approval time", rawOrigin.approvedAt)
  });

  return deepFreeze({
    conceptNode: normalizeConceptNode(projection.concept),
    origin
  });
}

/** Classify one Markdown string without scanning or mutating the Vault. */
export function inspectConceptMarkdown(
  markdown: string
): ConceptMarkdownInspection {
  const marker = markdown.match(ANY_DATA_PATTERN);

  if (marker === null) {
    return hasConceptFrontmatter(markdown) ||
      markdown.includes("<!-- lain-brain-concept-data:v")
      ? Object.freeze({
          kind: "invalid_concept",
          code: "invalid_concept_metadata",
          message: "Concept frontmatter has no reloadable Brain Growth data."
        })
      : Object.freeze({ kind: "ordinary_markdown" });
  }

  if (marker[1] !== String(BRAIN_GROWTH_PERSISTENCE_SCHEMA_VERSION)) {
    return Object.freeze({
      kind: "invalid_concept",
      code: "unsupported_schema_version",
      message: `Unsupported Brain Growth persistence schema version ${marker[1]}.`
    });
  }

  try {
    return Object.freeze({
      kind: "concept_node",
      persisted: loadCurrentProjection(marker[2]!)
    });
  } catch (error) {
    if (error instanceof ConceptPersistenceError) {
      return Object.freeze({
        kind: "invalid_concept",
        code: error.code === "unsupported_schema_version"
          ? "unsupported_schema_version"
          : "invalid_concept_metadata",
        message: error.message
      });
    }
    return Object.freeze({
      kind: "invalid_concept",
      code: "invalid_concept_metadata",
      message: "Brain Growth concept metadata failed validation."
    });
  }
}
