// ── Lean Proof Verification ───────────────────────────────────────────
// The first genuine Lean proof-verification path.
//
// A proof is verified only when:
//   1. the candidate is bound to an exact Lean theorem statement,
//   2. the candidate passes the placeholder / fresh-declaration validator,
//   3. the trusted wrapper is constructed here (not by the model),
//   4. the existing LeanRunner elaborates the wrapper successfully.
//
// proof_verified is never inferred from statement checking, model output,
// semantic acceptance, or UI confirmation.
// ────────────────────────────────────────────────────────────────────────

import type {
  LeanRunner,
  LeanDiagnostic
} from "./FormalizationProtocol";

export type LeanProofProvenance =
  | "user_authored"
  | "ai_generated"
  | "user_edited"
  | "imported";

export type LeanProofVerificationFailure =
  | "invalid_candidate"
  | "placeholder_rejected"
  | "stale_candidate"
  | "statement_mismatch"
  | "lean_error"
  | "timeout"
  | "environment_error";

export interface LeanProofCandidate {
  readonly id: string;
  readonly formalizationId: string;
  readonly irId?: string;
  /** Exact Lean proposition being proved. */
  readonly theoremStatement: string;
  readonly theoremStatementHash: string;
  readonly proofBody: string;
  readonly imports: readonly string[];
  readonly provenance: LeanProofProvenance;
  readonly editedByUser: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateLeanProofCandidateInput {
  readonly id?: string;
  readonly formalizationId: string;
  readonly irId?: string;
  readonly theoremStatement: string;
  readonly proofBody: string;
  readonly imports?: readonly string[];
  readonly provenance?: LeanProofProvenance;
  readonly editedByUser?: boolean;
  readonly createdAt?: string;
}

export interface LeanProofValidationIssue {
  readonly code:
    | "missing_statement"
    | "missing_proof"
    | "placeholder"
    | "fresh_declaration"
    | "unsafe_axiom"
    | "missing_formalization";
  readonly message: string;
}

export type LeanProofVerificationResult =
  | {
      readonly ok: true;
      readonly verified: true;
      readonly source: string;
      readonly theoremName: string;
    }
  | {
      readonly ok: false;
      readonly verified: false;
      readonly failure: LeanProofVerificationFailure;
      readonly diagnostics: readonly LeanDiagnostic[];
      readonly error: string;
      readonly source?: string;
    };

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

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Deterministic FNV-1a hash used for exact statement and proof binding. */
export function hashLeanStatement(
  statement: string,
  imports: readonly string[] = []
): string {
  const canonical = [statement.trim(), ...imports.map((item) => item.trim())]
    .join("\n");
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Extract the proposition from a generated `#check (...)` source.  This is a
 * narrow, deterministic helper for the current statement-check shape; it is
 * not a general Lean parser.
 */
export function extractLeanPropositionFromCheckSource(
  source: string
): string {
  const line = source
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.startsWith("#check"));
  if (line === undefined) {
    return "";
  }
  const rest = line.slice("#check".length).trim();
  if (!rest.startsWith("(")) {
    return rest;
  }

  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const char = rest[i];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return rest.slice(1, i).trim();
      }
    }
  }
  return rest.slice(1).trim();
}

export function createLeanProofCandidate(
  input: Readonly<CreateLeanProofCandidateInput>
): LeanProofCandidate {
  const formalizationId = nonEmpty(input.formalizationId);
  const theoremStatement = nonEmpty(input.theoremStatement);
  if (formalizationId === "") {
    throw new Error("formalizationId must be non-empty.");
  }
  if (theoremStatement === "") {
    throw new Error("theoremStatement must be non-empty.");
  }
  const now = input.createdAt ?? new Date().toISOString();
  return {
    id: nonEmpty(input.id) || generateId(),
    formalizationId,
    irId: input.irId,
    theoremStatement,
    theoremStatementHash: hashLeanStatement(
      theoremStatement,
      input.imports ?? []
    ),
    proofBody: input.proofBody.trim(),
    imports: [...(input.imports ?? [])],
    provenance: input.provenance ?? "user_authored",
    editedByUser: input.editedByUser ?? false,
    createdAt: now,
    updatedAt: now
  };
}

export function deriveSafeTheoremName(
  formalizationId: string,
  statementHash: string
): string {
  const suffix = statementHash.slice(0, 12);
  return `lain_target_${suffix}`;
}

const PLACEHOLDER_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  message: string;
}> = [
  { pattern: /\bsorry\b/, message: "Proof body contains 'sorry'." },
  { pattern: /\badmit\b/, message: "Proof body contains 'admit'." },
  { pattern: /\bsorryAx\b/, message: "Proof body references 'sorryAx'." }
];

const FRESH_DECLARATION_PATTERN =
  /^(?:axiom|theorem|example|lemma|def|inductive|structure|class|instance|import|set_option|open|namespace|section|universe)\b/;

export function validateLeanProofCandidate(
  candidate: Readonly<LeanProofCandidate>
): LeanProofValidationIssue[] {
  const issues: LeanProofValidationIssue[] = [];
  if (nonEmpty(candidate.formalizationId) === "") {
    issues.push({
      code: "missing_formalization",
      message: "Proof candidate must reference a FormalizationRecord."
    });
  }
  if (nonEmpty(candidate.theoremStatement) === "") {
    issues.push({
      code: "missing_statement",
      message: "Proof candidate must include an exact theorem statement."
    });
  }
  if (nonEmpty(candidate.proofBody) === "") {
    issues.push({
      code: "missing_proof",
      message: "Proof candidate must include a proof body."
    });
  }

  for (const { pattern, message } of PLACEHOLDER_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(candidate.proofBody)) {
      issues.push({ code: "placeholder", message });
    }
  }

  for (const line of candidate.proofBody.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("--")) {
      continue;
    }
    FRESH_DECLARATION_PATTERN.lastIndex = 0;
    if (FRESH_DECLARATION_PATTERN.test(trimmed)) {
      issues.push({
        code: "fresh_declaration",
        message:
          `Proof body introduces a top-level declaration: "${trimmed}".`
      });
    }
  }

  return issues;
}

function indentBlock(body: string): string {
  const lines = body.split("\n");
  if (lines.length <= 1) {
    return "  " + body.trim();
  }
  return lines.map((line) => "  " + line).join("\n");
}

/**
 * Construct the exact Lean source sent to the runner.  The theorem proposition
 * is taken from the candidate, and the proof body is nested inside a trusted
 * theorem declaration, preventing the body from replacing the target.
 */
export function buildLeanProofVerificationSource(
  candidate: Readonly<LeanProofCandidate>,
  theoremName: string = deriveSafeTheoremName(
    candidate.formalizationId,
    candidate.theoremStatementHash
  )
): string {
  const importLines = candidate.imports
    .map((module) => `import ${module}`)
    .join("\n");
  const header = importLines === ""
    ? "set_option autoImplicit false"
    : importLines + "\n\nset_option autoImplicit false";

  return (
    header +
    "\n\n" +
    `theorem ${theoremName} : ${candidate.theoremStatement} := by\n` +
    indentBlock(candidate.proofBody)
  );
}

function classifyFailure(
  diagnostics: readonly LeanDiagnostic[],
  stderr: string
): LeanProofVerificationFailure {
  const text = [
    ...diagnostics.map((diagnostic) => diagnostic.message),
    stderr
  ].join("\n");
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) {
    return "timeout";
  }
  if (/ENOENT|spawn|executable|command not found|no such file/i.test(text)) {
    return "environment_error";
  }
  return "lean_error";
}

export async function verifyLeanProofWithRunner(
  candidate: Readonly<LeanProofCandidate>,
  runner: Readonly<LeanRunner>
): Promise<LeanProofVerificationResult> {
  const issues = validateLeanProofCandidate(candidate);
  if (issues.length > 0) {
    const placeholder = issues.some(
      (issue) => issue.code === "placeholder"
    );
    return {
      ok: false,
      verified: false,
      failure: placeholder ? "placeholder_rejected" : "invalid_candidate",
      diagnostics: issues.map((issue) => ({
        severity: "error",
        message: issue.message
      })),
      error: issues.map((issue) => issue.message).join(" ")
    };
  }

  const theoremName = deriveSafeTheoremName(
    candidate.formalizationId,
    candidate.theoremStatementHash
  );
  const source = buildLeanProofVerificationSource(candidate, theoremName);

  try {
    const result = await runner.check({ code: source });
    if (result.status === "statement_typechecked") {
      return {
        ok: true,
        verified: true,
        source,
        theoremName
      };
    }

    return {
      ok: false,
      verified: false,
      failure: classifyFailure(result.diagnostics, result.stderr),
      diagnostics: result.diagnostics,
      error: "Lean rejected the proof candidate.",
      source
    };
  } catch (error) {
    return {
      ok: false,
      verified: false,
      failure: "environment_error",
      diagnostics: [
        {
          severity: "error",
          message: error instanceof Error
            ? error.message
            : "Lean proof verification failed unexpectedly."
        }
      ],
      error: "Lean proof verification failed unexpectedly.",
      source
    };
  }
}
