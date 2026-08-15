import {
  restoreConceptRevision,
  updateConceptNode,
  type ConceptChange,
  type ConceptNode,
  type ConceptNodeUpdate
} from "./BrainGrowth";
import {
  createConceptIndex,
  lookupConceptById,
  type ConceptIndex
} from "./BrainGrowthIndex";
import {
  inspectConceptMarkdown,
  serializeConceptNodeIntoMarkdown
} from "./BrainGrowthPersistence";

export interface ConceptUpdateApproval {
  readonly kind: "confirmed_concept_update";
  readonly approvedAt: string;
}

export interface ReviewedConceptUpdateRequest {
  readonly approval: ConceptUpdateApproval;
  readonly conceptId: string;
  readonly expectedRevision: number;
  readonly update: Readonly<ConceptNodeUpdate>;
  readonly change: Readonly<ConceptChange>;
}

export type ConceptMaintenanceFailureCode =
  | "approval_required"
  | "missing_concept"
  | "ambiguous_target"
  | "stale_revision"
  | "invalid_update"
  | "not_concept_note"
  | "invalid_concept_metadata"
  | "unsupported_schema_version"
  | "missing_revision";

export type ConceptMaintenanceResult =
  | {
      readonly kind: "updated";
      readonly previous: ConceptNode;
      readonly concept: ConceptNode;
    }
  | {
      readonly kind: "no_change";
      readonly concept: ConceptNode;
    }
  | {
      readonly kind: "failed";
      readonly code: ConceptMaintenanceFailureCode;
      readonly message: string;
    };

export type PersistedConceptMaintenanceResult =
  | {
      readonly kind: "updated";
      readonly previous: ConceptNode;
      readonly concept: ConceptNode;
      readonly markdown: string;
    }
  | {
      readonly kind: "no_change";
      readonly concept: ConceptNode;
      readonly markdown: string;
    }
  | {
      readonly kind: "failed";
      readonly code: ConceptMaintenanceFailureCode;
      readonly message: string;
      readonly markdown: string;
    };

function failure(
  code: ConceptMaintenanceFailureCode,
  message: string
): Extract<ConceptMaintenanceResult, { kind: "failed" }> {
  return Object.freeze({ kind: "failed", code, message });
}

function validateApproval(
  approval: Readonly<ConceptUpdateApproval>
): ConceptMaintenanceResult | undefined {
  return approval.kind === "confirmed_concept_update" &&
    approval.approvedAt.trim() !== ""
    ? undefined
    : failure(
        "approval_required",
        "An explicit reviewed concept-update approval is required."
      );
}

/** Apply a reviewed update through the immutable Brain Growth operation only. */
export function applyReviewedConceptUpdate(
  index: Readonly<ConceptIndex>,
  request: Readonly<ReviewedConceptUpdateRequest>
): ConceptMaintenanceResult {
  const approvalFailure = validateApproval(request.approval);
  if (approvalFailure !== undefined) {
    return approvalFailure;
  }

  const lookup = lookupConceptById(index, request.conceptId);
  if (lookup.kind === "not_found") {
    return failure("missing_concept", "The target concept was not found.");
  }
  if (lookup.kind === "ambiguous_matches") {
    return failure(
      "ambiguous_target",
      "Multiple concepts share the requested stable ID."
    );
  }

  const current = lookup.match.concept;
  if (current.revision !== request.expectedRevision) {
    return failure(
      "stale_revision",
      "The concept changed after this update was reviewed."
    );
  }

  try {
    const concept = updateConceptNode(
      current,
      request.update,
      request.change
    );
    return concept === current
      ? Object.freeze({ kind: "no_change", concept: current })
      : Object.freeze({ kind: "updated", previous: current, concept });
  } catch {
    return failure(
      "invalid_update",
      "The reviewed concept update is invalid."
    );
  }
}

function persistenceFailure(
  markdown: string,
  code: ConceptMaintenanceFailureCode,
  message: string
): PersistedConceptMaintenanceResult {
  return Object.freeze({ kind: "failed", code, message, markdown });
}

/**
 * Prepare updated Markdown without writing it. A caller must still use an
 * existing explicit Vault approval boundary to persist the returned text.
 */
export function preparePersistedConceptUpdate(
  markdown: string,
  request: Readonly<ReviewedConceptUpdateRequest>
): PersistedConceptMaintenanceResult {
  const inspected = inspectConceptMarkdown(markdown);

  if (inspected.kind === "ordinary_markdown") {
    return persistenceFailure(
      markdown,
      "not_concept_note",
      "The selected Markdown note is not a concept node."
    );
  }
  if (inspected.kind === "invalid_concept") {
    return persistenceFailure(
      markdown,
      inspected.code,
      inspected.message
    );
  }

  const result = applyReviewedConceptUpdate(
    createConceptIndex([inspected.persisted.conceptNode]),
    request
  );
  if (result.kind === "failed") {
    return persistenceFailure(markdown, result.code, result.message);
  }
  if (result.kind === "no_change") {
    return Object.freeze({
      kind: "no_change",
      concept: result.concept,
      markdown
    });
  }

  return Object.freeze({
    kind: "updated",
    previous: result.previous,
    concept: result.concept,
    markdown: serializeConceptNodeIntoMarkdown(
      markdown,
      result.concept,
      inspected.persisted.origin
    )
  });
}

export interface ReviewedConceptRestoreRequest {
  readonly approval: ConceptUpdateApproval;
  readonly conceptId: string;
  readonly expectedRevision: number;
  readonly restoreRevision: number;
  readonly change: Readonly<ConceptChange>;
}

/** Prepare a history restore as a new revision; this function performs no write. */
export function preparePersistedConceptRestore(
  markdown: string,
  request: Readonly<ReviewedConceptRestoreRequest>
): PersistedConceptMaintenanceResult {
  const inspected = inspectConceptMarkdown(markdown);

  if (inspected.kind === "ordinary_markdown") {
    return persistenceFailure(
      markdown,
      "not_concept_note",
      "The selected Markdown note is not a concept node."
    );
  }
  if (inspected.kind === "invalid_concept") {
    return persistenceFailure(markdown, inspected.code, inspected.message);
  }
  const approvalFailure = validateApproval(request.approval);
  if (approvalFailure?.kind === "failed") {
    return persistenceFailure(
      markdown,
      approvalFailure.code,
      approvalFailure.message
    );
  }
  const current = inspected.persisted.conceptNode;
  if (current.id !== request.conceptId) {
    return persistenceFailure(
      markdown,
      "missing_concept",
      "The persisted concept does not match the reviewed target."
    );
  }
  if (current.revision !== request.expectedRevision) {
    return persistenceFailure(
      markdown,
      "stale_revision",
      "The concept changed after this restore was reviewed."
    );
  }

  let restored: ConceptNode;
  try {
    restored = restoreConceptRevision(
      current,
      request.restoreRevision,
      request.change
    );
  } catch {
    return persistenceFailure(
      markdown,
      "missing_revision",
      "The requested concept revision was not found."
    );
  }

  return Object.freeze({
    kind: "updated",
    previous: current,
    concept: restored,
    markdown: serializeConceptNodeIntoMarkdown(
      markdown,
      restored,
      inspected.persisted.origin
    )
  });
}
