// ── Semantic Specification Protocol ──────────────────────────────────────
// Lain Language → Meaning IR
//
// M1: Core model.  A pure semantic IR that preserves the user's original
// language and represents its logical structure faithfully BEFORE
// mathematical abstraction or Lean encoding.
//
// Architecture position:
//   UserConclusion (authoritative user-authored natural language)
//           ↓ optional interpretation
//   SemanticSpec          ← THIS MODULE: backend-neutral meaning IR
//           ↓ optional protocol backends
//   Lean, empirical evidence, custom-world reasoning, external mappings, ...
//
// SemanticSpec records understood meaning. It is not the authoritative note
// prose, a truth judgment, or a requirement that the meaning be lowered to
// Lean. Linguistic relations and user-defined concepts are valid endpoints.
//
// Invariants enforced at runtime:
//   1. analysisStatus is derived from blocking ambiguities + resolutions +
//      applied semantic patches.
//      under_specified when any blocking ambiguity is unresolved.
//   2. reviewStatus can only be changed by explicit user action (accept).
//   3. Source snapshots are immutable — never silently rewritten.
//   4. Original ambiguities are preserved; resolutions and semantic patches
//      are immutable, separate audit records.
//   5. Accepted specs must have zero unresolved blocking ambiguities.
//   6. Expression child IDs, symbol IDs, and statement expression IDs must
//      reference existing entities within the spec (no dangling refs).
//   7. At most one user resolution per ambiguity.
// ────────────────────────────────────────────────────────────────────────

// ── Constants ──────────────────────────────────────────────────────────

export const SEMANTIC_ROLES = [
  "unresolved",
  "concept",
  "entity",
  "variable",
  "domain",
  "collection",
  "function",
  "relation",
  "predicate",
  "operator",
  "proposition"
] as const;
export type SemanticRole = typeof SEMANTIC_ROLES[number];

export const AMBIGUITY_KINDS = [
  "symbol_role",
  "domain",
  "operator_meaning",
  "reference_target",
  "quantifier_scope",
  "definition_scope",
  "other"
] as const;
export type AmbiguityKind = typeof AMBIGUITY_KINDS[number];

export const EXPRESSION_KINDS = [
  "symbol_ref",
  "literal",
  "application",
  "equals",
  "membership",
  "not",
  "and",
  "or",
  "implies",
  "iff",
  "forall",
  "exists",
  "reference"
] as const;
export type ExpressionKind = typeof EXPRESSION_KINDS[number];

export const STATEMENT_KINDS = [
  "assertion",
  "definition",
  "rule"
] as const;
export type StatementKind = typeof STATEMENT_KINDS[number];

export const SEMANTIC_SPEC_SCHEMA_VERSION = 1;

// ── Status Types ───────────────────────────────────────────────────────

export type SemanticAnalysisStatus =
  | "under_specified"
  | "ready_for_review";

export type SemanticReviewStatus =
  | "pending"
  | "accepted"
  | "rejected";

// ── Source Provenance ──────────────────────────────────────────────────

export interface SemanticSourceRef {
  readonly id: string;
  readonly messageId: string;
  readonly snapshot: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
}

// ── Symbols ────────────────────────────────────────────────────────────

export interface SemanticSymbol {
  readonly id: string;
  /** Original surface text from the user's language. */
  readonly surface: string;
  readonly role: SemanticRole;
  readonly description?: string;
  readonly userDefined?: boolean;
  /** Which source refs this symbol was extracted from. */
  readonly sourceRefIds: readonly string[];
}

// ── Expressions ────────────────────────────────────────────────────────
//
// A discriminated expression AST.  Each expression has a `kind` and
// kind-specific payload fields.  Child references use stable IDs so
// self-reference and cross-reference are representable.

export interface SemanticExpression {
  readonly id: string;
  readonly kind: ExpressionKind;

  // symbol_ref
  readonly symbolId?: string;

  // literal
  readonly value?: string;

  // application
  readonly operatorSymbolId?: string;
  readonly argumentExprIds?: readonly string[];

  // equals
  readonly leftExprId?: string;
  readonly rightExprId?: string;

  // membership
  readonly elementExprId?: string;
  readonly collectionExprId?: string;

  // not
  readonly operandExprId?: string;

  // and / or
  readonly operandExprIds?: readonly string[];

  // implies / iff
  // (reuses leftExprId / rightExprId)

  // forall / exists
  readonly binderSymbolId?: string;
  readonly bodyExprId?: string;
  readonly domainExprId?: string;

  // reference
  readonly targetId?: string;
  readonly targetKind?: string;

  /** Optional human-readable label for debugging / display. */
  readonly label?: string;
}

// ── Statements ─────────────────────────────────────────────────────────

export interface SemanticStatement {
  readonly id: string;
  readonly kind: StatementKind;

  /** definition: the symbol being defined */
  readonly subjectSymbolId?: string;
  /** definition: the defining expression */
  readonly bodyExprId?: string;

  /** rule: premise expression IDs (conjunction) */
  readonly premiseExprIds?: readonly string[];
  /** rule / assertion: the concluding expression */
  readonly conclusionExprId?: string;
  /** assertion: alias for conclusionExprId */
  readonly exprId?: string;

  readonly description?: string;
}

// ── Ambiguities ────────────────────────────────────────────────────────

export interface SemanticAmbiguity {
  readonly id: string;
  readonly kind: AmbiguityKind;
  /** Natural-language question describing what is unclear. */
  readonly question: string;
  /** IDs of symbols, expressions, or statements this ambiguity affects. */
  readonly affectedIds: readonly string[];
  /** When true, this ambiguity blocks semantic acceptance. */
  readonly blocking: boolean;
  /** Optional pre-defined choices with stable, non-derived IDs. */
  readonly choices?: readonly SemanticAmbiguityChoice[];
}

export interface SemanticAmbiguityChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

// ── User Resolutions ───────────────────────────────────────────────────

export interface AmbiguityResolution {
  readonly id: string;
  readonly ambiguityId: string;
  readonly answerText: string;
  readonly selectedChoiceId?: string;
  readonly actor: "user";
  readonly createdAt: string;
}

// ── Auditable Semantic Patches ───────────────────────────────────────

export interface UpdateSemanticSymbolPatch {
  readonly kind: "update_symbol";
  readonly symbolId: string;
  readonly changes: {
    readonly role?: SemanticRole;
    readonly description?: string;
    readonly userDefined?: boolean;
  };
}

export type SemanticPatchOperation = UpdateSemanticSymbolPatch;

export interface SemanticPatch {
  readonly id: string;
  readonly ambiguityId: string;
  readonly resolutionId: string;
  readonly operations: readonly SemanticPatchOperation[];
  readonly createdAt: string;
}

// ── Validation Error ───────────────────────────────────────────────────

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

// ── Core Spec ──────────────────────────────────────────────────────────

export interface SemanticSpec {
  readonly id: string;
  readonly schemaVersion: number;

  // provenance
  readonly claimId: string;
  readonly sourceRefs: readonly SemanticSourceRef[];

  // content
  readonly symbols: readonly SemanticSymbol[];
  readonly expressions: readonly SemanticExpression[];
  readonly statements: readonly SemanticStatement[];

  // ambiguity & resolution
  readonly ambiguities: readonly SemanticAmbiguity[];
  readonly resolutions: readonly AmbiguityResolution[];
  readonly patches: readonly SemanticPatch[];

  // status (derived + user-controlled)
  readonly analysisStatus: SemanticAnalysisStatus;
  readonly reviewStatus: SemanticReviewStatus;

  // audit
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;

  // optional
  readonly description?: string;
}

// ── Creation Parameters ────────────────────────────────────────────────

export interface CreateSemanticSpecParams {
  claimId: string;
  sourceRefs: readonly SemanticSourceRef[];
  symbols: readonly SemanticSymbol[];
  expressions: readonly SemanticExpression[];
  statements: readonly SemanticStatement[];
  ambiguities: readonly SemanticAmbiguity[];
  description?: string;
}

// ── Deep Immutability Helpers ──────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object" && typeof value !== "function") {
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
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }

  const cloned: Record<string, unknown> = {};

  for (const key of Object.keys(value as object)) {
    cloned[key] = deepClone((value as Record<string, unknown>)[key]);
  }

  return cloned as T;
}

// ── ID Generation ──────────────────────────────────────────────────────

function generateShortId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? fallbackId();
  } catch {
    return fallbackId();
  }
}

function fallbackId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Helpers ────────────────────────────────────────────────────────────

function isSemanticRole(value: unknown): value is SemanticRole {
  return typeof value === "string" &&
    (SEMANTIC_ROLES as readonly string[]).includes(value);
}

function isExpressionKind(value: unknown): value is ExpressionKind {
  return typeof value === "string" &&
    (EXPRESSION_KINDS as readonly string[]).includes(value);
}

function isStatementKind(value: unknown): value is StatementKind {
  return typeof value === "string" &&
    (STATEMENT_KINDS as readonly string[]).includes(value);
}

function isAmbiguityKind(value: unknown): value is AmbiguityKind {
  return typeof value === "string" &&
    (AMBIGUITY_KINDS as readonly string[]).includes(value);
}

function normalizeString(value: unknown, maxLength = 5000): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();

  if (trimmed === "" || trimmed.length > maxLength) {
    return "";
  }

  return trimmed;
}

// ── Status Derivation ──────────────────────────────────────────────────

/**
 * Derive analysisStatus from the spec's ambiguity/resolution state.
 *
 * under_specified — at least one blocking ambiguity lacks either a user
 * resolution or its validated semantic effect in the current model.
 * ready_for_review — every blocking ambiguity has both.
 */
export function deriveSemanticAnalysisStatus(
  spec: Readonly<SemanticSpec>
): SemanticAnalysisStatus {
  const unresolved = getUnresolvedBlockingAmbiguities(spec);
  return unresolved.length > 0
    ? "under_specified"
    : "ready_for_review";
}

// ── Validation ─────────────────────────────────────────────────────────

/**
 * Validate a SemanticSpec.  Returns structured errors; empty array = valid.
 */
export function validateSemanticSpec(
  spec: Readonly<SemanticSpec>
): ValidationError[] {
  const errors: ValidationError[] = [];

  // ── ID uniqueness ──────────────────────────────────────────────
  const symbolIds = new Set<string>();
  for (const s of spec.symbols) {
    if (symbolIds.has(s.id)) {
      errors.push({ path: `symbols.${s.id}`, message: `Duplicate symbol ID "${s.id}".` });
    }
    symbolIds.add(s.id);
  }

  const exprIds = new Set<string>();
  for (const e of spec.expressions) {
    if (exprIds.has(e.id)) {
      errors.push({ path: `expressions.${e.id}`, message: `Duplicate expression ID "${e.id}".` });
    }
    exprIds.add(e.id);
  }

  const stmtIds = new Set<string>();
  for (const st of spec.statements) {
    if (stmtIds.has(st.id)) {
      errors.push({ path: `statements.${st.id}`, message: `Duplicate statement ID "${st.id}".` });
    }
    stmtIds.add(st.id);
  }

  const ambigIds = new Set<string>();
  for (const a of spec.ambiguities) {
    if (ambigIds.has(a.id)) {
      errors.push({ path: `ambiguities.${a.id}`, message: `Duplicate ambiguity ID "${a.id}".` });
    }
    ambigIds.add(a.id);

    if (a.choices !== undefined) {
      const choiceIds = new Set<string>();
      for (const choice of a.choices) {
        if (normalizeString(choice.id, 200) === "") {
          errors.push({
            path: `ambiguities.${a.id}.choices`,
            message: "Choice ID cannot be empty."
          });
        } else if (choiceIds.has(choice.id)) {
          errors.push({
            path: `ambiguities.${a.id}.choices.${choice.id}`,
            message: `Duplicate choice ID "${choice.id}".`
          });
        }
        choiceIds.add(choice.id);

        if (normalizeString(choice.label, 1000) === "") {
          errors.push({
            path: `ambiguities.${a.id}.choices.${choice.id}`,
            message: "Choice label cannot be empty."
          });
        }
      }
    }
  }

  const srcRefIds = new Set<string>();
  for (const sr of spec.sourceRefs) {
    if (srcRefIds.has(sr.id)) {
      errors.push({ path: `sourceRefs.${sr.id}`, message: `Duplicate sourceRef ID "${sr.id}".` });
    }
    srcRefIds.add(sr.id);
  }

  const allEntityIds = new Set([
    ...symbolIds,
    ...exprIds,
    ...stmtIds
  ]);

  // ── sourceRefIds must point to existing source refs ────────────
  for (const sym of spec.symbols) {
    for (const refId of sym.sourceRefIds) {
      if (!srcRefIds.has(refId)) {
        errors.push({
          path: `symbols.${sym.id}.sourceRefIds`,
          message: `Source ref "${refId}" not found.`
        });
      }
    }
  }

  // ── Expression child IDs must exist ────────────────────────────
  for (const expr of spec.expressions) {
    if (!isExpressionKind(expr.kind)) {
      errors.push({
        path: `expressions.${expr.id}`,
        message: `Unknown expression kind "${expr.kind}".`
      });
      continue;
    }

    switch (expr.kind) {
      case "symbol_ref": {
        if (expr.symbolId === undefined) {
          errors.push({
            path: `expressions.${expr.id}`,
            message: "symbol_ref requires symbolId."
          });
        } else if (!symbolIds.has(expr.symbolId)) {
          errors.push({
            path: `expressions.${expr.id}.symbolId`,
            message: `Symbol "${expr.symbolId}" not found.`
          });
        }
        break;
      }
      case "literal": {
        if (expr.value === undefined || expr.value.trim() === "") {
          errors.push({
            path: `expressions.${expr.id}`,
            message: "literal requires a non-empty value."
          });
        }
        break;
      }
      case "application": {
        if (expr.operatorSymbolId === undefined) {
          errors.push({
            path: `expressions.${expr.id}`,
            message: "application requires operatorSymbolId."
          });
        } else if (!symbolIds.has(expr.operatorSymbolId)) {
          errors.push({
            path: `expressions.${expr.id}.operatorSymbolId`,
            message: `Symbol "${expr.operatorSymbolId}" not found.`
          });
        }
        if (expr.argumentExprIds !== undefined) {
          for (const argId of expr.argumentExprIds) {
            if (!exprIds.has(argId)) {
              errors.push({
                path: `expressions.${expr.id}.argumentExprIds`,
                message: `Expression "${argId}" not found.`
              });
            }
          }
        }
        break;
      }
      case "equals": {
        if (expr.leftExprId === undefined || expr.rightExprId === undefined) {
          errors.push({
            path: `expressions.${expr.id}`,
            message: "equals requires leftExprId and rightExprId."
          });
        } else {
          if (!exprIds.has(expr.leftExprId)) {
            errors.push({
              path: `expressions.${expr.id}.leftExprId`,
              message: `Expression "${expr.leftExprId}" not found.`
            });
          }
          if (!exprIds.has(expr.rightExprId)) {
            errors.push({
              path: `expressions.${expr.id}.rightExprId`,
              message: `Expression "${expr.rightExprId}" not found.`
            });
          }
        }
        break;
      }
      case "membership": {
        if (expr.elementExprId === undefined || expr.collectionExprId === undefined) {
          errors.push({
            path: `expressions.${expr.id}`,
            message: "membership requires elementExprId and collectionExprId."
          });
        } else {
          if (!exprIds.has(expr.elementExprId)) {
            errors.push({
              path: `expressions.${expr.id}.elementExprId`,
              message: `Expression "${expr.elementExprId}" not found.`
            });
          }
          if (!exprIds.has(expr.collectionExprId)) {
            errors.push({
              path: `expressions.${expr.id}.collectionExprId`,
              message: `Expression "${expr.collectionExprId}" not found.`
            });
          }
        }
        break;
      }
      case "not": {
        if (expr.operandExprId === undefined) {
          errors.push({
            path: `expressions.${expr.id}`,
            message: "not requires operandExprId."
          });
        } else if (!exprIds.has(expr.operandExprId)) {
          errors.push({
            path: `expressions.${expr.id}.operandExprId`,
            message: `Expression "${expr.operandExprId}" not found.`
          });
        }
        break;
      }
      case "and":
      case "or": {
        if (expr.operandExprIds === undefined || expr.operandExprIds.length < 2) {
          errors.push({
            path: `expressions.${expr.id}`,
            message: `${expr.kind} requires at least 2 operandExprIds.`
          });
        } else {
          for (const opId of expr.operandExprIds) {
            if (!exprIds.has(opId)) {
              errors.push({
                path: `expressions.${expr.id}.operandExprIds`,
                message: `Expression "${opId}" not found.`
              });
            }
          }
        }
        break;
      }
      case "implies":
      case "iff": {
        if (expr.leftExprId === undefined || expr.rightExprId === undefined) {
          errors.push({
            path: `expressions.${expr.id}`,
            message: `${expr.kind} requires leftExprId and rightExprId.`
          });
        } else {
          if (!exprIds.has(expr.leftExprId)) {
            errors.push({
              path: `expressions.${expr.id}.leftExprId`,
              message: `Expression "${expr.leftExprId}" not found.`
            });
          }
          if (!exprIds.has(expr.rightExprId)) {
            errors.push({
              path: `expressions.${expr.id}.rightExprId`,
              message: `Expression "${expr.rightExprId}" not found.`
            });
          }
        }
        break;
      }
      case "forall":
      case "exists": {
        if (expr.binderSymbolId === undefined) {
          errors.push({
            path: `expressions.${expr.id}`,
            message: `${expr.kind} requires binderSymbolId.`
          });
        } else if (!symbolIds.has(expr.binderSymbolId)) {
          errors.push({
            path: `expressions.${expr.id}.binderSymbolId`,
            message: `Symbol "${expr.binderSymbolId}" not found.`
          });
        }
        if (expr.bodyExprId === undefined) {
          errors.push({
            path: `expressions.${expr.id}`,
            message: `${expr.kind} requires bodyExprId.`
          });
        } else if (!exprIds.has(expr.bodyExprId)) {
          errors.push({
            path: `expressions.${expr.id}.bodyExprId`,
            message: `Expression "${expr.bodyExprId}" not found.`
          });
        }
        if (expr.domainExprId !== undefined && !exprIds.has(expr.domainExprId)) {
          errors.push({
            path: `expressions.${expr.id}.domainExprId`,
            message: `Expression "${expr.domainExprId}" not found.`
          });
        }
        break;
      }
      case "reference": {
        if (expr.targetId === undefined || expr.targetKind === undefined) {
          errors.push({
            path: `expressions.${expr.id}`,
            message: "reference requires targetId and targetKind."
          });
        }
        break;
      }
    }
  }

  // ── Statement expression IDs must exist ────────────────────────
  for (const stmt of spec.statements) {
    if (!isStatementKind(stmt.kind)) {
      errors.push({
        path: `statements.${stmt.id}`,
        message: `Unknown statement kind "${stmt.kind}".`
      });
      continue;
    }

    switch (stmt.kind) {
      case "assertion": {
        const assertionExprId = stmt.exprId ?? stmt.conclusionExprId;
        if (assertionExprId === undefined) {
          errors.push({
            path: `statements.${stmt.id}`,
            message: "assertion requires exprId or conclusionExprId."
          });
        } else if (!exprIds.has(assertionExprId)) {
          errors.push({
            path: `statements.${stmt.id}.exprId`,
            message: `Expression "${assertionExprId}" not found.`
          });
        }
        break;
      }
      case "definition": {
        if (stmt.subjectSymbolId === undefined) {
          errors.push({
            path: `statements.${stmt.id}`,
            message: "definition requires subjectSymbolId."
          });
        } else if (!symbolIds.has(stmt.subjectSymbolId)) {
          errors.push({
            path: `statements.${stmt.id}.subjectSymbolId`,
            message: `Symbol "${stmt.subjectSymbolId}" not found.`
          });
        }
        if (stmt.bodyExprId === undefined) {
          errors.push({
            path: `statements.${stmt.id}`,
            message: "definition requires bodyExprId."
          });
        } else if (!exprIds.has(stmt.bodyExprId)) {
          errors.push({
            path: `statements.${stmt.id}.bodyExprId`,
            message: `Expression "${stmt.bodyExprId}" not found.`
          });
        }
        break;
      }
      case "rule": {
        if (stmt.premiseExprIds !== undefined) {
          for (const premId of stmt.premiseExprIds) {
            if (!exprIds.has(premId)) {
              errors.push({
                path: `statements.${stmt.id}.premiseExprIds`,
                message: `Expression "${premId}" not found.`
              });
            }
          }
        }
        if (stmt.conclusionExprId === undefined) {
          errors.push({
            path: `statements.${stmt.id}`,
            message: "rule requires conclusionExprId."
          });
        } else if (!exprIds.has(stmt.conclusionExprId)) {
          errors.push({
            path: `statements.${stmt.id}.conclusionExprId`,
            message: `Expression "${stmt.conclusionExprId}" not found.`
          });
        }
        break;
      }
    }
  }

  // ── Ambiguity affectedIds must exist ───────────────────────────
  for (const amb of spec.ambiguities) {
    if (!isAmbiguityKind(amb.kind)) {
      errors.push({
        path: `ambiguities.${amb.id}`,
        message: `Unknown ambiguity kind "${amb.kind}".`
      });
    }
    for (const affectedId of amb.affectedIds) {
      if (!allEntityIds.has(affectedId)) {
        errors.push({
          path: `ambiguities.${amb.id}.affectedIds`,
          message: `Affected ID "${affectedId}" not found in symbols, expressions, or statements.`
        });
      }
    }
  }

  // ── Resolutions must refer to existing ambiguities ─────────────
  const resolutionCountByAmbiguity = new Map<string, number>();
  const resolutionIds = new Set<string>();

  for (const res of spec.resolutions) {
    if (resolutionIds.has(res.id)) {
      errors.push({
        path: `resolutions.${res.id}`,
        message: `Duplicate resolution ID "${res.id}".`
      });
    }
    resolutionIds.add(res.id);
    if (!ambigIds.has(res.ambiguityId)) {
      errors.push({
        path: `resolutions.${res.id}`,
        message: `Ambiguity "${res.ambiguityId}" not found.`
      });
    }
    if (res.actor !== "user") {
      errors.push({
        path: `resolutions.${res.id}`,
        message: `Resolution actor must be "user", got "${res.actor}".`
      });
    }
    const count = resolutionCountByAmbiguity.get(res.ambiguityId) ?? 0;
    resolutionCountByAmbiguity.set(res.ambiguityId, count + 1);

    if (res.selectedChoiceId !== undefined) {
      const amb = spec.ambiguities.find((a) => a.id === res.ambiguityId);
      if (
        amb?.choices === undefined ||
        !amb.choices.some((choice) => choice.id === res.selectedChoiceId)
      ) {
        errors.push({
          path: `resolutions.${res.id}.selectedChoiceId`,
          message: `Choice "${res.selectedChoiceId}" not in ambiguity choices.`
        });
      }
    }
  }

  // ── Semantic patches must be explicit, linked, and structurally safe ─
  const patchIds = new Set<string>();
  const patchCountByAmbiguity = new Map<string, number>();
  for (const patch of spec.patches) {
    if (patchIds.has(patch.id)) {
      errors.push({
        path: `patches.${patch.id}`,
        message: `Duplicate patch ID "${patch.id}".`
      });
    }
    patchIds.add(patch.id);

    const ambiguity = spec.ambiguities.find(
      (item) => item.id === patch.ambiguityId
    );
    const resolution = spec.resolutions.find(
      (item) => item.id === patch.resolutionId
    );

    if (ambiguity === undefined) {
      errors.push({
        path: `patches.${patch.id}.ambiguityId`,
        message: `Ambiguity "${patch.ambiguityId}" not found.`
      });
    }
    if (resolution === undefined) {
      errors.push({
        path: `patches.${patch.id}.resolutionId`,
        message: `Resolution "${patch.resolutionId}" not found.`
      });
    } else if (resolution.ambiguityId !== patch.ambiguityId) {
      errors.push({
        path: `patches.${patch.id}.resolutionId`,
        message:
          `Resolution "${patch.resolutionId}" belongs to ambiguity ` +
          `"${resolution.ambiguityId}", not "${patch.ambiguityId}".`
      });
    }

    const count = patchCountByAmbiguity.get(patch.ambiguityId) ?? 0;
    patchCountByAmbiguity.set(patch.ambiguityId, count + 1);

    if (patch.operations.length === 0) {
      errors.push({
        path: `patches.${patch.id}.operations`,
        message: "Semantic patch must contain at least one operation."
      });
    }

    for (let index = 0; index < patch.operations.length; index += 1) {
      const operation = patch.operations[index]!;
      const path = `patches.${patch.id}.operations.${index}`;

      if (operation.kind !== "update_symbol") {
        errors.push({ path, message: `Unsupported semantic patch operation.` });
        continue;
      }

      const symbol = spec.symbols.find((item) => item.id === operation.symbolId);
      if (symbol === undefined) {
        errors.push({
          path: `${path}.symbolId`,
          message: `Symbol "${operation.symbolId}" not found.`
        });
      }
      if (
        ambiguity !== undefined &&
        !ambiguity.affectedIds.includes(operation.symbolId)
      ) {
        errors.push({
          path: `${path}.symbolId`,
          message:
            `Symbol "${operation.symbolId}" is not affected by ambiguity ` +
            `"${ambiguity.id}".`
        });
      }

      const changeRecord = operation.changes as Record<string, unknown>;
      const allowedKeys = new Set(["role", "description", "userDefined"]);
      const keys = Object.keys(changeRecord);
      if (keys.length === 0) {
        errors.push({ path: `${path}.changes`, message: "Symbol changes cannot be empty." });
      }
      for (const key of keys) {
        if (!allowedKeys.has(key)) {
          errors.push({
            path: `${path}.changes.${key}`,
            message: `Symbol field "${key}" cannot be changed by a semantic patch.`
          });
        }
      }
      if (operation.changes.role !== undefined &&
          !isSemanticRole(operation.changes.role)) {
        errors.push({
          path: `${path}.changes.role`,
          message: `Unknown semantic role "${operation.changes.role}".`
        });
      }
      if (operation.changes.description !== undefined &&
          normalizeString(operation.changes.description) === "") {
        errors.push({
          path: `${path}.changes.description`,
          message: "Symbol description cannot be empty."
        });
      }
      if (operation.changes.userDefined !== undefined &&
          typeof operation.changes.userDefined !== "boolean") {
        errors.push({
          path: `${path}.changes.userDefined`,
          message: "userDefined must be boolean."
        });
      }
    }
  }

  for (const [ambiguityId, count] of patchCountByAmbiguity) {
    if (count > 1) {
      errors.push({
        path: "patches",
        message:
          `Ambiguity "${ambiguityId}" has ${count} semantic patches; ` +
          "at most one is allowed in M1."
      });
    }
  }

  // ── At most one user resolution per ambiguity ─────────────────
  for (const [ambId, count] of resolutionCountByAmbiguity) {
    if (count > 1) {
      errors.push({
        path: `resolutions`,
        message: `Ambiguity "${ambId}" has ${count} resolutions; at most one is allowed.`
      });
    }
  }

  // ── analysisStatus must match derivation ──────────────────────
  const derivedStatus = deriveSemanticAnalysisStatus(spec);
  if (spec.analysisStatus !== derivedStatus) {
    errors.push({
      path: "analysisStatus",
      message:
        `analysisStatus is "${spec.analysisStatus}" but should be ` +
        `"${derivedStatus}" based on blocking ambiguity resolution state.`
    });
  }

  // ── Accepted specs cannot have unresolved blocking ambiguities ─
  if (
    spec.reviewStatus === "accepted" &&
    derivedStatus === "under_specified"
  ) {
    errors.push({
      path: "reviewStatus",
      message:
        "Cannot be accepted when unresolved blocking ambiguities remain."
    });
  }

  return errors;
}

// ── Ambiguity Resolution Status ────────────────────────────────────────

export function isAmbiguityResolved(
  spec: Readonly<SemanticSpec>,
  ambiguityId: string
): boolean {
  const ambiguity = spec.ambiguities.find((item) => item.id === ambiguityId);
  const resolution = spec.resolutions.find(
    (item) => item.ambiguityId === ambiguityId
  );

  if (ambiguity === undefined || resolution === undefined) {
    return false;
  }

  const patch = spec.patches.find(
    (item) =>
      item.ambiguityId === ambiguityId &&
      item.resolutionId === resolution.id
  );

  if (patch === undefined || patch.operations.length === 0) {
    return false;
  }

  for (const operation of patch.operations) {
    if (operation.kind !== "update_symbol") {
      return false;
    }

    const symbol = spec.symbols.find(
      (item) => item.id === operation.symbolId
    );
    if (symbol === undefined || !ambiguity.affectedIds.includes(symbol.id)) {
      return false;
    }
    if (
      operation.changes.role !== undefined &&
      symbol.role !== operation.changes.role
    ) {
      return false;
    }
    if (
      operation.changes.description !== undefined &&
      symbol.description !== operation.changes.description
    ) {
      return false;
    }
    if (
      operation.changes.userDefined !== undefined &&
      symbol.userDefined !== operation.changes.userDefined
    ) {
      return false;
    }
  }

  // A blocking ambiguity cannot be semantically resolved while one of its
  // affected symbols still has unresolved meaning. This is deliberately
  // local: unrelated non-blocking unresolved symbols remain allowed.
  if (ambiguity.blocking) {
    const unresolvedAffectedSymbol = spec.symbols.some(
      (symbol) =>
        ambiguity.affectedIds.includes(symbol.id) &&
        symbol.role === "unresolved"
    );
    if (unresolvedAffectedSymbol) {
      return false;
    }
  }

  return true;
}

export function getUnresolvedBlockingAmbiguities(
  spec: Readonly<SemanticSpec>
): readonly SemanticAmbiguity[] {
  return spec.ambiguities.filter(
    (a) => a.blocking && !isAmbiguityResolved(spec, a.id)
  );
}

// ── Factory ────────────────────────────────────────────────────────────

export function createSemanticSpec(
  params: CreateSemanticSpecParams
): SemanticSpec {
  const now = new Date().toISOString();

  // Assign stable IDs to source refs that lack them
  const frozenSourceRefs = deepFreeze(
    params.sourceRefs.map((ref) =>
      deepFreeze({
        ...ref,
        id: ref.id || generateShortId()
      })
    )
  );

  const frozenSymbols = deepFreeze(
    params.symbols.map((s) => deepFreeze({ ...s }))
  );
  const frozenExpressions = deepFreeze(
    params.expressions.map((e) => deepFreeze({ ...e }))
  );
  const frozenStatements = deepFreeze(
    params.statements.map((st) => deepFreeze({ ...st }))
  );
  const frozenAmbiguities = deepFreeze(
    params.ambiguities.map((a) => deepFreeze({
      ...a,
      affectedIds: [...a.affectedIds],
      choices: a.choices?.map((choice) => ({ ...choice }))
    }))
  );

  const spec: SemanticSpec = {
    id: generateShortId(),
    schemaVersion: SEMANTIC_SPEC_SCHEMA_VERSION,
    claimId: params.claimId,
    sourceRefs: frozenSourceRefs,
    symbols: frozenSymbols,
    expressions: frozenExpressions,
    statements: frozenStatements,
    ambiguities: frozenAmbiguities,
    resolutions: deepFreeze([]),
    patches: deepFreeze([]),
    analysisStatus: "under_specified", // placeholder; validated below
    reviewStatus: "pending",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    description: params.description
  };

  // Derive and set analysisStatus
  const derivedStatus = deriveSemanticAnalysisStatus(spec);
  const withStatus: SemanticSpec = {
    ...spec,
    analysisStatus: derivedStatus
  };

  // Validate
  const invariantErrors = validateSemanticSpec(withStatus);

  if (invariantErrors.length > 0) {
    throw new Error(
      "SemanticSpec invariants violated:\n" +
      invariantErrors.map((e) => `  ${e.path}: ${e.message}`).join("\n")
    );
  }

  return deepFreeze(withStatus);
}

// ── Controlled Updates ─────────────────────────────────────────────────

/**
 * Apply a user resolution to an ambiguity.
 *
 * Returns a new SemanticSpec with the user answer appended. This does not
 * apply semantic meaning; analysis remains under-specified until a linked
 * SemanticPatch changes the model.
 */
export function resolveAmbiguity(
  spec: Readonly<SemanticSpec>,
  ambiguityId: string,
  answerText: string,
  selectedChoiceId?: string
): SemanticSpec {
  const amb = spec.ambiguities.find((a) => a.id === ambiguityId);

  if (amb === undefined) {
    throw new Error(`Ambiguity "${ambiguityId}" not found.`);
  }

  // Check not already resolved
  if (spec.resolutions.some((item) => item.ambiguityId === ambiguityId)) {
    throw new Error(`Ambiguity "${ambiguityId}" already has a user resolution.`);
  }

  if (answerText.trim() === "") {
    throw new Error("Resolution answerText cannot be empty.");
  }

  if (
    selectedChoiceId !== undefined &&
    (amb.choices === undefined ||
      !amb.choices.some((choice) => choice.id === selectedChoiceId))
  ) {
    throw new Error(
      `Choice "${selectedChoiceId}" is not in the ambiguity's choices.`
    );
  }

  const now = new Date().toISOString();

  const resolution: AmbiguityResolution = deepFreeze({
    id: generateShortId(),
    ambiguityId,
    answerText: answerText.trim(),
    selectedChoiceId,
    actor: "user",
    createdAt: now
  });

  const nextResolutions = deepFreeze([
    ...spec.resolutions,
    resolution
  ]);

  const nextAnalysisStatus = deriveSemanticAnalysisStatus({
    ...spec,
    resolutions: nextResolutions
  });

  const next: SemanticSpec = {
    ...spec,
    resolutions: nextResolutions,
    analysisStatus: nextAnalysisStatus,
    revision: spec.revision + 1,
    updatedAt: now
  };

  const invariantErrors = validateSemanticSpec(next);

  if (invariantErrors.length > 0) {
    throw new Error(
      "SemanticSpec invariants violated after resolution:\n" +
      invariantErrors.map((e) => `  ${e.path}: ${e.message}`).join("\n")
    );
  }

  return deepFreeze(next);
}

/**
 * Apply a validated, explicit semantic patch linked to one user resolution.
 * The previous spec, source snapshots, ambiguity, and resolution are never
 * mutated. M1 intentionally supports only update_symbol operations.
 */
export function applySemanticPatch(
  spec: Readonly<SemanticSpec>,
  patch: Readonly<SemanticPatch>
): SemanticSpec {
  if (spec.reviewStatus === "accepted") {
    throw new Error("Cannot patch an accepted SemanticSpec.");
  }

  if (spec.patches.some((item) => item.id === patch.id)) {
    throw new Error(`Semantic patch "${patch.id}" already exists.`);
  }

  const ambiguity = spec.ambiguities.find(
    (item) => item.id === patch.ambiguityId
  );
  if (ambiguity === undefined) {
    throw new Error(`Ambiguity "${patch.ambiguityId}" not found.`);
  }

  const resolution = spec.resolutions.find(
    (item) => item.id === patch.resolutionId
  );
  if (resolution === undefined) {
    throw new Error(`Resolution "${patch.resolutionId}" not found.`);
  }
  if (resolution.ambiguityId !== patch.ambiguityId) {
    throw new Error(
      `Resolution "${patch.resolutionId}" belongs to ambiguity ` +
      `"${resolution.ambiguityId}", not "${patch.ambiguityId}".`
    );
  }
  if (spec.patches.some((item) => item.ambiguityId === patch.ambiguityId)) {
    throw new Error(
      `Ambiguity "${patch.ambiguityId}" already has an applied semantic patch.`
    );
  }

  const frozenPatch = deepFreeze(deepClone(patch)) as SemanticPatch;
  const candidateForValidation: SemanticSpec = {
    ...spec,
    patches: deepFreeze([...spec.patches, frozenPatch])
  };
  const structuralErrors = validateSemanticSpec(candidateForValidation)
    .filter((error) => error.path.startsWith(`patches.${patch.id}`) ||
      error.path === "patches");
  if (structuralErrors.length > 0) {
    throw new Error(
      "Invalid semantic patch:\n" +
      structuralErrors.map((error) =>
        `  ${error.path}: ${error.message}`).join("\n")
    );
  }

  const nextSymbols = spec.symbols.map((symbol) => {
    const operations = frozenPatch.operations.filter(
      (operation) =>
        operation.kind === "update_symbol" &&
        operation.symbolId === symbol.id
    );
    if (operations.length === 0) {
      return symbol;
    }

    let updated: SemanticSymbol = { ...symbol };
    for (const operation of operations) {
      updated = {
        ...updated,
        ...operation.changes,
        id: symbol.id,
        surface: symbol.surface,
        sourceRefIds: symbol.sourceRefIds
      };
    }
    return deepFreeze(updated);
  });

  const now = new Date().toISOString();
  const withPatch: SemanticSpec = {
    ...spec,
    symbols: deepFreeze(nextSymbols),
    patches: deepFreeze([...spec.patches, frozenPatch]),
    analysisStatus: "under_specified",
    revision: spec.revision + 1,
    updatedAt: now
  };
  const next: SemanticSpec = {
    ...withPatch,
    analysisStatus: deriveSemanticAnalysisStatus(withPatch)
  };

  const invariantErrors = validateSemanticSpec(next);
  if (invariantErrors.length > 0) {
    throw new Error(
      "SemanticSpec invariants violated after semantic patch:\n" +
      invariantErrors.map((error) =>
        `  ${error.path}: ${error.message}`).join("\n")
    );
  }

  return deepFreeze(next);
}

/**
 * Accept a SemanticSpec.
 *
 * Fails if unresolved blocking ambiguities remain.
 *
 * Success means only: "The user confirms that this semantic structure
 * matches their intended meaning."  No Lean encoding or verification
 * is implied.
 */
export function acceptSemanticSpec(
  spec: Readonly<SemanticSpec>
): SemanticSpec {
  if (spec.reviewStatus === "accepted") {
    throw new Error("SemanticSpec is already accepted.");
  }

  const unresolved = getUnresolvedBlockingAmbiguities(spec);

  if (unresolved.length > 0) {
    const ids = unresolved.map((a) => a.id).join(", ");
    throw new Error(
      `Cannot accept: unresolved blocking ambiguities remain: ${ids}`
    );
  }

  const now = new Date().toISOString();

  const next: SemanticSpec = {
    ...spec,
    reviewStatus: "accepted",
    revision: spec.revision + 1,
    updatedAt: now
  };

  const invariantErrors = validateSemanticSpec(next);

  if (invariantErrors.length > 0) {
    throw new Error(
      "SemanticSpec invariants violated after accept:\n" +
      invariantErrors.map((e) => `  ${e.path}: ${e.message}`).join("\n")
    );
  }

  return deepFreeze(next);
}

// ── Expression Traversal ───────────────────────────────────────────────

/**
 * Collect all symbol IDs referenced (directly or transitively) by an
 * expression within the spec.
 */
export function collectReferencedSymbolIds(
  spec: Readonly<SemanticSpec>,
  expressionId: string
): string[] {
  const exprIndex = new Map<string, Readonly<SemanticExpression>>();
  for (const e of spec.expressions) {
    exprIndex.set(e.id, e);
  }

  const visited = new Set<string>();
  const symbolIds = new Set<string>();

  function walk(exprId: string): void {
    if (visited.has(exprId)) {
      return;
    }
    visited.add(exprId);

    const expr = exprIndex.get(exprId);
    if (expr === undefined) {
      return;
    }

    // Collect direct symbol references
    if (expr.kind === "symbol_ref" && expr.symbolId !== undefined) {
      symbolIds.add(expr.symbolId);
    }
    if (expr.kind === "application" && expr.operatorSymbolId !== undefined) {
      symbolIds.add(expr.operatorSymbolId);
    }
    if (
      (expr.kind === "forall" || expr.kind === "exists") &&
      expr.binderSymbolId !== undefined
    ) {
      symbolIds.add(expr.binderSymbolId);
    }

    // Recurse into child expressions
    const childIds: string[] = [];
    if (expr.argumentExprIds !== undefined) {
      childIds.push(...expr.argumentExprIds);
    }
    if (expr.operandExprIds !== undefined) {
      childIds.push(...expr.operandExprIds);
    }
    if (expr.leftExprId !== undefined) childIds.push(expr.leftExprId);
    if (expr.rightExprId !== undefined) childIds.push(expr.rightExprId);
    if (expr.operandExprId !== undefined) childIds.push(expr.operandExprId);
    if (expr.elementExprId !== undefined) childIds.push(expr.elementExprId);
    if (expr.collectionExprId !== undefined) childIds.push(expr.collectionExprId);
    if (expr.bodyExprId !== undefined) childIds.push(expr.bodyExprId);
    if (expr.domainExprId !== undefined) childIds.push(expr.domainExprId);

    for (const childId of childIds) {
      walk(childId);
    }
  }

  walk(expressionId);
  return [...symbolIds].sort();
}

// ── Definition Dependency Graph ────────────────────────────────────────

/**
 * Build a dependency graph from definition statements.
 *
 * If definition A has body expression containing symbol B,
 * then edge A → B exists.
 *
 * Returns a Map from subjectSymbolId to the set of symbol IDs it depends on.
 */
export function buildDefinitionDependencyGraph(
  spec: Readonly<SemanticSpec>
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  for (const stmt of spec.statements) {
    if (
      stmt.kind !== "definition" ||
      stmt.subjectSymbolId === undefined ||
      stmt.bodyExprId === undefined
    ) {
      continue;
    }

    const referencedSymbols = collectReferencedSymbolIds(spec, stmt.bodyExprId);
    graph.set(stmt.subjectSymbolId, new Set(referencedSymbols));
  }

  return graph;
}

/**
 * Detect cycles in the definition dependency graph.
 *
 * Returns a list of cycles.  Each cycle is a list of symbol IDs
 * forming the cycle (first and last are the same).
 *
 * A cycle is NOT automatically a contradiction — it is structural
 * information only.
 */
export function detectDefinitionCycles(
  spec: Readonly<SemanticSpec>
): string[][] {
  const graph = buildDefinitionDependencyGraph(spec);
  const cycles: string[][] = [];

  // Tarjan-like DFS for cycle detection
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();

  for (const node of graph.keys()) {
    color.set(node, WHITE);
  }

  function dfs(node: string, path: string[]): void {
    color.set(node, GRAY);
    path.push(node);

    const neighbors = graph.get(node);
    if (neighbors !== undefined) {
      for (const neighbor of neighbors) {
        if (!graph.has(neighbor)) {
          // neighbor is not a definition node — skip
          continue;
        }

        const neighborColor = color.get(neighbor);

        if (neighborColor === GRAY) {
          // Found a cycle — extract it from the path
          const cycleStart = path.indexOf(neighbor);
          if (cycleStart !== -1) {
            const cycle = [...path.slice(cycleStart), neighbor];
            cycles.push(cycle);
          }
        } else if (neighborColor === WHITE) {
          parent.set(neighbor, node);
          dfs(neighbor, path);
        }
      }
    }

    path.pop();
    color.set(node, BLACK);
  }

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node, []);
    }
  }

  return cycles;
}
