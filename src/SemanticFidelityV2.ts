// ── Semantic Fidelity v2 (Experiment 03 instrument) ───────────────────
// Post-hoc corrected measurement model.  It keeps grounding and overreach as
// separate axes, preserves every repeated trial, and verifies treatment
// integrity.  It is NOT the v1 historical scorer.
// ────────────────────────────────────────────────────────────────────────

export const SEMANTIC_FIDELITY_V2_SCHEMA_VERSION = 2 as const;

export type ExperimentConditionId =
  | "plain_llm"
  | "irrelevant_context"
  | "brain_identity_only"
  | "brain_definition"
  | "brain_definition_plus_relations";

export type FailureCategory =
  | "provider_error"
  | "rate_limit"
  | "timeout"
  | "network_error"
  | "malformed_json"
  | "schema_validation_failure"
  | "treatment_invalid"
  | "local_exception";

export interface ExpectedBindingV2 {
  readonly expectedConceptId: string;
  readonly acceptedSurfaceForms: readonly string[];
  readonly requirement: "required" | "optional";
  readonly expectedAmbiguitySet?: readonly string[];
}

export interface TreatmentManifest {
  readonly condition: ExperimentConditionId;
  readonly suppliedContext:
    | "none"
    | "irrelevant"
    | "identity_only"
    | "definition"
    | "definition_plus_relations";
  readonly suppliedConceptIds?: readonly string[];
}

export interface SemanticFidelityCaseV2 {
  readonly id: string;
  readonly schemaVersion: typeof SEMANTIC_FIDELITY_V2_SCHEMA_VERSION;
  readonly sourceText: string;
  readonly tags: readonly string[];
  readonly rationale: string;
  readonly treatmentManifest: TreatmentManifest;
  readonly expectedBindings?: readonly ExpectedBindingV2[];
  readonly expectedQuantifier?: "universal" | "existential" | "uniqueness";
  readonly expectedRelations?: readonly string[];
  readonly forbiddenRelations?: readonly string[];
  readonly expectedSpeechAct?: string;
  readonly allowedOverreachCommitments?: readonly string[];
  readonly expectedMissingConditions?: readonly string[];
  readonly expectedAssumedConditions?: readonly string[];
  readonly expectedAmbiguity?: "preserve" | "resolve" | "none";
}

export interface TrialConceptBindingV2 {
  readonly surfaceForm: string;
  readonly conceptId?: string;
  readonly status: "resolved" | "ambiguous" | "unresolved" | "proposed_new";
}

export interface SemanticFidelityTrialResultV2 {
  readonly id: string;
  readonly schemaVersion: typeof SEMANTIC_FIDELITY_V2_SCHEMA_VERSION;
  readonly caseId: string;
  readonly condition: ExperimentConditionId;
  readonly runId: string;
  readonly runIndex: number;
  readonly executionMode: "mocked" | "live";
  readonly conceptBindings: readonly TrialConceptBindingV2[];
  readonly quantifier?: "universal" | "existential" | "uniqueness";
  readonly relations: readonly string[];
  readonly speechAct?: string;
  readonly semanticCommitments: readonly string[];
  readonly sourceStatedConditions: readonly string[];
  readonly treatmentContextConditions: readonly string[];
  readonly missingConditions: readonly string[];
  readonly assumedConditions: readonly string[];
  readonly ambiguities: readonly string[];
  readonly validationFailures: readonly string[];
  readonly failureCategory?: FailureCategory;
  readonly timestamp: string;
}

export interface TrialPlanV2 {
  readonly trialId: string;
  readonly caseId: string;
  readonly condition: ExperimentConditionId;
  readonly runIndex: number;
  readonly orderIndex: number;
}

export interface VerifiedBindingScore {
  readonly expected: number;
  readonly verified: number;
  readonly missingRequired: number;
  readonly wrong: number;
  readonly accuracy: number | undefined;
}

export function planExperiment03Trials(
  cases: readonly SemanticFidelityCaseV2[],
  experimentId: string,
  runsPerCondition: number,
  seed: number
): readonly TrialPlanV2[] {
  const conditions: ExperimentConditionId[] = [
    "plain_llm",
    "irrelevant_context",
    "brain_identity_only",
    "brain_definition",
    "brain_definition_plus_relations"
  ];
  const plans: TrialPlanV2[] = [];
  let orderIndex = 0;
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    const caseDef = cases[caseIndex]!;
    for (let runIndex = 1; runIndex <= runsPerCondition; runIndex++) {
      const shifted = conditions.map((condition, i) =>
        conditions[(i + caseIndex + runIndex + seed) % conditions.length]!
      );
      for (const condition of shifted) {
        plans.push({
          trialId: `${experimentId}:${caseDef.id}:${condition}:${runIndex}`,
          caseId: caseDef.id,
          condition,
          runIndex,
          orderIndex: orderIndex++
        });
      }
    }
  }
  return plans;
}

function stripRevision(id: string | undefined): string | undefined {
  return id === undefined ? undefined : id.replace(/@\d+$/, "");
}

export function scoreVerifiedGrounding(
  caseDef: Readonly<SemanticFidelityCaseV2>,
  result: Readonly<SemanticFidelityTrialResultV2>
): VerifiedBindingScore {
  const expected = caseDef.expectedBindings ?? [];
  if (expected.length === 0) {
    return { expected: 0, verified: 0, missingRequired: 0, wrong: 0, accuracy: undefined };
  }
  let verified = 0;
  let missingRequired = 0;
  let wrong = 0;
  for (const exp of expected) {
    const found = result.conceptBindings.find((binding) =>
      exp.acceptedSurfaceForms.includes(binding.surfaceForm)
    );
    if (!found || found.status !== "resolved") {
      if (exp.requirement === "required") {
        missingRequired += 1;
      }
      continue;
    }
    if (stripRevision(found.conceptId) === exp.expectedConceptId) {
      verified += 1;
    } else {
      wrong += 1;
    }
  }
  const required = expected.filter((e) => e.requirement === "required").length;
  return {
    expected: expected.length,
    verified,
    missingRequired,
    wrong,
    accuracy: required === 0 ? undefined : verified / required
  };
}

export function scoreOverreach(
  caseDef: Readonly<SemanticFidelityCaseV2>,
  result: Readonly<SemanticFidelityTrialResultV2>
): number {
  const allowed = new Set(caseDef.allowedOverreachCommitments ?? []);
  return result.semanticCommitments.filter((commitment) => !allowed.has(commitment)).length;
}

export function validateTreatmentIntegrity(
  caseDef: Readonly<SemanticFidelityCaseV2>,
  result: Readonly<SemanticFidelityTrialResultV2>
): readonly string[] {
  const issues: string[] = [];
  const manifest = caseDef.treatmentManifest;
  if (manifest.condition !== result.condition) {
    issues.push("treatment_invalid: result condition does not match manifest.");
  }
  if (manifest.suppliedContext === "none" &&
      result.treatmentContextConditions.length > 0) {
    issues.push("treatment_invalid: plain condition received semantic context.");
  }
  if (manifest.suppliedContext !== "none" &&
      result.treatmentContextConditions.length === 0) {
    issues.push("treatment_invalid: planned Brain treatment received no context.");
  }
  return issues;
}

export function detectMissingAssumedContradiction(
  result: Readonly<SemanticFidelityTrialResultV2>
): boolean {
  const assumed = new Set(result.assumedConditions);
  const missing = new Set(result.missingConditions);
  return [...assumed].some((value) => missing.has(value));
}

export function renderExperiment03DryRun(
  cases: readonly SemanticFidelityCaseV2[],
  experimentId: string,
  runsPerCondition: number,
  seed: number
): string {
  const plans = planExperiment03Trials(cases, experimentId, runsPerCondition, seed);
  const lines = [
    `Experiment 03 dry-run`,
    `Cases: ${cases.length}`,
    `Conditions: plain_llm, irrelevant_context, brain_identity_only, brain_definition, brain_definition_plus_relations`,
    `Repetitions: ${runsPerCondition}`,
    `Planned trials: ${plans.length}`,
    `Seed: ${seed}`,
    "",
    "Dry run: no provider requests were made."
  ];
  return lines.join("\n");
}
