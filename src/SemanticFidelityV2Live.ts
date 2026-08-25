// ── Experiment 03 Live Execution Layer ────────────────────────────────
// Runs the frozen 180-trial design with a resumable, treatment-aware loop.
// It never hides failed trials and never keys repeated runs by case ID alone.
// ────────────────────────────────────────────────────────────────────────

import {
  planExperiment03Trials,
  type ExperimentConditionId,
  type FailureCategory,
  type SemanticFidelityCaseV2,
  type SemanticFidelityTrialResultV2,
  type TrialPlanV2
} from "./SemanticFidelityV2";

export interface Experiment03LiveConfig {
  readonly experimentId: string;
  readonly seed: number;
  readonly runsPerCondition: number;
}

export interface Experiment03LiveAnalyzer {
  analyze(input: {
    readonly caseDef: Readonly<SemanticFidelityCaseV2>;
    readonly condition: ExperimentConditionId;
    readonly runIndex: number;
    readonly trialId: string;
  }): Promise<SemanticFidelityTrialResultV2 | { error: string }>;
}

export interface Experiment03TrialOutcome {
  readonly plan: TrialPlanV2;
  readonly result?: SemanticFidelityTrialResultV2;
  readonly error?: string;
  readonly failureCategory?: FailureCategory;
}

export async function executeExperiment03Trials(
  cases: readonly SemanticFidelityCaseV2[],
  config: Readonly<Experiment03LiveConfig>,
  analyzer: Readonly<Experiment03LiveAnalyzer>,
  existingByTrialId: Readonly<Record<string, SemanticFidelityTrialResultV2>> = {}
): Promise<{
  readonly plans: readonly TrialPlanV2[];
  readonly outcomes: readonly Experiment03TrialOutcome[];
  readonly completed: readonly Experiment03TrialOutcome[];
  readonly failures: readonly Experiment03TrialOutcome[];
}> {
  const plans = planExperiment03Trials(
    cases,
    config.experimentId,
    config.runsPerCondition,
    config.seed
  );
  const outcomes: Experiment03TrialOutcome[] = [];

  for (const plan of plans) {
    const existing = existingByTrialId[plan.trialId];
    if (existing !== undefined) {
      outcomes.push({ plan, result: existing });
      continue;
    }
    const caseDef = cases.find((item) => item.id === plan.caseId);
    if (caseDef === undefined) {
      outcomes.push({
        plan,
        error: "Case not found.",
        failureCategory: "local_exception"
      });
      continue;
    }

    try {
      const analyzed = await analyzer.analyze({
        caseDef,
        condition: plan.condition,
        runIndex: plan.runIndex,
        trialId: plan.trialId
      });
      if ("error" in analyzed) {
        outcomes.push({ plan, error: analyzed.error });
      } else {
        outcomes.push({ plan, result: analyzed });
      }
    } catch (error) {
      outcomes.push({
        plan,
        error: error instanceof Error ? error.message : "Live trial failed.",
        failureCategory: "local_exception"
      });
    }
  }

  return {
    plans,
    outcomes,
    completed: outcomes.filter((outcome) => "result" in outcome),
    failures: outcomes.filter((outcome) => "error" in outcome)
  };
}

