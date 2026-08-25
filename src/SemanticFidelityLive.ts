// ── Semantic Fidelity Live Experiment Runner ──────────────────────────
// Explicit, resumable, paired live-run orchestration.  The deterministic
// offline runner remains separate.  This module never contains API keys.
// ────────────────────────────────────────────────────────────────────────

import type {
  FidelityConditionId,
  SemanticFidelityCase,
  SemanticFidelityTrialResult
} from "./SemanticFidelityEvaluation";

export type LiveOrderStrategy = "alternating" | "seeded";

export interface LiveExperimentConfig {
  readonly experimentId: string;
  readonly runsPerCondition: number;
  readonly selectedCaseIds?: readonly string[];
  readonly orderStrategy: LiveOrderStrategy;
  readonly seed?: number;
  readonly providerModel?: string;
}

export interface LiveTrialPlan {
  readonly trialId: string;
  readonly caseId: string;
  readonly condition: FidelityConditionId;
  readonly runIndex: number;
  readonly orderIndex: number;
}

export type LiveTrialOutcome =
  | {
      readonly plan: LiveTrialPlan;
      readonly result: SemanticFidelityTrialResult;
    }
  | {
      readonly plan: LiveTrialPlan;
      readonly error: string;
    };

export interface SemanticFidelityLiveAnalyzer {
  analyze(input: {
    readonly caseDef: Readonly<SemanticFidelityCase>;
    readonly condition: FidelityConditionId;
    readonly runIndex: number;
    readonly trialId: string;
  }): Promise<SemanticFidelityTrialResult | { error: string }>;
}

export function selectedCases(
  cases: readonly SemanticFidelityCase[],
  config: Readonly<LiveExperimentConfig>
): readonly SemanticFidelityCase[] {
  if (config.selectedCaseIds === undefined) {
    return cases;
  }
  const selected = new Set(config.selectedCaseIds);
  return cases.filter((caseDef) => selected.has(caseDef.id));
}

function seededOrder(
  caseIndex: number,
  runIndex: number,
  seed: number
): FidelityConditionId {
  const value = (seed + caseIndex * 31 + runIndex * 17) % 2;
  return value === 0 ? "plain_llm" : "personal_brain";
}

export function planLiveTrials(
  cases: readonly SemanticFidelityCase[],
  config: Readonly<LiveExperimentConfig>
): readonly LiveTrialPlan[] {
  const selected = selectedCases(cases, config);
  const plans: LiveTrialPlan[] = [];
  let orderIndex = 0;

  for (let caseIndex = 0; caseIndex < selected.length; caseIndex++) {
    const caseDef = selected[caseIndex]!;
    for (let runIndex = 1; runIndex <= config.runsPerCondition; runIndex++) {
      let first: FidelityConditionId;
      if (config.orderStrategy === "alternating") {
        first = (caseIndex + runIndex) % 2 === 0
          ? "plain_llm"
          : "personal_brain";
      } else {
        first = seededOrder(caseIndex, runIndex, config.seed ?? 12345);
      }
      const second: FidelityConditionId = first === "plain_llm"
        ? "personal_brain"
        : "plain_llm";

      for (const condition of [first, second] as const) {
        plans.push({
          trialId: `${config.experimentId}:${caseDef.id}:${condition}:${runIndex}`,
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

export async function executeLiveTrials(
  cases: readonly SemanticFidelityCase[],
  config: Readonly<LiveExperimentConfig>,
  analyzer: Readonly<SemanticFidelityLiveAnalyzer>,
  existingByTrialId: Readonly<Record<string, SemanticFidelityTrialResult>> = {}
): Promise<{
  readonly plans: readonly LiveTrialPlan[];
  readonly outcomes: readonly LiveTrialOutcome[];
  readonly completed: readonly LiveTrialOutcome[];
  readonly failures: readonly LiveTrialOutcome[];
}> {
  const plans = planLiveTrials(cases, config);
  const outcomes: LiveTrialOutcome[] = [];

  for (const plan of plans) {
    const existing = existingByTrialId[plan.trialId];
    if (existing !== undefined) {
      outcomes.push({ plan, result: existing });
      continue;
    }
    const caseDef = cases.find((item) => item.id === plan.caseId);
    if (caseDef === undefined) {
      outcomes.push({ plan, error: "Case not found." });
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
        error: error instanceof Error ? error.message : "Live trial failed."
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

export function renderDryRunPlan(
  cases: readonly SemanticFidelityCase[],
  config: Readonly<LiveExperimentConfig>
): string {
  const plans = planLiveTrials(cases, config);
  const lines = [
    `Experiment: ${config.experimentId}`,
    `Cases: ${plans.length === 0 ? 0 : new Set(plans.map((p) => p.caseId)).size}`,
    `Runs per condition: ${config.runsPerCondition}`,
    `Conditions: plain_llm, personal_brain`,
    `Planned trial count: ${plans.length}`,
    `Provider/model: ${config.providerModel ?? "configured DeepSeek"}`,
    "",
    "Execution order:"
  ];
  for (const plan of plans) {
    lines.push(`  ${plan.orderIndex + 1}. ${plan.caseId} ${plan.condition} run ${plan.runIndex}`);
  }
  lines.push("", "Dry run: no provider requests were made.");
  return lines.join("\n");
}
