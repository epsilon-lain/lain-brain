// ── User Knowledge and Protocol Graph Foundation ───────────────────────
//
// The user's own natural language is the authoritative knowledge layer.
// Semantic interpretation, Lean, evidence, counterexamples, custom-world
// models, and external terminology mappings are optional protocol artifacts.
// They may explain, formalize, support, or refute a UserConclusion, but they
// never replace its user-authored prose.
//
// This module is deliberately backend-neutral and persistence-free. All
// helpers are pure, all returned derived structures are deeply frozen, and
// runtime validation defends the provenance boundary even when untyped data
// reaches the API.

export const USER_CONCLUSION_KINDS = [
  "definition",
  "assumption",
  "mathematical_claim",
  "empirical_claim",
  "custom_world_rule",
  "open_question",
  "intuition",
  "other"
] as const;
export type UserConclusionKind = typeof USER_CONCLUSION_KINDS[number];

export const PROTOCOL_ARTIFACT_KINDS = [
  "semantic",
  "lean",
  "empirical_evidence",
  "counterexample",
  "custom_world",
  "external_mapping"
] as const;
export type ProtocolArtifactKind = typeof PROTOCOL_ARTIFACT_KINDS[number];

export const PROTOCOL_LINK_RELATIONS = [
  "formalizes",
  "supports",
  "refutes",
  "maps_to",
  "analogy",
  "defines"
] as const;
export type ProtocolLinkRelation = typeof PROTOCOL_LINK_RELATIONS[number];

/** An exact slice of a user chat message. */
export interface UserTextSpan {
  readonly sourceKind: "message_span";
  readonly messageId: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly snapshot: string;
  readonly actor: "user";
}

/** Text explicitly authored by the user in a later editor/review surface. */
export interface UserTextEdit {
  readonly sourceKind: "user_edit";
  readonly editId: string;
  readonly snapshot: string;
  readonly actor: "user";
}

export type UserTextProvenance = UserTextSpan | UserTextEdit;

/**
 * The primary knowledge node. `text` is exact user-authored language; it is
 * never synthesized from protocol artifacts. An optional SemanticSpec is a
 * working interpretation, not a permanently user-approved meaning.
 */
export interface UserConclusion {
  readonly id: string;
  readonly text: string;
  readonly sourceRefs: readonly UserTextProvenance[];
  readonly semanticSpecId?: string;
  readonly kind: UserConclusionKind;
  readonly protocolArtifactIds: readonly string[];
  readonly createdAt: string;
}

interface ProtocolArtifactBase {
  readonly id: string;
  readonly userConclusionId: string;
  readonly createdAt: string;
}

export interface SemanticProtocolArtifact extends ProtocolArtifactBase {
  readonly kind: "semantic";
  readonly semanticSpecId: string;
}

export interface LeanProtocolArtifact extends ProtocolArtifactBase {
  readonly kind: "lean";
  readonly formalStatement: string;
  readonly leanArtifactId?: string;
}

export interface EmpiricalEvidenceProtocolArtifact
  extends ProtocolArtifactBase {
  readonly kind: "empirical_evidence";
  readonly description: string;
  readonly sourceReferences: readonly string[];
}

export interface CounterexampleProtocolArtifact extends ProtocolArtifactBase {
  readonly kind: "counterexample";
  readonly description: string;
  readonly sourceReferences: readonly string[];
}

export interface CustomWorldProtocolArtifact extends ProtocolArtifactBase {
  readonly kind: "custom_world";
  readonly conceptName: string;
  readonly status: "defined" | "assumed";
  readonly semanticSpecId?: string;
}

export interface ExternalMappingProtocolArtifact extends ProtocolArtifactBase {
  readonly kind: "external_mapping";
  readonly target: string;
  readonly description?: string;
}

export type ProtocolArtifact =
  | SemanticProtocolArtifact
  | LeanProtocolArtifact
  | EmpiricalEvidenceProtocolArtifact
  | CounterexampleProtocolArtifact
  | CustomWorldProtocolArtifact
  | ExternalMappingProtocolArtifact;

/** An explicit meaning assigned to an attachment; not a truth flag. */
export interface ProtocolLink {
  readonly id: string;
  readonly userConclusionId: string;
  readonly protocolArtifactId: string;
  readonly relation: ProtocolLinkRelation;
  readonly createdAt: string;
}

/**
 * A proposed relationship between natural-language nodes. Proposal authorship
 * and user review are separate: only reviewStatus="accepted" is authoritative.
 */
export interface UserKnowledgeEdge {
  readonly id: string;
  readonly fromUserConclusionId: string;
  readonly toUserConclusionId: string;
  readonly relation: string;
  readonly proposedBy: "user" | "ai";
  readonly reviewStatus: "pending" | "accepted" | "rejected";
  readonly createdAt: string;
  readonly reviewedAt?: string;
}

/**
 * A derived protocol-layer projection. It never replaces or validates the
 * UserKnowledgeEdge from which it was derived.
 */
export interface MirroredProtocolEdge {
  readonly id: string;
  readonly fromProtocolArtifactId: string;
  readonly toProtocolArtifactId: string;
  readonly relation: string;
  readonly protocolKind: ProtocolArtifactKind;
  readonly userKnowledgeEdgeId: string;
  readonly origin: "mirrored_user_edge";
}

export interface KnowledgeProtocolGraph {
  readonly conclusions: readonly UserConclusion[];
  readonly artifacts: readonly ProtocolArtifact[];
  readonly protocolLinks: readonly ProtocolLink[];
  readonly userEdges: readonly UserKnowledgeEdge[];
}

export interface KnowledgeProtocolValidationError {
  readonly path: string;
  readonly message: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOneOf<T extends string>(
  value: unknown,
  choices: readonly T[]
): value is T {
  return typeof value === "string" &&
    (choices as readonly string[]).includes(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined ||
      (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }

  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function deepClone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    clone[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return clone as T;
}

function materializeProvenanceText(
  source: Readonly<UserTextProvenance>,
  path: string,
  errors: KnowledgeProtocolValidationError[]
): string | undefined {
  if (source.actor !== "user") {
    errors.push({
      path: `${path}.actor`,
      message: "Primary knowledge text provenance must be authored by the user."
    });
    return undefined;
  }
  if (!isNonEmptyString(source.snapshot)) {
    errors.push({ path: `${path}.snapshot`, message: "Snapshot cannot be empty." });
    return undefined;
  }

  if (source.sourceKind === "user_edit") {
    if (!isNonEmptyString(source.editId)) {
      errors.push({ path: `${path}.editId`, message: "User edit ID cannot be empty." });
    }
    return source.snapshot;
  }

  if (source.sourceKind !== "message_span") {
    errors.push({ path, message: "Unknown user-text provenance kind." });
    return undefined;
  }
  if (!isNonEmptyString(source.messageId)) {
    errors.push({ path: `${path}.messageId`, message: "Message ID cannot be empty." });
  }

  const hasStart = source.startOffset !== undefined;
  const hasEnd = source.endOffset !== undefined;
  if (hasStart !== hasEnd) {
    errors.push({
      path,
      message: "Message spans must provide both startOffset and endOffset."
    });
    return undefined;
  }
  if (!hasStart || !hasEnd) {
    return source.snapshot;
  }

  const start = source.startOffset!;
  const end = source.endOffset!;
  if (!Number.isInteger(start) || !Number.isInteger(end) ||
      start < 0 || end <= start || end > source.snapshot.length) {
    errors.push({ path, message: "Message span offsets are invalid." });
    return undefined;
  }
  return source.snapshot.slice(start, end);
}

/** Validate a primary knowledge node independently of every optional backend. */
export function validateUserConclusion(
  conclusion: Readonly<UserConclusion>
): KnowledgeProtocolValidationError[] {
  const errors: KnowledgeProtocolValidationError[] = [];
  if (!isNonEmptyString(conclusion.id)) {
    errors.push({ path: "id", message: "Conclusion ID cannot be empty." });
  }
  if (!isNonEmptyString(conclusion.text)) {
    errors.push({ path: "text", message: "Conclusion text cannot be empty." });
  }
  if (!isOneOf(conclusion.kind, USER_CONCLUSION_KINDS)) {
    errors.push({ path: "kind", message: "Unknown conclusion kind." });
  }
  if (!isNonEmptyString(conclusion.createdAt)) {
    errors.push({ path: "createdAt", message: "createdAt cannot be empty." });
  }
  if (conclusion.semanticSpecId !== undefined &&
      !isNonEmptyString(conclusion.semanticSpecId)) {
    errors.push({ path: "semanticSpecId", message: "semanticSpecId cannot be empty." });
  }
  if (!Array.isArray(conclusion.sourceRefs) || conclusion.sourceRefs.length === 0) {
    errors.push({
      path: "sourceRefs",
      message: "Conclusion text requires user-authored provenance."
    });
    return errors;
  }

  const materialized: string[] = [];
  conclusion.sourceRefs.forEach((source, index) => {
    const value = materializeProvenanceText(source, `sourceRefs.${index}`, errors);
    if (value !== undefined) {
      materialized.push(value);
    }
  });
  if (materialized.length === conclusion.sourceRefs.length &&
      materialized.join("") !== conclusion.text) {
    errors.push({
      path: "text",
      message: "Conclusion text must exactly match its user-authored provenance."
    });
  }

  const artifactIds = new Set<string>();
  for (const artifactId of conclusion.protocolArtifactIds) {
    if (!isNonEmptyString(artifactId)) {
      errors.push({
        path: "protocolArtifactIds",
        message: "Protocol artifact IDs cannot be empty."
      });
    } else if (artifactIds.has(artifactId)) {
      errors.push({
        path: "protocolArtifactIds",
        message: `Duplicate protocol artifact ID "${artifactId}".`
      });
    }
    artifactIds.add(artifactId);
  }
  return errors;
}

/** Create one validated, deeply immutable authoritative knowledge node. */
export function createUserConclusion(
  conclusion: Readonly<UserConclusion>
): UserConclusion {
  const errors = validateUserConclusion(conclusion);
  if (errors.length > 0) {
    throw new Error(
      "UserConclusion invariants violated:\n" +
      errors.map((error) => `  ${error.path}: ${error.message}`).join("\n")
    );
  }
  return deepFreeze(deepClone(conclusion)) as UserConclusion;
}

export function validateProtocolArtifact(
  artifact: Readonly<ProtocolArtifact>
): KnowledgeProtocolValidationError[] {
  const errors: KnowledgeProtocolValidationError[] = [];
  if (!isNonEmptyString(artifact.id)) {
    errors.push({ path: "id", message: "Artifact ID cannot be empty." });
  }
  if (!isNonEmptyString(artifact.userConclusionId)) {
    errors.push({
      path: "userConclusionId",
      message: "Artifact must point to a UserConclusion."
    });
  }
  if (!isNonEmptyString(artifact.createdAt)) {
    errors.push({ path: "createdAt", message: "createdAt cannot be empty." });
  }
  if (!isOneOf(artifact.kind, PROTOCOL_ARTIFACT_KINDS)) {
    errors.push({ path: "kind", message: "Unknown protocol artifact kind." });
    return errors;
  }

  switch (artifact.kind) {
    case "semantic":
      if (!isNonEmptyString(artifact.semanticSpecId)) {
        errors.push({ path: "semanticSpecId", message: "semanticSpecId cannot be empty." });
      }
      break;
    case "lean":
      if (!isNonEmptyString(artifact.formalStatement)) {
        errors.push({ path: "formalStatement", message: "Lean statement cannot be empty." });
      }
      break;
    case "empirical_evidence":
    case "counterexample":
      if (!isNonEmptyString(artifact.description)) {
        errors.push({ path: "description", message: "Artifact description cannot be empty." });
      }
      break;
    case "custom_world":
      if (!isNonEmptyString(artifact.conceptName)) {
        errors.push({ path: "conceptName", message: "Custom-world concept cannot be empty." });
      }
      if (artifact.status !== "defined" && artifact.status !== "assumed") {
        errors.push({ path: "status", message: "Unknown custom-world status." });
      }
      break;
    case "external_mapping":
      if (!isNonEmptyString(artifact.target)) {
        errors.push({ path: "target", message: "External mapping target cannot be empty." });
      }
      break;
  }
  return errors;
}

/** Validate references and ownership without making epistemic judgments. */
export function validateKnowledgeProtocolGraph(
  graph: Readonly<KnowledgeProtocolGraph>
): KnowledgeProtocolValidationError[] {
  const errors: KnowledgeProtocolValidationError[] = [];
  const conclusionIds = new Set<string>();
  const artifactIds = new Set<string>();
  const userEdgeIds = new Set<string>();
  const protocolLinkIds = new Set<string>();

  for (const conclusion of graph.conclusions) {
    if (conclusionIds.has(conclusion.id)) {
      errors.push({ path: `conclusions.${conclusion.id}`, message: "Duplicate conclusion ID." });
    }
    conclusionIds.add(conclusion.id);
    for (const error of validateUserConclusion(conclusion)) {
      errors.push({ path: `conclusions.${conclusion.id}.${error.path}`, message: error.message });
    }
  }

  for (const artifact of graph.artifacts) {
    if (artifactIds.has(artifact.id)) {
      errors.push({ path: `artifacts.${artifact.id}`, message: "Duplicate artifact ID." });
    }
    artifactIds.add(artifact.id);
    for (const error of validateProtocolArtifact(artifact)) {
      errors.push({ path: `artifacts.${artifact.id}.${error.path}`, message: error.message });
    }
    if (!conclusionIds.has(artifact.userConclusionId)) {
      errors.push({
        path: `artifacts.${artifact.id}.userConclusionId`,
        message: `UserConclusion "${artifact.userConclusionId}" not found.`
      });
    } else {
      const owner = graph.conclusions.find(
        (conclusion) => conclusion.id === artifact.userConclusionId
      );
      if (owner !== undefined && !owner.protocolArtifactIds.includes(artifact.id)) {
        errors.push({
          path: `artifacts.${artifact.id}.userConclusionId`,
          message: `Owning conclusion does not reference protocol artifact "${artifact.id}".`
        });
      }
    }
  }

  for (const conclusion of graph.conclusions) {
    for (const artifactId of conclusion.protocolArtifactIds) {
      const artifact = graph.artifacts.find((item) => item.id === artifactId);
      if (artifact === undefined) {
        errors.push({
          path: `conclusions.${conclusion.id}.protocolArtifactIds`,
          message: `Protocol artifact "${artifactId}" not found.`
        });
      } else if (artifact.userConclusionId !== conclusion.id) {
        errors.push({
          path: `conclusions.${conclusion.id}.protocolArtifactIds`,
          message: `Protocol artifact "${artifactId}" belongs to another conclusion.`
        });
      }
    }
  }

  for (const link of graph.protocolLinks) {
    if (protocolLinkIds.has(link.id)) {
      errors.push({ path: `protocolLinks.${link.id}`, message: "Duplicate protocol link ID." });
    }
    protocolLinkIds.add(link.id);
    if (!conclusionIds.has(link.userConclusionId)) {
      errors.push({ path: `protocolLinks.${link.id}`, message: "Linked conclusion not found." });
    }
    const artifact = graph.artifacts.find((item) => item.id === link.protocolArtifactId);
    if (artifact === undefined) {
      errors.push({ path: `protocolLinks.${link.id}`, message: "Linked artifact not found." });
    } else if (artifact.userConclusionId !== link.userConclusionId) {
      errors.push({
        path: `protocolLinks.${link.id}`,
        message: "Protocol link crosses artifact ownership boundaries."
      });
    }
    if (!isOneOf(link.relation, PROTOCOL_LINK_RELATIONS)) {
      errors.push({ path: `protocolLinks.${link.id}.relation`, message: "Unknown protocol relation." });
    }
  }

  for (const edge of graph.userEdges) {
    if (userEdgeIds.has(edge.id)) {
      errors.push({ path: `userEdges.${edge.id}`, message: "Duplicate user edge ID." });
    }
    userEdgeIds.add(edge.id);
    if (!conclusionIds.has(edge.fromUserConclusionId) ||
        !conclusionIds.has(edge.toUserConclusionId)) {
      errors.push({ path: `userEdges.${edge.id}`, message: "User edge endpoint not found." });
    }
    if (edge.proposedBy !== "user" && edge.proposedBy !== "ai") {
      errors.push({
        path: `userEdges.${edge.id}.proposedBy`,
        message: "Knowledge edge proposer must be user or AI."
      });
    }
    if (edge.reviewStatus !== "pending" &&
        edge.reviewStatus !== "accepted" &&
        edge.reviewStatus !== "rejected") {
      errors.push({
        path: `userEdges.${edge.id}.reviewStatus`,
        message: "Unknown knowledge edge review status."
      });
    }
    if (edge.reviewStatus !== "pending" && !isNonEmptyString(edge.reviewedAt)) {
      errors.push({
        path: `userEdges.${edge.id}.reviewedAt`,
        message: "Reviewed knowledge edges require reviewedAt."
      });
    }
    if (!isNonEmptyString(edge.relation)) {
      errors.push({ path: `userEdges.${edge.id}.relation`, message: "Edge relation cannot be empty." });
    }
  }

  return errors;
}

/**
 * Project user-accepted edges into matching protocol layers. Only artifacts
 * of the same kind are paired. Missing artifacts produce no mirror and never
 * invalidate or remove the authoritative user edge.
 */
export function deriveMirroredProtocolEdges(
  userEdges: readonly UserKnowledgeEdge[],
  artifacts: readonly ProtocolArtifact[]
): readonly MirroredProtocolEdge[] {
  const result: MirroredProtocolEdge[] = [];
  for (const edge of userEdges) {
    if (edge.reviewStatus !== "accepted") {
      continue;
    }
    const fromArtifacts = artifacts.filter(
      (item) => item.userConclusionId === edge.fromUserConclusionId
    );
    const toArtifacts = artifacts.filter(
      (item) => item.userConclusionId === edge.toUserConclusionId
    );
    for (const from of fromArtifacts) {
      for (const to of toArtifacts) {
        if (from.kind !== to.kind) {
          continue;
        }
        result.push({
          id: `mirror:${edge.id}:${from.id}:${to.id}`,
          fromProtocolArtifactId: from.id,
          toProtocolArtifactId: to.id,
          relation: edge.relation,
          protocolKind: from.kind,
          userKnowledgeEdgeId: edge.id,
          origin: "mirrored_user_edge"
        });
      }
    }
  }
  return deepFreeze(result);
}

/** User review is the sole transition into the authoritative human graph. */
export function reviewUserKnowledgeEdge(
  edge: Readonly<UserKnowledgeEdge>,
  reviewStatus: "accepted" | "rejected",
  reviewedAt: string
): UserKnowledgeEdge {
  if (!isNonEmptyString(reviewedAt)) {
    throw new Error("reviewedAt cannot be empty.");
  }
  return deepFreeze(deepClone({
    ...edge,
    reviewStatus,
    reviewedAt
  })) as UserKnowledgeEdge;
}
