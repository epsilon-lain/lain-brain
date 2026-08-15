import { normalizeCandidateTitle } from "./CandidateNoteRelations";
import {
  createUserConclusion,
  type UserTextProvenance
} from "./KnowledgeProtocol";

export const BRAIN_GROWTH_SCHEMA_VERSION = 1 as const;

export type ConceptMeaningStatus = "defined" | "ambiguous";
export type ConceptDefinitionUpdateMode =
  | "preserve_user_meaning"
  | "explicit_user_redefinition";
export type ConceptUnresolvedKind =
  | "meaning"
  | "question"
  | "relationship"
  | "interpretation_conflict";
export type ConceptUnresolvedStatus = "open" | "resolved";

/** Exact user-authored meaning. AI or external prose cannot inhabit this field. */
export interface ConceptUserDefinition {
  readonly id: string;
  readonly text: string;
  readonly sourceRefs: readonly UserTextProvenance[];
}

/** Non-authoritative supporting material attached to a concept node. */
export interface ConceptContentEntry {
  readonly id: string;
  readonly text: string;
  readonly sourceReferences: readonly string[];
  /** Mechanical state for non-authoritative generated/external material. */
  readonly derivedStatus?: "current" | "stale";
  readonly dependencies?: readonly ConceptDependencyReference[];
  readonly staleBecauseDeltaId?: string;
}

export interface ConceptDependencyReference {
  readonly conceptId: string;
  readonly conceptRevision: number;
}

/** An explicit edge. The target ID, not its display label, is its identity. */
export interface ConceptRelationship {
  readonly id: string;
  readonly relation: string;
  readonly targetConceptId: string;
  readonly targetLabel: string;
  readonly sourceReferences: readonly string[];
}

export interface ConceptUnresolvedItem {
  readonly id: string;
  readonly kind: ConceptUnresolvedKind;
  readonly text: string;
  readonly alternatives: readonly string[];
  readonly status: ConceptUnresolvedStatus;
  readonly resolution?: string;
  readonly sourceReferences: readonly string[];
}

export interface ConceptNodeSnapshot {
  readonly revision: number;
  readonly title: string;
  readonly aliases: readonly string[];
  /** Exact user language relevant to the node, without claiming it is a definition. */
  readonly userEvidence: readonly UserTextProvenance[];
  readonly userDefinition?: ConceptUserDefinition;
  readonly alternativeUserDefinitions: readonly ConceptUserDefinition[];
  /** Reviewed candidate/AI wording; never authoritative user meaning. */
  readonly generatedInterpretations: readonly ConceptContentEntry[];
  readonly standardDefinitions: readonly ConceptContentEntry[];
  readonly examples: readonly ConceptContentEntry[];
  readonly counterexamples: readonly ConceptContentEntry[];
  readonly relationships: readonly ConceptRelationship[];
  readonly unresolvedItems: readonly ConceptUnresolvedItem[];
}

export interface ConceptHistoryEntry {
  /** Revision captured immediately before a meaningful change. */
  readonly revision: number;
  readonly changedAt: string;
  readonly reason: string;
  readonly snapshot: ConceptNodeSnapshot;
}

export interface ConceptNode extends ConceptNodeSnapshot {
  readonly schemaVersion: typeof BRAIN_GROWTH_SCHEMA_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history: readonly ConceptHistoryEntry[];
}

export interface CreateConceptNodeInput {
  readonly id: string;
  readonly title: string;
  readonly aliases?: readonly string[];
  readonly userEvidence?: readonly UserTextProvenance[];
  readonly userDefinition?: ConceptUserDefinition;
  readonly generatedInterpretations?: readonly ConceptContentEntry[];
  readonly standardDefinitions?: readonly ConceptContentEntry[];
  readonly examples?: readonly ConceptContentEntry[];
  readonly counterexamples?: readonly ConceptContentEntry[];
  readonly relationships?: readonly ConceptRelationship[];
  readonly unresolvedItems?: readonly ConceptUnresolvedItem[];
  readonly createdAt: string;
}

export interface ConceptNodeUpdate {
  readonly title?: string;
  /** Aliases are merged. Existing aliases are never silently removed. */
  readonly aliases?: readonly string[];
  /** Explicit maintenance review may replace the complete alias set. */
  readonly aliasesMode?: "merge" | "replace";
  readonly userEvidence?: readonly UserTextProvenance[];
  readonly userDefinition?: ConceptUserDefinition;
  readonly userDefinitionMode?: ConceptDefinitionUpdateMode;
  readonly generatedInterpretations?: readonly ConceptContentEntry[];
  /** Explicit propagation/maintenance may replace generated derived state. */
  readonly generatedInterpretationsMode?: "merge" | "replace";
  readonly standardDefinitions?: readonly ConceptContentEntry[];
  readonly examples?: readonly ConceptContentEntry[];
  readonly counterexamples?: readonly ConceptContentEntry[];
  readonly relationships?: readonly ConceptRelationship[];
  /** Explicit maintenance review may replace the complete relationship set. */
  readonly relationshipsMode?: "merge" | "replace";
  readonly unresolvedItems?: readonly ConceptUnresolvedItem[];
  /** Explicit maintenance review may replace resolved/unresolved item state. */
  readonly unresolvedItemsMode?: "merge" | "replace";
}

export interface ConceptChange {
  readonly changedAt: string;
  readonly reason: string;
}

interface ConceptNodeContent {
  title: string;
  aliases: ConceptNodeSnapshot["aliases"];
  userEvidence: ConceptNodeSnapshot["userEvidence"];
  userDefinition?: ConceptUserDefinition;
  alternativeUserDefinitions: ConceptNodeSnapshot[
  "alternativeUserDefinitions"
  ];
  generatedInterpretations: ConceptNodeSnapshot["generatedInterpretations"];
  standardDefinitions: ConceptNodeSnapshot["standardDefinitions"];
  examples: ConceptNodeSnapshot["examples"];
  counterexamples: ConceptNodeSnapshot["counterexamples"];
  relationships: ConceptNodeSnapshot["relationships"];
  unresolvedItems: ConceptNodeSnapshot["unresolvedItems"];
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const UNSAFE_CONTENT_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function deepClone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(
    value as Record<string, unknown>
  )) {
    clone[key] = deepClone(child);
  }
  return clone as T;
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

function requireText(name: string, value: string, maximum = 4000): string {
  const normalized = value.trim();
  if (
    normalized === "" ||
    normalized.length > maximum ||
    CONTROL_CHARACTERS.test(normalized)
  ) {
    throw new Error(`${name} must be non-empty safe text.`);
  }
  return normalized;
}

function requireContentText(name: string, value: string): string {
  const normalized = value.trim();

  if (
    normalized === "" ||
    normalized.length > 100_000 ||
    UNSAFE_CONTENT_CONTROL_CHARACTERS.test(normalized)
  ) {
    throw new Error(`${name} must be non-empty safe content.`);
  }

  return normalized;
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

function normalizeReferences(values: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = requireText("Source reference", value, 1000);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return Object.freeze(result);
}

function materializeUserEvidenceText(
  source: Readonly<UserTextProvenance>
): string {
  if (source.sourceKind === "user_edit") {
    return source.snapshot;
  }

  return source.snapshot.slice(
    source.startOffset ?? 0,
    source.endOffset ?? source.snapshot.length
  );
}

function userEvidenceKey(source: Readonly<UserTextProvenance>): string {
  return source.sourceKind === "user_edit"
    ? `edit:${source.editId}`
    : [
        "message",
        source.messageId,
        source.startOffset ?? 0,
        source.endOffset ?? source.snapshot.length
      ].join(":");
}

function normalizeUserEvidence(
  values: readonly UserTextProvenance[],
  createdAt: string
): readonly UserTextProvenance[] {
  const result: UserTextProvenance[] = [];
  const seen = new Set<string>();

  for (const raw of values) {
    const text = materializeUserEvidenceText(raw);
    const validated = createUserConclusion({
      id: `concept-evidence:${userEvidenceKey(raw)}`,
      text,
      sourceRefs: [raw],
      kind: "other",
      protocolArtifactIds: [],
      createdAt
    });
    const source = validated.sourceRefs[0]!;
    const key = userEvidenceKey(source);

    if (!seen.has(key)) {
      seen.add(key);
      result.push(source);
    }
  }

  return deepFreeze(result);
}

function mergeUserEvidence(
  existing: readonly UserTextProvenance[],
  incoming: readonly UserTextProvenance[],
  createdAt: string
): readonly UserTextProvenance[] {
  return normalizeUserEvidence([...existing, ...incoming], createdAt);
}

function normalizeAliases(
  existing: readonly string[],
  incoming: readonly string[],
  title: string
): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>([normalizeIdentity(title)]);
  for (const value of [...existing, ...incoming]) {
    const alias = requireText("Concept alias", value, 70);
    const key = normalizeIdentity(alias);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(alias);
    }
  }
  return Object.freeze(result);
}

function normalizeUserDefinition(
  definition: Readonly<ConceptUserDefinition>,
  createdAt: string
): ConceptUserDefinition {
  const id = requireText("Definition ID", definition.id, 200);
  const text = requireText("User definition", definition.text);
  const validated = createUserConclusion({
    id: `concept-definition:${id}`,
    text,
    sourceRefs: definition.sourceRefs,
    kind: "definition",
    protocolArtifactIds: [],
    createdAt
  });
  return deepFreeze({
    id,
    text: validated.text,
    sourceRefs: deepClone(validated.sourceRefs)
  });
}

function normalizeContentEntry(
  entry: Readonly<ConceptContentEntry>
): ConceptContentEntry {
  if (
    entry.derivedStatus !== undefined &&
    entry.derivedStatus !== "current" &&
    entry.derivedStatus !== "stale"
  ) {
    throw new Error("Unknown derived content status.");
  }
  const dependencies = (entry.dependencies ?? []).map((dependency) => {
    if (
      !Number.isInteger(dependency.conceptRevision) ||
      dependency.conceptRevision < 1
    ) {
      throw new Error("Dependency revision must be a positive integer.");
    }
    return Object.freeze({
      conceptId: requireText(
        "Dependency concept ID",
        dependency.conceptId,
        200
      ),
      conceptRevision: dependency.conceptRevision
    });
  });
  return deepFreeze({
    id: requireText("Content entry ID", entry.id, 200),
    text: requireContentText("Content entry", entry.text),
    sourceReferences: normalizeReferences(entry.sourceReferences),
    ...(entry.derivedStatus === undefined
      ? {}
      : { derivedStatus: entry.derivedStatus }),
    ...(dependencies.length === 0
      ? {}
      : { dependencies: Object.freeze(dependencies) }),
    ...(entry.staleBecauseDeltaId === undefined
      ? {}
      : {
          staleBecauseDeltaId: requireText(
            "Stale semantic-delta ID",
            entry.staleBecauseDeltaId,
            200
          )
        })
  });
}

function normalizeRelationship(
  relationship: Readonly<ConceptRelationship>
): ConceptRelationship {
  return deepFreeze({
    id: requireText("Relationship ID", relationship.id, 200),
    relation: requireText("Relationship type", relationship.relation, 100),
    targetConceptId: requireText(
      "Relationship target ID",
      relationship.targetConceptId,
      200
    ),
    targetLabel: requireText(
      "Relationship target label",
      relationship.targetLabel,
      70
    ),
    sourceReferences: normalizeReferences(relationship.sourceReferences)
  });
}

function normalizeUnresolvedItem(
  item: Readonly<ConceptUnresolvedItem>
): ConceptUnresolvedItem {
  if (
    item.kind !== "meaning" &&
    item.kind !== "question" &&
    item.kind !== "relationship" &&
    item.kind !== "interpretation_conflict"
  ) {
    throw new Error("Unknown unresolved-item kind.");
  }
  if (item.status !== "open" && item.status !== "resolved") {
    throw new Error("Unknown unresolved-item status.");
  }
  const resolution = item.resolution === undefined
    ? undefined
    : requireText("Resolution", item.resolution);
  if (item.status === "resolved" && resolution === undefined) {
    throw new Error("Resolved items require a resolution.");
  }
  if (item.status === "open" && resolution !== undefined) {
    throw new Error("Open items cannot already have a resolution.");
  }
  return deepFreeze({
    id: requireText("Unresolved item ID", item.id, 200),
    kind: item.kind,
    text: requireText("Unresolved item", item.text),
    alternatives: Object.freeze(
      [...new Map(item.alternatives.map((value) => {
        const text = requireText("Meaning alternative", value);
        return [normalizeIdentity(text), text] as const;
      })).values()]
    ),
    status: item.status,
    ...(resolution === undefined ? {} : { resolution }),
    sourceReferences: normalizeReferences(item.sourceReferences)
  });
}

function appendUniqueEntries(
  existing: readonly ConceptContentEntry[],
  incoming: readonly ConceptContentEntry[]
): readonly ConceptContentEntry[] {
  const result = [...existing];
  const ids = new Map(result.map((entry) => [entry.id, entry]));
  const texts = new Set(result.map((entry) => normalizeIdentity(entry.text)));
  for (const raw of incoming) {
    const entry = normalizeContentEntry(raw);
    const sameId = ids.get(entry.id);
    if (sameId !== undefined) {
      if (normalizeIdentity(sameId.text) !== normalizeIdentity(entry.text)) {
        throw new Error(`Content entry ID "${entry.id}" is already in use.`);
      }
      continue;
    }
    if (texts.has(normalizeIdentity(entry.text))) {
      continue;
    }
    ids.set(entry.id, entry);
    texts.add(normalizeIdentity(entry.text));
    result.push(entry);
  }
  return Object.freeze(result);
}

function relationshipKey(
  relationship: Readonly<ConceptRelationship>
): string {
  return JSON.stringify([
    normalizeIdentity(relationship.relation),
    relationship.targetConceptId
  ]);
}

function appendUniqueRelationships(
  existing: readonly ConceptRelationship[],
  incoming: readonly ConceptRelationship[]
): readonly ConceptRelationship[] {
  const result = [...existing];
  const ids = new Map(result.map((entry) => [entry.id, entry]));
  const keys = new Set(result.map(relationshipKey));
  for (const raw of incoming) {
    const relationship = normalizeRelationship(raw);
    const sameId = ids.get(relationship.id);
    if (sameId !== undefined) {
      if (relationshipKey(sameId) !== relationshipKey(relationship)) {
        throw new Error(
          `Relationship ID "${relationship.id}" is already in use.`
        );
      }
      continue;
    }
    const key = relationshipKey(relationship);
    if (keys.has(key)) {
      continue;
    }
    ids.set(relationship.id, relationship);
    keys.add(key);
    result.push(relationship);
  }
  return Object.freeze(result);
}

function appendUniqueUnresolvedItems(
  existing: readonly ConceptUnresolvedItem[],
  incoming: readonly ConceptUnresolvedItem[]
): readonly ConceptUnresolvedItem[] {
  const result = [...existing];
  const ids = new Map(result.map((entry) => [entry.id, entry]));
  for (const raw of incoming) {
    const item = normalizeUnresolvedItem(raw);
    const sameId = ids.get(item.id);
    if (sameId !== undefined) {
      if (normalizeIdentity(sameId.text) !== normalizeIdentity(item.text)) {
        throw new Error(`Unresolved item ID "${item.id}" is already in use.`);
      }
      continue;
    }
    ids.set(item.id, item);
    result.push(item);
  }
  return Object.freeze(result);
}

function appendAlternativeDefinition(
  existing: readonly ConceptUserDefinition[],
  incoming: ConceptUserDefinition
): readonly ConceptUserDefinition[] {
  if (
    existing.some((item) =>
      item.id === incoming.id ||
      normalizeIdentity(item.text) === normalizeIdentity(incoming.text)
    )
  ) {
    return existing;
  }
  return Object.freeze([...existing, incoming]);
}

function contentFromNode(node: Readonly<ConceptNode>): ConceptNodeContent {
  return {
    title: node.title,
    aliases: node.aliases,
    userEvidence: node.userEvidence,
    ...(node.userDefinition === undefined
      ? {} : { userDefinition: node.userDefinition }),
    alternativeUserDefinitions: node.alternativeUserDefinitions,
    generatedInterpretations: node.generatedInterpretations,
    standardDefinitions: node.standardDefinitions,
    examples: node.examples,
    counterexamples: node.counterexamples,
    relationships: node.relationships,
    unresolvedItems: node.unresolvedItems
  };
}

function snapshotFromNode(
  node: Readonly<ConceptNode>
): ConceptNodeSnapshot {
  return deepFreeze(deepClone({
    revision: node.revision,
    ...contentFromNode(node)
  }));
}

function validateChange(change: Readonly<ConceptChange>): ConceptChange {
  return {
    changedAt: requireText("Change timestamp", change.changedAt, 100),
    reason: requireText("Change reason", change.reason, 500)
  };
}

function commitConceptChange(
  node: Readonly<ConceptNode>,
  content: ConceptNodeContent,
  rawChange: Readonly<ConceptChange>
): ConceptNode {
  if (JSON.stringify(contentFromNode(node)) === JSON.stringify(content)) {
    return node;
  }
  const change = validateChange(rawChange);
  const historyEntry: ConceptHistoryEntry = deepFreeze({
    revision: node.revision,
    changedAt: change.changedAt,
    reason: change.reason,
    snapshot: snapshotFromNode(node)
  });
  return deepFreeze({
    schemaVersion: BRAIN_GROWTH_SCHEMA_VERSION,
    id: node.id,
    createdAt: node.createdAt,
    updatedAt: change.changedAt,
    revision: node.revision + 1,
    ...deepClone(content),
    history: [...node.history, historyEntry]
  });
}

/** Create a concept aggregate without inferring identity from its title. */
export function createConceptNode(
  input: Readonly<CreateConceptNodeInput>
): ConceptNode {
  const createdAt = requireText("Creation timestamp", input.createdAt, 100);
  const titleInput = requireText("Concept title", input.title, 200);
  const title = normalizeCandidateTitle(titleInput, titleInput);
  const userDefinition = input.userDefinition === undefined
    ? undefined
    : normalizeUserDefinition(input.userDefinition, createdAt);
  return deepFreeze({
    schemaVersion: BRAIN_GROWTH_SCHEMA_VERSION,
    id: requireText("Concept ID", input.id, 200),
    title,
    aliases: normalizeAliases([], input.aliases ?? [], title),
    userEvidence: normalizeUserEvidence(
      input.userEvidence ?? [],
      createdAt
    ),
    ...(userDefinition === undefined ? {} : { userDefinition }),
    alternativeUserDefinitions: Object.freeze([]),
    generatedInterpretations: appendUniqueEntries(
      [], input.generatedInterpretations ?? []
    ),
    standardDefinitions: appendUniqueEntries(
      [], input.standardDefinitions ?? []
    ),
    examples: appendUniqueEntries([], input.examples ?? []),
    counterexamples: appendUniqueEntries([], input.counterexamples ?? []),
    relationships: appendUniqueRelationships(
      [], input.relationships ?? []
    ),
    unresolvedItems: appendUniqueUnresolvedItems(
      [], input.unresolvedItems ?? []
    ),
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    history: Object.freeze([])
  });
}

/**
 * Grow one known concept node. A different user definition is preserved as an
 * unresolved alternative unless an explicit user redefinition is requested.
 */
export function updateConceptNode(
  node: Readonly<ConceptNode>,
  update: Readonly<ConceptNodeUpdate>,
  change: Readonly<ConceptChange>
): ConceptNode {
  const content = contentFromNode(node);
  if (update.title !== undefined) {
    const titleInput = requireText("Concept title", update.title, 200);
    content.title = normalizeCandidateTitle(titleInput, titleInput);
  }
  content.aliases = normalizeAliases(
    update.aliasesMode === "replace" ? [] : node.aliases,
    update.aliases ?? [],
    content.title
  );
  content.userEvidence = mergeUserEvidence(
    content.userEvidence,
    update.userEvidence ?? [],
    change.changedAt
  );
  if (update.userDefinition !== undefined) {
    const incoming = normalizeUserDefinition(
      update.userDefinition,
      change.changedAt
    );
    if (content.userDefinition === undefined) {
      content.userDefinition = incoming;
    } else if (
      normalizeIdentity(content.userDefinition.text) !==
        normalizeIdentity(incoming.text)
    ) {
      if (
        update.userDefinitionMode === "explicit_user_redefinition"
      ) {
        content.userDefinition = incoming;
        content.alternativeUserDefinitions = Object.freeze([]);
      } else {
        content.alternativeUserDefinitions = appendAlternativeDefinition(
          content.alternativeUserDefinitions,
          incoming
        );
      }
    }
  }
  content.generatedInterpretations = appendUniqueEntries(
    update.generatedInterpretationsMode === "replace"
      ? []
      : content.generatedInterpretations,
    update.generatedInterpretations ?? []
  );
  content.standardDefinitions = appendUniqueEntries(
    content.standardDefinitions,
    update.standardDefinitions ?? []
  );
  content.examples = appendUniqueEntries(
    content.examples,
    update.examples ?? []
  );
  content.counterexamples = appendUniqueEntries(
    content.counterexamples,
    update.counterexamples ?? []
  );
  content.relationships = appendUniqueRelationships(
    update.relationshipsMode === "replace"
      ? []
      : content.relationships,
    update.relationships ?? []
  );
  content.unresolvedItems = appendUniqueUnresolvedItems(
    update.unresolvedItemsMode === "replace"
      ? []
      : content.unresolvedItems,
    update.unresolvedItems ?? []
  );
  return commitConceptChange(node, content, change);
}

export function addConceptRelationship(
  node: Readonly<ConceptNode>,
  relationship: Readonly<ConceptRelationship>,
  change: Readonly<ConceptChange>
): ConceptNode {
  return updateConceptNode(node, { relationships: [relationship] }, change);
}

export function updateConceptRelationship(
  node: Readonly<ConceptNode>,
  relationshipId: string,
  replacement: Readonly<Omit<ConceptRelationship, "id">>,
  change: Readonly<ConceptChange>
): ConceptNode {
  const index = node.relationships.findIndex(
    (relationship) => relationship.id === relationshipId
  );
  if (index === -1) {
    throw new Error("Relationship was not found.");
  }
  const normalized = normalizeRelationship({
    id: relationshipId,
    ...replacement
  });
  if (node.relationships.some((relationship, otherIndex) =>
    otherIndex !== index &&
    relationshipKey(relationship) === relationshipKey(normalized)
  )) {
    throw new Error("The updated relationship would be a duplicate.");
  }
  const relationships = [...node.relationships];
  relationships[index] = normalized;
  return commitConceptChange(
    node,
    { ...contentFromNode(node), relationships: Object.freeze(relationships) },
    change
  );
}

export function removeConceptRelationship(
  node: Readonly<ConceptNode>,
  relationshipId: string,
  change: Readonly<ConceptChange>
): ConceptNode {
  const relationships = node.relationships.filter(
    (relationship) => relationship.id !== relationshipId
  );
  return commitConceptChange(
    node,
    { ...contentFromNode(node), relationships: Object.freeze(relationships) },
    change
  );
}

export function findMissingConceptReferences(
  node: Readonly<ConceptNode>,
  knownConceptIds: ReadonlySet<string>
): readonly ConceptRelationship[] {
  return Object.freeze(node.relationships.filter(
    (relationship) => !knownConceptIds.has(relationship.targetConceptId)
  ));
}

/** Explicit clarification promotes one preserved meaning and clears alternatives. */
export function resolveConceptMeaning(
  node: Readonly<ConceptNode>,
  definitionId: string,
  change: Readonly<ConceptChange>
): ConceptNode {
  const chosen = [
    ...(node.userDefinition === undefined ? [] : [node.userDefinition]),
    ...node.alternativeUserDefinitions
  ].find((definition) => definition.id === definitionId);
  if (chosen === undefined) {
    throw new Error("Meaning alternative was not found.");
  }
  return commitConceptChange(
    node,
    {
      ...contentFromNode(node),
      userDefinition: chosen,
      alternativeUserDefinitions: Object.freeze([])
    },
    change
  );
}

export function resolveConceptUnresolvedItem(
  node: Readonly<ConceptNode>,
  unresolvedItemId: string,
  resolution: string,
  change: Readonly<ConceptChange>
): ConceptNode {
  const index = node.unresolvedItems.findIndex(
    (item) => item.id === unresolvedItemId
  );
  if (index === -1) {
    throw new Error("Unresolved item was not found.");
  }
  const items = [...node.unresolvedItems];
  items[index] = normalizeUnresolvedItem({
    ...items[index]!,
    status: "resolved",
    resolution
  });
  return commitConceptChange(
    node,
    { ...contentFromNode(node), unresolvedItems: Object.freeze(items) },
    change
  );
}

export function getConceptMeaningStatus(
  node: Readonly<ConceptNode>
): ConceptMeaningStatus {
  return (
    node.userDefinition === undefined ||
    node.alternativeUserDefinitions.length > 0 ||
    node.unresolvedItems.some(
      (item) => item.kind === "meaning" && item.status === "open"
    )
  ) ? "ambiguous" : "defined";
}

export function getConceptRevision(
  node: Readonly<ConceptNode>,
  revision: number
): ConceptNodeSnapshot | undefined {
  if (revision === node.revision) {
    return snapshotFromNode(node);
  }
  return node.history.find((entry) => entry.revision === revision)?.snapshot;
}

export function restoreConceptRevision(
  node: Readonly<ConceptNode>,
  revision: number,
  change: Readonly<ConceptChange>
): ConceptNode {
  const snapshot = getConceptRevision(node, revision);
  if (snapshot === undefined) {
    throw new Error("Concept revision was not found.");
  }
  return commitConceptChange(node, {
    title: snapshot.title,
    aliases: snapshot.aliases,
    userEvidence: snapshot.userEvidence,
    ...(snapshot.userDefinition === undefined
      ? {} : { userDefinition: snapshot.userDefinition }),
    alternativeUserDefinitions: snapshot.alternativeUserDefinitions,
    generatedInterpretations: snapshot.generatedInterpretations,
    standardDefinitions: snapshot.standardDefinitions,
    examples: snapshot.examples,
    counterexamples: snapshot.counterexamples,
    relationships: snapshot.relationships,
    unresolvedItems: snapshot.unresolvedItems
  }, change);
}

function renderEntries(entries: readonly ConceptContentEntry[]): string {
  return entries.map((entry) => `- ${entry.text}`).join("\n");
}

function renderSnapshotBody(snapshot: Readonly<ConceptNodeSnapshot>): string {
  const sections: string[] = [`# ${snapshot.title}`];
  if (snapshot.userDefinition !== undefined) {
    sections.push(`## My definition\n\n${snapshot.userDefinition.text}`);
  }
  if (snapshot.alternativeUserDefinitions.length > 0) {
    sections.push(
      "## Unresolved meaning alternatives\n\n" +
      snapshot.alternativeUserDefinitions
        .map((definition) => `- ${definition.text}`)
        .join("\n")
    );
  }
  if (snapshot.generatedInterpretations.length > 0) {
    sections.push(
      `## Reviewed generated interpretation\n\n${renderEntries(
        snapshot.generatedInterpretations
      )}`
    );
  }
  if (snapshot.standardDefinitions.length > 0) {
    sections.push(
      `## Standard or external definitions\n\n${renderEntries(
        snapshot.standardDefinitions
      )}`
    );
  }
  if (snapshot.examples.length > 0) {
    sections.push(`## Examples\n\n${renderEntries(snapshot.examples)}`);
  }
  if (snapshot.counterexamples.length > 0) {
    sections.push(
      `## Counterexamples\n\n${renderEntries(snapshot.counterexamples)}`
    );
  }
  if (snapshot.relationships.length > 0) {
    sections.push(
      "## Relationships\n\n" +
      snapshot.relationships.map((relationship) =>
        `- ${relationship.relation} → ${relationship.targetLabel} ` +
        `(${relationship.targetConceptId})`
      ).join("\n")
    );
  }
  if (snapshot.unresolvedItems.length > 0) {
    sections.push(
      "## Unresolved questions and ambiguity\n\n" +
      snapshot.unresolvedItems.map((item) =>
        `- [${item.status}] ${item.text}` +
        (item.resolution === undefined ? "" : ` — ${item.resolution}`)
      ).join("\n")
    );
  }
  return sections.join("\n\n");
}

/** Readable Markdown projection; it performs no Vault write. */
export function renderConceptNodeMarkdown(
  node: Readonly<ConceptNode>
): string {
  const frontmatter = [
    "---",
    "lain-brain-type: concept-node",
    `lain-brain-concept-id: ${JSON.stringify(node.id)}`,
    `lain-brain-concept-revision: ${node.revision}`,
    `lain-brain-concept-status: ${getConceptMeaningStatus(node)}`,
    "---"
  ].join("\n");
  const history = node.history.length === 0
    ? ""
    : "\n\n## Concept history\n\n" + node.history.map((entry) =>
        `- Revision ${entry.revision} — ${entry.reason} (${entry.changedAt})`
      ).join("\n");
  return `${frontmatter}\n\n${renderSnapshotBody(node)}${history}\n`;
}

/** Render one exact prior semantic state for review without mutating the node. */
export function renderConceptRevisionMarkdown(
  node: Readonly<ConceptNode>,
  revision: number
): string | undefined {
  const snapshot = getConceptRevision(node, revision);
  return snapshot === undefined ? undefined : renderSnapshotBody(snapshot);
}
