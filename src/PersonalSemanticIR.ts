// ── Personal Semantic IR ──────────────────────────────────────────────
// Target-independent semantic representation of one interpreted
// mathematical expression or proof fragment.
//
// The IR intentionally separates *what the user means* from *how that
// meaning was written* and from *how it will later be projected into a
// target such as Lean*.  It never stores Lean syntax and never mutates
// Personal Brain ConceptNodes.
//
// Invariants enforced by `validatePersonalSemanticIR`:
//   1. A resolved concept binding points to a stable ConceptNode ID and a
//      concrete revision.
//   2. Every proof-step dependency points to an earlier, already-seen step.
//   3. Referenced claims, assumptions, and concept bindings exist.
//   4. AI-added assumptions are explicitly marked as added.
//   5. Unresolved concepts and inferences remain explicit.
// ────────────────────────────────────────────────────────────────────────

export const PERSONAL_SEMANTIC_IR_SCHEMA_VERSION = 1 as const;

// ── Authority and Resolution ───────────────────────────────────────────

export type SemanticAuthority =
  | "user_authoritative"
  | "ai_interpreted"
  | "external_standard"
  | "unresolved";

export type ConceptResolutionMethod =
  | "stable_id"
  | "exact_title"
  | "normalized_title"
  | "alias"
  | "model_proposed"
  | "none";

export type ConceptBindingStatus =
  | "resolved"
  | "ambiguous"
  | "unresolved"
  | "proposed_new";

export type IRSpeechAct =
  | "definition_candidate"
  | "equivalence_claim"
  | "theorem_claim"
  | "conjecture"
  | "proof_sketch"
  | "intuition";

export type IRClaimKind =
  | "definition"
  | "proposition"
  | "theorem"
  | "conjecture"
  | "intuition";

export type IRProofStepKind =
  | "introduce_object"
  | "assume_proposition"
  | "invoke_definition"
  | "invoke_known_claim"
  | "derive_claim"
  | "rewrite_using_equivalence"
  | "instantiate_quantifier"
  | "conclude"
  | "unresolved_inference";

export type IRUnresolvedKind =
  | "concept"
  | "assumption"
  | "inference"
  | "ambiguity";

export type IRClaimSemanticChange =
  | "unchanged"
  | "strengthened"
  | "weakened";

// ── Source Evidence ────────────────────────────────────────────────────

export interface IRSemanticSource {
  readonly messageId: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly snapshot: string;
}

export interface IRTextSpan {
  readonly startOffset: number;
  readonly endOffset: number;
}

// ── Brain Concept References ───────────────────────────────────────────

export interface ConceptRevisionRef {
  readonly conceptId: string;
  readonly revision: number;
  readonly title: string;
  readonly matchedBy: ConceptResolutionMethod;
}

export interface ConceptBindingAlternative {
  readonly conceptId: string;
  readonly title: string;
  readonly revision: number;
}

export interface ConceptBinding {
  readonly id: string;
  readonly surfacePhrase: string;
  readonly span?: IRTextSpan;
  readonly status: ConceptBindingStatus;
  readonly conceptId?: string;
  readonly conceptRevision?: number;
  readonly resolvedTitle?: string;
  readonly resolutionMethod: ConceptResolutionMethod;
  readonly alternatives?: readonly ConceptBindingAlternative[];
  readonly proposedNewTitle?: string;
  /**
   * Authoritative personal meaning from the Brain, when it exists.  This is
   * the only meaning allowed to displace a public/standard interpretation.
   */
  readonly personalDefinition?: string;
  /** Standard/dictionary meaning, kept separate from personal meaning. */
  readonly standardDefinition?: string;
  /** True when a personal definition and a standard definition differ. */
  readonly definitionConflict?: boolean;
}

// ── Structured Meaning ─────────────────────────────────────────────────

export interface IRMathematicalObject {
  readonly id: string;
  readonly name: string;
  readonly latex?: string;
  readonly domain?: string;
  /** Domain as it appeared in the user's original expression (for diff). */
  readonly sourceDomain?: string;
  readonly boundConceptId?: string;
}

export interface IRRelation {
  readonly id: string;
  readonly fromObjectId: string;
  readonly toObjectId: string;
  readonly relation: string;
  readonly note?: string;
}

export interface IRClaim {
  readonly id: string;
  readonly kind: IRClaimKind;
  readonly statement: string;
  readonly quantifiers?: string;
  /** Quantifiers as they appeared in the original expression (for diff). */
  readonly sourceQuantifiers?: string;
  readonly conclusion?: string;
  readonly authority: SemanticAuthority;
  /** AI interpretation confidence in [0, 1]. Not meaningful for user truth. */
  readonly confidence?: number;
  readonly semanticChangeKind?: IRClaimSemanticChange;
  readonly boundConceptIds?: readonly string[];
}

export type IRAssumptionKind =
  | "user_authoritative"
  | "explicit"
  | "implicit";

export interface IRAssumption {
  readonly id: string;
  readonly text: string;
  readonly kind: IRAssumptionKind;
  /** True when the assumption was introduced by AI interpretation. */
  readonly addedByAI: boolean;
  readonly span?: IRTextSpan;
  readonly relatedClaimIds?: readonly string[];
}

export interface IRProofStep {
  readonly id: string;
  readonly kind: IRProofStepKind;
  readonly description: string;
  readonly span?: IRTextSpan;
  readonly inputClaimIds?: readonly string[];
  readonly outputClaimIds?: readonly string[];
  readonly referencedConceptIds?: readonly string[];
  readonly assumptionIds?: readonly string[];
  readonly unresolvedAssumptionIds?: readonly string[];
  readonly authority: SemanticAuthority;
  /** IDs of earlier steps this step depends on. */
  readonly dependencies?: readonly string[];
}

export interface IRUnresolvedItem {
  readonly id: string;
  readonly kind: IRUnresolvedKind;
  readonly description: string;
  readonly relatedIds?: readonly string[];
}

export type IRSemanticChangeCategory =
  | "added_assumption"
  | "removed_ambiguity"
  | "strengthened"
  | "weakened"
  | "added_condition"
  | "narrowed_scope";

export interface IRSemanticChange {
  readonly category: IRSemanticChangeCategory;
  readonly description: string;
  readonly before?: string;
  readonly after?: string;
  readonly relatedAssumptionIds?: readonly string[];
}

// ── Top-level IR ───────────────────────────────────────────────────────

export interface PersonalSemanticIR {
  readonly schemaVersion: typeof PERSONAL_SEMANTIC_IR_SCHEMA_VERSION;
  readonly id: string;
  readonly source: IRSemanticSource;
  readonly originalExpression: string;
  readonly speechAct: IRSpeechAct;
  /** Overall authority of this interpretation. */
  readonly authority: SemanticAuthority;
  readonly confidence?: number;
  /**
   * Canonical, target-independent meaning statement.  This is one projection
   * of the structured fields below, never a replacement for them.
   */
  readonly canonicalStatement: string;
  readonly quantifiers: string;
  readonly conclusion: string;
  readonly latexStatement?: string;

  readonly conceptBindings: readonly ConceptBinding[];
  readonly objects: readonly IRMathematicalObject[];
  readonly claims: readonly IRClaim[];
  readonly assumptions: readonly IRAssumption[];
  readonly relations: readonly IRRelation[];
  readonly proofSteps: readonly IRProofStep[];

  readonly unresolvedItems: readonly IRUnresolvedItem[];
  readonly ambiguities: readonly string[];
  readonly resolvedAmbiguities: readonly string[];
  readonly missingConditions: readonly string[];
  readonly removedAssumptions: readonly string[];
  readonly semanticChanges: readonly IRSemanticChange[];
  readonly originatingConceptRevisions: readonly ConceptRevisionRef[];

  readonly createdAt: string;
}

export interface CreatePersonalSemanticIRInput {
  readonly id?: string;
  readonly source: IRSemanticSource;
  readonly originalExpression: string;
  readonly speechAct: IRSpeechAct;
  readonly authority: SemanticAuthority;
  readonly confidence?: number;
  readonly canonicalStatement: string;
  readonly quantifiers: string;
  readonly conclusion: string;
  readonly latexStatement?: string;
  readonly conceptBindings?: readonly ConceptBinding[];
  readonly objects?: readonly IRMathematicalObject[];
  readonly claims?: readonly IRClaim[];
  readonly assumptions?: readonly IRAssumption[];
  readonly relations?: readonly IRRelation[];
  readonly proofSteps?: readonly IRProofStep[];
  readonly unresolvedItems?: readonly IRUnresolvedItem[];
  readonly ambiguities?: readonly string[];
  readonly resolvedAmbiguities?: readonly string[];
  readonly missingConditions?: readonly string[];
  readonly removedAssumptions?: readonly string[];
  readonly semanticChanges?: readonly IRSemanticChange[];
  readonly originatingConceptRevisions?: readonly ConceptRevisionRef[];
}

// ── Validation Result ──────────────────────────────────────────────────

export interface IRValidationFailure {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export type DeserializeIRResult =
  | { readonly ok: true; readonly ir: PersonalSemanticIR }
  | { readonly ok: false; readonly error: string };

// ── Helpers ────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  Object.freeze(value);
  return value;
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    result[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return result as T;
}

function generateId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? fallbackId();
  } catch {
    return fallbackId();
  }
}

function fallbackId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length > 10000) {
    return "";
  }
  return trimmed;
}

// ── Constants for Validation ───────────────────────────────────────────

const SEMANTIC_AUTHORITIES: ReadonlySet<string> = new Set([
  "user_authoritative",
  "ai_interpreted",
  "external_standard",
  "unresolved"
]);

const RESOLUTION_METHODS: ReadonlySet<string> = new Set([
  "stable_id",
  "exact_title",
  "normalized_title",
  "alias",
  "model_proposed",
  "none"
]);

const BINDING_STATUSES: ReadonlySet<string> = new Set([
  "resolved",
  "ambiguous",
  "unresolved",
  "proposed_new"
]);

const SPEECH_ACTS: ReadonlySet<string> = new Set([
  "definition_candidate",
  "equivalence_claim",
  "theorem_claim",
  "conjecture",
  "proof_sketch",
  "intuition"
]);

const CLAIM_KINDS: ReadonlySet<string> = new Set([
  "definition",
  "proposition",
  "theorem",
  "conjecture",
  "intuition"
]);

const PROOF_STEP_KINDS: ReadonlySet<string> = new Set([
  "introduce_object",
  "assume_proposition",
  "invoke_definition",
  "invoke_known_claim",
  "derive_claim",
  "rewrite_using_equivalence",
  "instantiate_quantifier",
  "conclude",
  "unresolved_inference"
]);

const UNRESOLVED_KINDS: ReadonlySet<string> = new Set([
  "concept",
  "assumption",
  "inference",
  "ambiguity"
]);

const ASSUMPTION_KINDS: ReadonlySet<string> = new Set([
  "user_authoritative",
  "explicit",
  "implicit"
]);

const SEMANTIC_CHANGE_CATEGORIES: ReadonlySet<string> = new Set([
  "added_assumption",
  "removed_ambiguity",
  "strengthened",
  "weakened",
  "added_condition",
  "narrowed_scope"
]);

// ── Factory ────────────────────────────────────────────────────────────

export function createPersonalSemanticIR(
  input: CreatePersonalSemanticIRInput
): PersonalSemanticIR {
  const sourceSnapshot = nonEmpty(input.source.snapshot, "source.snapshot");
  if (sourceSnapshot === "") {
    throw new Error("source.snapshot must be a non-empty string.");
  }
  if (nonEmpty(input.source.messageId, "source.messageId") === "") {
    throw new Error("source.messageId must be a non-empty string.");
  }
  if (nonEmpty(input.canonicalStatement, "canonicalStatement") === "") {
    throw new Error("canonicalStatement must be a non-empty string.");
  }
  if (!SPEECH_ACTS.has(input.speechAct)) {
    throw new Error(`Invalid speechAct "${String(input.speechAct)}".`);
  }
  if (!SEMANTIC_AUTHORITIES.has(input.authority)) {
    throw new Error(`Invalid authority "${String(input.authority)}".`);
  }

  const ir: PersonalSemanticIR = {
    schemaVersion: PERSONAL_SEMANTIC_IR_SCHEMA_VERSION,
    id: nonEmpty(input.id, "id") || generateId(),
    source: deepFreeze({
      messageId: input.source.messageId,
      startOffset: typeof input.source.startOffset === "number" &&
        input.source.startOffset >= 0
        ? input.source.startOffset
        : undefined,
      endOffset: typeof input.source.endOffset === "number" &&
        input.source.endOffset >= 0
        ? input.source.endOffset
        : undefined,
      snapshot: sourceSnapshot
    }),
    originalExpression: input.originalExpression.trim(),
    speechAct: input.speechAct,
    authority: input.authority,
    confidence: typeof input.confidence === "number" &&
      input.confidence >= 0 && input.confidence <= 1
      ? input.confidence
      : undefined,
    canonicalStatement: input.canonicalStatement.trim(),
    quantifiers: input.quantifiers.trim(),
    conclusion: input.conclusion.trim(),
    latexStatement: input.latexStatement?.trim() || undefined,
    conceptBindings: deepFreeze([...(input.conceptBindings ?? [])]),
    objects: deepFreeze([...(input.objects ?? [])]),
    claims: deepFreeze([...(input.claims ?? [])]),
    assumptions: deepFreeze([...(input.assumptions ?? [])]),
    relations: deepFreeze([...(input.relations ?? [])]),
    proofSteps: deepFreeze([...(input.proofSteps ?? [])]),
    unresolvedItems: deepFreeze([...(input.unresolvedItems ?? [])]),
    ambiguities: deepFreeze([...(input.ambiguities ?? [])]),
    resolvedAmbiguities: deepFreeze([...(input.resolvedAmbiguities ?? [])]),
    missingConditions: deepFreeze([...(input.missingConditions ?? [])]),
    removedAssumptions: deepFreeze([...(input.removedAssumptions ?? [])]),
    semanticChanges: deepFreeze([...(input.semanticChanges ?? [])]),
    originatingConceptRevisions: deepFreeze(
      [...(input.originatingConceptRevisions ?? [])]
    ),
    createdAt: new Date().toISOString()
  };

  const failures = validatePersonalSemanticIR(ir);
  if (failures.length > 0) {
    throw new Error(
      "PersonalSemanticIR invariants violated:\n" +
      failures.map((f) => `${f.code}: ${f.message}`).join("\n")
    );
  }

  return deepFreeze(ir);
}

// ── Validation ─────────────────────────────────────────────────────────

export function validatePersonalSemanticIR(
  ir: Readonly<PersonalSemanticIR>
): IRValidationFailure[] {
  const failures: IRValidationFailure[] = [];

  if (ir.schemaVersion !== PERSONAL_SEMANTIC_IR_SCHEMA_VERSION) {
    failures.push({
      code: "unsupported_schema_version",
      message: `schemaVersion must be ${PERSONAL_SEMANTIC_IR_SCHEMA_VERSION}.`
    });
  }
  if (nonEmpty(ir.id, "id") === "") {
    failures.push({ code: "missing_id", message: "IR id must be non-empty." });
  }
  if (nonEmpty(ir.source.snapshot, "source.snapshot") === "") {
    failures.push({
      code: "missing_source_snapshot",
      message: "source.snapshot must be non-empty."
    });
  }
  if (nonEmpty(ir.source.messageId, "source.messageId") === "") {
    failures.push({
      code: "missing_source_message_id",
      message: "source.messageId must be non-empty."
    });
  }
  if (!SPEECH_ACTS.has(ir.speechAct)) {
    failures.push({
      code: "invalid_speech_act",
      message: `speechAct "${String(ir.speechAct)}" is invalid.`
    });
  }
  if (!SEMANTIC_AUTHORITIES.has(ir.authority)) {
    failures.push({
      code: "invalid_authority",
      message: `authority "${String(ir.authority)}" is invalid.`
    });
  }
  if (ir.confidence !== undefined &&
    (ir.confidence < 0 || ir.confidence > 1)) {
    failures.push({
      code: "invalid_confidence",
      message: "confidence must be between 0 and 1."
    });
  }

  const bindingIds = new Set<string>();
  const conceptIds = new Set<string>();
  const claimIds = new Set<string>();
  const assumptionIds = new Set<string>();
  const objectIds = new Set<string>();

  ir.conceptBindings.forEach((binding, index) => {
    const path = `conceptBindings[${index}]`;
    if (nonEmpty(binding.id, "id") === "") {
      failures.push({ code: "missing_binding_id", message: "Binding id is empty.", path });
    }
    bindingIds.add(binding.id);
    if (!BINDING_STATUSES.has(binding.status)) {
      failures.push({
        code: "invalid_binding_status",
        message: `Binding status "${String(binding.status)}" is invalid.`,
        path
      });
    }
    if (!RESOLUTION_METHODS.has(binding.resolutionMethod)) {
      failures.push({
        code: "invalid_resolution_method",
        message: `Resolution method "${String(binding.resolutionMethod)}" is invalid.`,
        path
      });
    }
    if (binding.status === "resolved") {
      if (binding.conceptId === undefined || binding.conceptRevision === undefined) {
        failures.push({
          code: "resolved_binding_missing_concept",
          message: "A resolved binding must have conceptId and conceptRevision.",
          path
        });
      } else {
        conceptIds.add(binding.conceptId);
      }
    }
    if (binding.status === "ambiguous" &&
      (binding.alternatives === undefined || binding.alternatives.length === 0)) {
      failures.push({
        code: "ambiguous_binding_missing_alternatives",
        message: "An ambiguous binding must list alternatives.",
        path
      });
    }
    if (binding.status === "proposed_new" &&
      binding.proposedNewTitle === undefined) {
      failures.push({
        code: "proposed_binding_missing_title",
        message: "A proposed_new binding must provide a proposed title.",
        path
      });
    }
  });

  ir.objects.forEach((object, index) => {
    const path = `objects[${index}]`;
    if (nonEmpty(object.id, "id") === "") {
      failures.push({ code: "missing_object_id", message: "Object id is empty.", path });
    }
    objectIds.add(object.id);
    if (object.boundConceptId !== undefined &&
      !bindingIds.has(object.boundConceptId)) {
      failures.push({
        code: "object_bound_concept_missing",
        message: `Object boundConceptId "${object.boundConceptId}" does not reference a binding.`,
        path
      });
    }
  });

  ir.claims.forEach((claim, index) => {
    const path = `claims[${index}]`;
    if (nonEmpty(claim.id, "id") === "") {
      failures.push({ code: "missing_claim_id", message: "Claim id is empty.", path });
    }
    claimIds.add(claim.id);
    if (!CLAIM_KINDS.has(claim.kind)) {
      failures.push({
        code: "invalid_claim_kind",
        message: `Claim kind "${String(claim.kind)}" is invalid.`,
        path
      });
    }
    if (!SEMANTIC_AUTHORITIES.has(claim.authority)) {
      failures.push({
        code: "invalid_claim_authority",
        message: `Claim authority "${String(claim.authority)}" is invalid.`,
        path
      });
    }
    if (claim.confidence !== undefined &&
      (claim.confidence < 0 || claim.confidence > 1)) {
      failures.push({
        code: "invalid_claim_confidence",
        message: "Claim confidence must be between 0 and 1.",
        path
      });
    }
  });

  ir.assumptions.forEach((assumption, index) => {
    const path = `assumptions[${index}]`;
    if (nonEmpty(assumption.id, "id") === "") {
      failures.push({ code: "missing_assumption_id", message: "Assumption id is empty.", path });
    }
    assumptionIds.add(assumption.id);
    if (!ASSUMPTION_KINDS.has(assumption.kind)) {
      failures.push({
        code: "invalid_assumption_kind",
        message: `Assumption kind "${String(assumption.kind)}" is invalid.`,
        path
      });
    }
    if (assumption.addedByAI && assumption.kind !== "implicit") {
      failures.push({
        code: "added_assumption_must_be_implicit",
        message: "An AI-added assumption must use kind 'implicit'.",
        path
      });
    }
  });

  ir.relations.forEach((relation, index) => {
    const path = `relations[${index}]`;
    if (nonEmpty(relation.id, "id") === "") {
      failures.push({ code: "missing_relation_id", message: "Relation id is empty.", path });
    }
    if (!objectIds.has(relation.fromObjectId)) {
      failures.push({
        code: "relation_from_object_missing",
        message: `Relation fromObjectId "${relation.fromObjectId}" does not exist.`,
        path
      });
    }
    if (!objectIds.has(relation.toObjectId)) {
      failures.push({
        code: "relation_to_object_missing",
        message: `Relation toObjectId "${relation.toObjectId}" does not exist.`,
        path
      });
    }
  });

  const seenStepIds = new Set<string>();
  ir.proofSteps.forEach((step, index) => {
    const path = `proofSteps[${index}]`;
    if (nonEmpty(step.id, "id") === "") {
      failures.push({ code: "missing_step_id", message: "Proof step id is empty.", path });
    }
    if (!PROOF_STEP_KINDS.has(step.kind)) {
      failures.push({
        code: "invalid_step_kind",
        message: `Proof step kind "${String(step.kind)}" is invalid.`,
        path
      });
    }
    if (!SEMANTIC_AUTHORITIES.has(step.authority)) {
      failures.push({
        code: "invalid_step_authority",
        message: `Proof step authority "${String(step.authority)}" is invalid.`,
        path
      });
    }
    for (const claimId of step.inputClaimIds ?? []) {
      if (!claimIds.has(claimId)) {
        failures.push({
          code: "step_input_claim_missing",
          message: `Step input claim "${claimId}" does not exist.`,
          path
        });
      }
    }
    for (const claimId of step.outputClaimIds ?? []) {
      if (!claimIds.has(claimId)) {
        failures.push({
          code: "step_output_claim_missing",
          message: `Step output claim "${claimId}" does not exist.`,
          path
        });
      }
    }
    for (const conceptId of step.referencedConceptIds ?? []) {
      if (!conceptIds.has(conceptId)) {
        failures.push({
          code: "step_concept_not_resolved",
          message: `Step references concept "${conceptId}" which is not a resolved binding.`,
          path
        });
      }
    }
    for (const assumptionId of step.assumptionIds ?? []) {
      if (!assumptionIds.has(assumptionId)) {
        failures.push({
          code: "step_assumption_missing",
          message: `Step assumption "${assumptionId}" does not exist.`,
          path
        });
      }
    }
    for (const dependencyId of step.dependencies ?? []) {
      if (!seenStepIds.has(dependencyId)) {
        failures.push({
          code: "step_dependency_not_earlier",
          message: `Step dependency "${dependencyId}" must point to an earlier step.`,
          path
        });
      }
    }
    if (step.unresolvedAssumptionIds !== undefined &&
      step.unresolvedAssumptionIds.length > 0 &&
      step.kind !== "unresolved_inference") {
      failures.push({
        code: "unresolved_assumption_on_non_inference",
        message: "Only unresolved_inference steps may carry unresolved assumptions.",
        path
      });
    }
    seenStepIds.add(step.id);
  });

  ir.unresolvedItems.forEach((item, index) => {
    const path = `unresolvedItems[${index}]`;
    if (nonEmpty(item.id, "id") === "") {
      failures.push({ code: "missing_unresolved_id", message: "Unresolved item id is empty.", path });
    }
    if (!UNRESOLVED_KINDS.has(item.kind)) {
      failures.push({
        code: "invalid_unresolved_kind",
        message: `Unresolved kind "${String(item.kind)}" is invalid.`,
        path
      });
    }
  });

  ir.semanticChanges.forEach((change, index) => {
    const path = `semanticChanges[${index}]`;
    if (!SEMANTIC_CHANGE_CATEGORIES.has(change.category)) {
      failures.push({
        code: "invalid_semantic_change_category",
        message: `Semantic change category "${String(change.category)}" is invalid.`,
        path
      });
    }
    if (change.category === "added_assumption") {
      for (const id of change.relatedAssumptionIds ?? []) {
        if (!assumptionIds.has(id)) {
          failures.push({
            code: "semantic_change_assumption_missing",
            message: `Semantic change references assumption "${id}" which does not exist.`,
            path
          });
        }
      }
    }
  });

  ir.originatingConceptRevisions.forEach((ref, index) => {
    const path = `originatingConceptRevisions[${index}]`;
    if (nonEmpty(ref.conceptId, "conceptId") === "") {
      failures.push({
        code: "missing_concept_revision_id",
        message: "Concept revision ref must have a conceptId.",
        path
      });
    }
    if (!Number.isInteger(ref.revision) || ref.revision < 1) {
      failures.push({
        code: "invalid_concept_revision",
        message: "Concept revision must be a positive integer.",
        path
      });
    }
  });

  return failures;
}

// ── Serialization ──────────────────────────────────────────────────────

export function serializePersonalSemanticIR(
  ir: Readonly<PersonalSemanticIR>
): unknown {
  return deepClone(ir);
}

export function deserializePersonalSemanticIR(
  value: unknown
): DeserializeIRResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "PersonalSemanticIR must be an object." };
  }

  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== PERSONAL_SEMANTIC_IR_SCHEMA_VERSION) {
    return {
      ok: false,
      error:
        `Unsupported PersonalSemanticIR schema version ` +
        `${String(data.schemaVersion)}.`
    };
  }

  // Re-run the invariant validator on the reconstructed value so malformed
  // persisted payloads fail safely instead of being trusted.
  const ir = deepFreeze(deepClone(data as unknown as PersonalSemanticIR));
  const failures = validatePersonalSemanticIR(ir);
  if (failures.length > 0) {
    return {
      ok: false,
      error:
        "Invalid PersonalSemanticIR: " +
        failures.map((f) => f.code).join(", ")
    };
  }

  return { ok: true, ir };
}

// ── Canonical Renderer ─────────────────────────────────────────────────

export function renderPersonalSemanticIR(
  ir: Readonly<PersonalSemanticIR>
): string {
  const lines: string[] = [];
  lines.push(`Semantic meaning: ${ir.canonicalStatement}`);
  if (ir.quantifiers !== "") {
    lines.push(`Quantifiers: ${ir.quantifiers}`);
  }
  if (ir.conclusion !== "") {
    lines.push(`Conclusion: ${ir.conclusion}`);
  }

  if (ir.conceptBindings.length > 0) {
    lines.push("");
    lines.push("Concept bindings:");
    for (const binding of ir.conceptBindings) {
      const concept =
        binding.status === "resolved"
          ? `${binding.conceptId}@${binding.conceptRevision}`
          : binding.status === "ambiguous"
            ? "ambiguous"
            : binding.status === "proposed_new"
              ? "proposed-new"
              : "unresolved";
      lines.push(`  - "${binding.surfacePhrase}" -> ${concept}`);
      if (binding.personalDefinition !== undefined) {
        lines.push(`      personal: ${binding.personalDefinition}`);
      }
      if (binding.standardDefinition !== undefined) {
        lines.push(`      standard: ${binding.standardDefinition}`);
      }
      if (binding.definitionConflict === true) {
        lines.push("      (personal definition differs from standard)");
      }
    }
  }

  if (ir.objects.length > 0) {
    lines.push("");
    lines.push("Objects:");
    for (const object of ir.objects) {
      const domain = object.domain !== undefined ? ` [${object.domain}]` : "";
      lines.push(`  - ${object.name}${domain}`);
    }
  }

  if (ir.claims.length > 0) {
    lines.push("");
    lines.push("Claims:");
    for (const claim of ir.claims) {
      lines.push(`  - [${claim.kind}] ${claim.statement}`);
    }
  }

  if (ir.assumptions.length > 0) {
    lines.push("");
    lines.push("Assumptions:");
    for (const assumption of ir.assumptions) {
      const added = assumption.addedByAI ? " (AI-added)" : "";
      lines.push(`  - [${assumption.kind}] ${assumption.text}${added}`);
    }
  }

  if (ir.proofSteps.length > 0) {
    lines.push("");
    lines.push("Proof steps:");
    for (const step of ir.proofSteps) {
      lines.push(`  - [${step.kind}] ${step.description}`);
    }
  }

  if (ir.ambiguities.length > 0) {
    lines.push("");
    lines.push("Open ambiguities:");
    for (const ambiguity of ir.ambiguities) {
      lines.push(`  - ${ambiguity}`);
    }
  }

  if (ir.missingConditions.length > 0) {
    lines.push("");
    lines.push("Missing conditions:");
    for (const condition of ir.missingConditions) {
      lines.push(`  - ${condition}`);
    }
  }

  if (ir.unresolvedItems.length > 0) {
    lines.push("");
    lines.push("Unresolved items:");
    for (const item of ir.unresolvedItems) {
      lines.push(`  - [${item.kind}] ${item.description}`);
    }
  }

  return lines.join("\n");
}

// ── Semantic Diff ──────────────────────────────────────────────────────

export type SemanticDiffKind =
  | "assumption_added"
  | "assumption_removed"
  | "quantifier_changed"
  | "domain_changed"
  | "concept_resolved"
  | "concept_ambiguous"
  | "concept_unresolved"
  | "concept_proposed"
  | "claim_strengthened"
  | "claim_weakened"
  | "ambiguity_resolved"
  | "inference_gap";

export interface SemanticDiffEntry {
  readonly kind: SemanticDiffKind;
  readonly summary: string;
  readonly detail?: string;
}

export function computeSemanticDiff(
  ir: Readonly<PersonalSemanticIR>
): SemanticDiffEntry[] {
  const entries: SemanticDiffEntry[] = [];

  for (const assumption of ir.assumptions) {
    if (assumption.addedByAI) {
      entries.push({
        kind: "assumption_added",
        summary: `Added assumption: ${assumption.text}`,
        detail: "This assumption was introduced by interpretation, not by the user."
      });
    }
  }

  for (const text of ir.removedAssumptions) {
    entries.push({
      kind: "assumption_removed",
      summary: `Removed assumption: ${text}`,
      detail: "An assumption present in the original expression was not retained."
    });
  }

  for (const claim of ir.claims) {
    if (
      claim.sourceQuantifiers !== undefined &&
      claim.quantifiers !== undefined &&
      claim.sourceQuantifiers.trim() !== claim.quantifiers.trim()
    ) {
      entries.push({
        kind: "quantifier_changed",
        summary: `Quantifier changed from "${claim.sourceQuantifiers}" to "${claim.quantifiers}"`,
        detail: claim.statement
      });
    }
    if (claim.semanticChangeKind === "strengthened") {
      entries.push({
        kind: "claim_strengthened",
        summary: `Strengthened claim: ${claim.statement}`
      });
    } else if (claim.semanticChangeKind === "weakened") {
      entries.push({
        kind: "claim_weakened",
        summary: `Weakened claim: ${claim.statement}`
      });
    }
  }

  for (const object of ir.objects) {
    if (
      object.sourceDomain !== undefined &&
      object.domain !== undefined &&
      object.sourceDomain.trim() !== object.domain.trim()
    ) {
      entries.push({
        kind: "domain_changed",
        summary:
          `Domain changed from "${object.sourceDomain}" to "${object.domain}"`,
        detail: object.name
      });
    }
  }

  for (const binding of ir.conceptBindings) {
    switch (binding.status) {
      case "resolved":
        entries.push({
          kind: "concept_resolved",
          summary:
            `Resolved "${binding.surfacePhrase}" to ` +
            `${binding.resolvedTitle ?? binding.conceptId ?? "unknown"}`
        });
        break;
      case "ambiguous":
        entries.push({
          kind: "concept_ambiguous",
          summary: `"${binding.surfacePhrase}" is ambiguous`,
          detail: (binding.alternatives ?? [])
            .map((alt) => alt.title)
            .join(", ")
        });
        break;
      case "unresolved":
        entries.push({
          kind: "concept_unresolved",
          summary: `"${binding.surfacePhrase}" could not be resolved`
        });
        break;
      case "proposed_new":
        entries.push({
          kind: "concept_proposed",
          summary:
            `Proposed new concept "${binding.proposedNewTitle ?? binding.surfacePhrase}"`
        });
        break;
    }
  }

  for (const ambiguity of ir.resolvedAmbiguities) {
    entries.push({
      kind: "ambiguity_resolved",
      summary: `Resolved ambiguity: ${ambiguity}`,
      detail: "The model chose an interpretation; this must still be reviewed."
    });
  }

  for (const step of ir.proofSteps) {
    if (
      step.kind === "unresolved_inference" ||
      (step.unresolvedAssumptionIds !== undefined &&
        step.unresolvedAssumptionIds.length > 0)
    ) {
      entries.push({
        kind: "inference_gap",
        summary: `Inference gap in step "${step.id}": ${step.description}`
      });
    }
  }

  return entries;
}

export function renderSemanticDiff(
  entries: readonly SemanticDiffEntry[]
): string {
  if (entries.length === 0) {
    return "No semantic differences detected.";
  }
  return entries
    .map((entry) => {
      const detail = entry.detail !== undefined ? ` (${entry.detail})` : "";
      return `- [${entry.kind}] ${entry.summary}${detail}`;
    })
    .join("\n");
}

// ── Language Adapter Interfaces ────────────────────────────────────────

export interface SemanticFrontend<Input> {
  readonly name: string;
  interpret(input: Input): Promise<PersonalSemanticIR>;
}

export interface SemanticBackend<Output> {
  readonly name: string;
  project(ir: Readonly<PersonalSemanticIR>): Promise<Output>;
}
