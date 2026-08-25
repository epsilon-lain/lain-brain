// ── Semantic Fidelity Evaluation Harness ──────────────────────────────
// Reproducible local instrument for comparing:
//   Condition A: plain LLM formalization
//   Condition B: Personal-Brain-aware formalization
//
// Core metrics are deterministic and derived only from human-authored
// fixture ground truth.  No LLM-as-judge.  Lean success is never treated as
// evidence of semantic fidelity.
// ────────────────────────────────────────────────────────────────────────

export const SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION = 1 as const;

export type FidelityConditionId = "plain_llm" | "personal_brain";
export type FidelityExecutionMode = "mocked" | "live";

export type QuantifierKind =
  | "universal"
  | "existential"
  | "uniqueness";

export type RelationKind =
  | "implication"
  | "equivalence"
  | "negation"
  | "conjunction"
  | "analogy"
  | "subset"
  | "equality"
  | "membership"
  | "part_of"
  | "identity";

export interface ExpectedConceptBinding {
  readonly surfacePhrase: string;
  readonly conceptId: string;
}

export interface SemanticFidelityCase {
  readonly id: string;
  readonly schemaVersion: typeof SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION;
  readonly sourceText: string;
  readonly context?: string;
  readonly tags: readonly string[];
  readonly rationale: string;
  readonly expectedBindings?: readonly ExpectedConceptBinding[];
  readonly expectedQuantifier?: QuantifierKind;
  readonly expectedRelations?: readonly RelationKind[];
  readonly forbiddenRelations?: readonly RelationKind[];
  readonly allowedAddedAssumptions?: readonly string[];
  readonly expectedMissingConditions?: readonly string[];
  readonly expectedAmbiguity?: "preserve" | "resolve" | "none";
  readonly expectedSpeechAct?: string;
}

export interface TrialConceptBinding {
  readonly surfacePhrase: string;
  readonly conceptId?: string;
  readonly status:
    | "resolved"
    | "ambiguous"
    | "unresolved"
    | "proposed_new";
}

export interface SemanticFidelityTrialResult {
  readonly id: string;
  readonly schemaVersion: typeof SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION;
  readonly caseId: string;
  readonly condition: FidelityConditionId;
  readonly runId: string;
  readonly runIndex: number;
  readonly executionMode: FidelityExecutionMode;
  readonly conceptBindings: readonly TrialConceptBinding[];
  readonly quantifier?: QuantifierKind;
  readonly relations: readonly RelationKind[];
  readonly explicitAssumptions: readonly string[];
  readonly addedImplicitAssumptions: readonly string[];
  readonly missingConditions: readonly string[];
  readonly ambiguities: readonly string[];
  readonly speechAct?: string;
  readonly canonicalProposition?: string;
  readonly validationFailures: readonly string[];
  readonly leanStatementTypechecked?: boolean;
  readonly providerModel?: string;
  readonly timestamp: string;
}

export type ScoringState =
  | "not_applicable"
  | "indeterminate"
  | "invalid_output";

export interface ConceptBindingScore {
  readonly state: ScoringState | "scored";
  readonly correctCount: number;
  readonly expectedCount: number;
  readonly wrongCount: number;
  readonly unresolvedCount: number;
  readonly unjustifiedResolutionCount: number;
  readonly accuracy: number | undefined;
}

export interface QuantifierScore {
  readonly state: "preserved" | "drifted" | "indeterminate" | "not_applicable";
}

export interface RelationScore {
  readonly preserved: readonly RelationKind[];
  readonly violated: readonly RelationKind[];
  readonly missing: readonly RelationKind[];
}

export interface AssumptionScore {
  readonly supportedAddedCount: number;
  readonly unsupportedAddedCount: number;
  readonly missingConditionCount: number;
  readonly identifiedMissingConditionCount: number;
}

export interface AmbiguityScore {
  readonly state:
    | "correctly_preserved"
    | "incorrectly_collapsed"
    | "unnecessary_introduced"
    | "correct_unique_resolution"
    | "not_applicable";
}

export interface SemanticFidelityMetrics {
  readonly conceptBinding: ConceptBindingScore;
  readonly quantifier: QuantifierScore;
  readonly relations: RelationScore;
  readonly assumptions: AssumptionScore;
  readonly ambiguity: AmbiguityScore;
  readonly correctionUnits: number;
  readonly semanticViolationCount: number;
  readonly invalidOutput: boolean;
}

export type ComparisonDirection =
  | "improved"
  | "worsened"
  | "unchanged"
  | "not_applicable";

export interface PairedComparison {
  readonly caseId: string;
  readonly conceptBinding: ComparisonDirection;
  readonly quantifierPreservation: ComparisonDirection;
  readonly relationPreservation: ComparisonDirection;
  readonly unsupportedAssumptions: "reduced" | "increased" | "unchanged";
  readonly semanticViolations: "reduced" | "increased" | "unchanged";
  readonly ambiguityHandling: ComparisonDirection;
  readonly correctionBurden: "reduced" | "increased" | "unchanged";
  readonly leanTypecheck: ComparisonDirection | "unavailable";
}

export interface AggregateConditionMetrics {
  readonly validResultCount: number;
  readonly invalidOutputCount: number;
  readonly meanCorrectionBurden: number;
  readonly medianCorrectionBurden: number;
  readonly conceptBindingAccuracySum: number;
  readonly conceptBindingScoredCount: number;
  readonly wrongBindingCount: number;
  readonly unresolvedBindingCount: number;
  readonly quantifierDriftCount: number;
  readonly relationViolationCount: number;
  readonly unsupportedAssumptionCount: number;
  readonly semanticViolationCount: number;
  readonly ambiguityErrorCount: number;
  readonly leanTypecheckSuccessCount: number;
  readonly leanTypecheckAttemptCount: number;
}

export interface AggregateReport {
  readonly plain: AggregateConditionMetrics;
  readonly personalBrain: AggregateConditionMetrics;
  readonly paired: readonly PairedComparison[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// ── Scoring ────────────────────────────────────────────────────────────

export function scoreConceptBindings(
  caseDef: Readonly<SemanticFidelityCase>,
  result: Readonly<SemanticFidelityTrialResult>
): ConceptBindingScore {
  if (result.validationFailures.length > 0) {
    return {
      state: "invalid_output",
      correctCount: 0,
      expectedCount: caseDef.expectedBindings?.length ?? 0,
      wrongCount: 0,
      unresolvedCount: 0,
      unjustifiedResolutionCount: 0,
      accuracy: undefined
    };
  }
  const expected = caseDef.expectedBindings ?? [];
  if (expected.length === 0) {
    return {
      state: "not_applicable",
      correctCount: 0,
      expectedCount: 0,
      wrongCount: 0,
      unresolvedCount: 0,
      unjustifiedResolutionCount: 0,
      accuracy: undefined
    };
  }

  let correctCount = 0;
  let wrongCount = 0;
  let unresolvedCount = 0;
  for (const expectedBinding of expected) {
    const trialBinding = result.conceptBindings.find(
      (binding) => binding.surfacePhrase === expectedBinding.surfacePhrase
    );
    if (trialBinding === undefined || trialBinding.status !== "resolved") {
      unresolvedCount += 1;
    } else if (trialBinding.conceptId === expectedBinding.conceptId) {
      correctCount += 1;
    } else {
      wrongCount += 1;
    }
  }

  return {
    state: "scored",
    correctCount,
    expectedCount: expected.length,
    wrongCount,
    unresolvedCount,
    unjustifiedResolutionCount: wrongCount,
    accuracy: expected.length === 0 ? undefined : correctCount / expected.length
  };
}

export function scoreQuantifier(
  caseDef: Readonly<SemanticFidelityCase>,
  result: Readonly<SemanticFidelityTrialResult>
): QuantifierScore {
  if (caseDef.expectedQuantifier === undefined) {
    return { state: "not_applicable" };
  }
  if (result.quantifier === undefined) {
    return { state: "indeterminate" };
  }
  return result.quantifier === caseDef.expectedQuantifier
    ? { state: "preserved" }
    : { state: "drifted" };
}

export function scoreRelations(
  caseDef: Readonly<SemanticFidelityCase>,
  result: Readonly<SemanticFidelityTrialResult>
): RelationScore {
  const expected = caseDef.expectedRelations ?? [];
  const forbidden = caseDef.forbiddenRelations ?? [];
  const resultSet = new Set(result.relations);
  return {
    preserved: expected.filter((relation) => resultSet.has(relation)),
    violated: forbidden.filter((relation) => resultSet.has(relation)),
    missing: expected.filter((relation) => !resultSet.has(relation))
  };
}

export function scoreAssumptions(
  caseDef: Readonly<SemanticFidelityCase>,
  result: Readonly<SemanticFidelityTrialResult>
): AssumptionScore {
  const allowed = new Set(caseDef.allowedAddedAssumptions ?? []);
  const supported = result.addedImplicitAssumptions.filter((assumption) =>
    allowed.has(assumption)
  );
  const unsupported = result.addedImplicitAssumptions.filter(
    (assumption) => !allowed.has(assumption)
  );
  const expectedMissing = caseDef.expectedMissingConditions ?? [];
  const identified = result.missingConditions.filter((condition) =>
    expectedMissing.includes(condition)
  );
  return {
    supportedAddedCount: supported.length,
    unsupportedAddedCount: unsupported.length,
    missingConditionCount: expectedMissing.length,
    identifiedMissingConditionCount: identified.length
  };
}

export function scoreAmbiguity(
  caseDef: Readonly<SemanticFidelityCase>,
  result: Readonly<SemanticFidelityTrialResult>
): AmbiguityScore {
  if (caseDef.expectedAmbiguity === undefined) {
    return { state: "not_applicable" };
  }
  const hasAmbiguity =
    result.ambiguities.length > 0 ||
    result.conceptBindings.some(
      (binding) =>
        binding.status === "ambiguous" || binding.status === "unresolved"
    );
  if (caseDef.expectedAmbiguity === "preserve") {
    return {
      state: hasAmbiguity ? "correctly_preserved" : "incorrectly_collapsed"
    };
  }
  if (caseDef.expectedAmbiguity === "resolve") {
    return {
      state: hasAmbiguity ? "unnecessary_introduced" : "correct_unique_resolution"
    };
  }
  return {
    state: hasAmbiguity ? "unnecessary_introduced" : "correct_unique_resolution"
  };
}

export function computeSemanticFidelityMetrics(
  caseDef: Readonly<SemanticFidelityCase>,
  result: Readonly<SemanticFidelityTrialResult>
): SemanticFidelityMetrics {
  const conceptBinding = scoreConceptBindings(caseDef, result);
  const quantifier = scoreQuantifier(caseDef, result);
  const relations = scoreRelations(caseDef, result);
  const assumptions = scoreAssumptions(caseDef, result);
  const ambiguity = scoreAmbiguity(caseDef, result);

  let correctionUnits = 0;
  if (conceptBinding.state === "scored") {
    correctionUnits += conceptBinding.wrongCount + conceptBinding.unresolvedCount;
  }
  if (quantifier.state === "drifted") {
    correctionUnits += 1;
  }
  correctionUnits += relations.violated.length;
  correctionUnits += assumptions.unsupportedAddedCount;
  correctionUnits += Math.max(
    0,
    assumptions.missingConditionCount -
      assumptions.identifiedMissingConditionCount
  );
  if (caseDef.expectedSpeechAct !== undefined &&
      result.speechAct !== caseDef.expectedSpeechAct) {
    correctionUnits += 1;
  }
  if (ambiguity.state === "incorrectly_collapsed" ||
      ambiguity.state === "unnecessary_introduced") {
    correctionUnits += 1;
  }

  const semanticViolationCount =
    relations.violated.length +
    assumptions.unsupportedAddedCount +
    (quantifier.state === "drifted" ? 1 : 0) +
    (caseDef.expectedSpeechAct !== undefined &&
      result.speechAct !== caseDef.expectedSpeechAct
      ? 1
      : 0) +
    (ambiguity.state === "incorrectly_collapsed" ||
      ambiguity.state === "unnecessary_introduced"
      ? 1
      : 0);

  return {
    conceptBinding,
    quantifier,
    relations,
    assumptions,
    ambiguity,
    correctionUnits,
    semanticViolationCount,
    invalidOutput: result.validationFailures.length > 0
  };
}

// ── Paired Comparison ──────────────────────────────────────────────────

export function compareConditions(
  caseDef: Readonly<SemanticFidelityCase>,
  plainResult: Readonly<SemanticFidelityTrialResult>,
  brainResult: Readonly<SemanticFidelityTrialResult>
): PairedComparison {
  const plain = computeSemanticFidelityMetrics(caseDef, plainResult);
  const brain = computeSemanticFidelityMetrics(caseDef, brainResult);

  const direction = (
    better: boolean,
    worse: boolean,
    applicable: boolean
  ): ComparisonDirection =>
    !applicable ? "not_applicable" : better === worse ? "unchanged" : better ? "improved" : "worsened";

  const plainConceptAcc = plain.conceptBinding.accuracy ?? 0;
  const brainConceptAcc = brain.conceptBinding.accuracy ?? 0;

  return {
    caseId: caseDef.id,
    conceptBinding: direction(
      brainConceptAcc > plainConceptAcc,
      brainConceptAcc < plainConceptAcc,
      plain.conceptBinding.state !== "not_applicable" ||
        brain.conceptBinding.state !== "not_applicable"
    ),
    quantifierPreservation: direction(
      brain.quantifier.state === "preserved" && plain.quantifier.state !== "preserved",
      brain.quantifier.state !== "preserved" && plain.quantifier.state === "preserved",
      plain.quantifier.state !== "not_applicable" ||
        brain.quantifier.state !== "not_applicable"
    ),
    relationPreservation: direction(
      brain.relations.violated.length < plain.relations.violated.length,
      brain.relations.violated.length > plain.relations.violated.length,
      (plain.relations.violated.length + plain.relations.preserved.length) > 0 ||
        (brain.relations.violated.length + brain.relations.preserved.length) > 0
    ),
    unsupportedAssumptions:
      brain.assumptions.unsupportedAddedCount < plain.assumptions.unsupportedAddedCount
        ? "reduced"
        : brain.assumptions.unsupportedAddedCount > plain.assumptions.unsupportedAddedCount
          ? "increased"
          : "unchanged",
    semanticViolations:
      brain.semanticViolationCount < plain.semanticViolationCount
        ? "reduced"
        : brain.semanticViolationCount > plain.semanticViolationCount
          ? "increased"
          : "unchanged",
    ambiguityHandling: direction(
      (brain.ambiguity.state === "correctly_preserved" ||
        brain.ambiguity.state === "correct_unique_resolution") &&
        (plain.ambiguity.state !== "correctly_preserved" &&
          plain.ambiguity.state !== "correct_unique_resolution"),
      (plain.ambiguity.state === "correctly_preserved" ||
        plain.ambiguity.state === "correct_unique_resolution") &&
        (brain.ambiguity.state !== "correctly_preserved" &&
          brain.ambiguity.state !== "correct_unique_resolution"),
      plain.ambiguity.state !== "not_applicable" ||
        brain.ambiguity.state !== "not_applicable"
    ),
    correctionBurden:
      brain.correctionUnits < plain.correctionUnits
        ? "reduced"
        : brain.correctionUnits > plain.correctionUnits
          ? "increased"
          : "unchanged",
    leanTypecheck: (
      plainResult.leanStatementTypechecked === undefined &&
      brainResult.leanStatementTypechecked === undefined
    )
      ? "unavailable"
      : direction(
          brainResult.leanStatementTypechecked === true &&
            plainResult.leanStatementTypechecked !== true,
          plainResult.leanStatementTypechecked === true &&
            brainResult.leanStatementTypechecked !== true,
          true
        )
  };
}

// ── Aggregation ────────────────────────────────────────────────────────

function aggregateCondition(
  caseDefs: readonly SemanticFidelityCase[],
  results: Readonly<Record<string, SemanticFidelityTrialResult>>
): AggregateConditionMetrics {
  const metrics = caseDefs.map((caseDef) => {
    const result = results[caseDef.id];
    return result === undefined
      ? undefined
      : computeSemanticFidelityMetrics(caseDef, result);
  }).filter((metric): metric is SemanticFidelityMetrics => metric !== undefined);

  const valid = metrics.filter((metric) => !metric.invalidOutput);
  const corrections = valid.map((metric) => metric.correctionUnits);
  const bindingAccuracies = valid
    .filter((metric) => metric.conceptBinding.accuracy !== undefined)
    .map((metric) => metric.conceptBinding.accuracy!);
  return {
    validResultCount: valid.length,
    invalidOutputCount: metrics.filter((metric) => metric.invalidOutput).length,
    meanCorrectionBurden: corrections.length === 0
      ? 0
      : corrections.reduce((a, b) => a + b, 0) / corrections.length,
    medianCorrectionBurden: median(corrections),
    conceptBindingAccuracySum: bindingAccuracies.reduce((a, b) => a + b, 0),
    conceptBindingScoredCount: bindingAccuracies.length,
    wrongBindingCount: valid.reduce((sum, metric) =>
      sum + (metric.conceptBinding.state === "scored"
        ? metric.conceptBinding.wrongCount
        : 0), 0),
    unresolvedBindingCount: valid.reduce((sum, metric) =>
      sum + (metric.conceptBinding.state === "scored"
        ? metric.conceptBinding.unresolvedCount
        : 0), 0),
    quantifierDriftCount: valid.filter(
      (metric) => metric.quantifier.state === "drifted"
    ).length,
    relationViolationCount: valid.reduce(
      (sum, metric) => sum + metric.relations.violated.length,
      0
    ),
    unsupportedAssumptionCount: valid.reduce(
      (sum, metric) => sum + metric.assumptions.unsupportedAddedCount,
      0
    ),
    semanticViolationCount: valid.reduce(
      (sum, metric) => sum + metric.semanticViolationCount,
      0
    ),
    ambiguityErrorCount: valid.filter(
      (metric) =>
        metric.ambiguity.state === "incorrectly_collapsed" ||
        metric.ambiguity.state === "unnecessary_introduced"
    ).length,
    leanTypecheckSuccessCount: 0,
    leanTypecheckAttemptCount: 0
  };
}

export function aggregateSemanticFidelity(
  caseDefs: readonly SemanticFidelityCase[],
  plainResults: Readonly<Record<string, SemanticFidelityTrialResult>>,
  brainResults: Readonly<Record<string, SemanticFidelityTrialResult>>
): AggregateReport {
  const paired = caseDefs.flatMap((caseDef) => {
    const plain = plainResults[caseDef.id];
    const brain = brainResults[caseDef.id];
    return plain !== undefined && brain !== undefined
      ? [compareConditions(caseDef, plain, brain)]
      : [];
  });
  return {
    plain: aggregateCondition(caseDefs, plainResults),
    personalBrain: aggregateCondition(caseDefs, brainResults),
    paired
  };
}

// ── Markdown Report ────────────────────────────────────────────────────

export function renderSemanticFidelityMarkdown(
  title: string,
  report: Readonly<AggregateReport>,
  executionMode: FidelityExecutionMode,
  caseCount: number
): string {
  const plain = report.plain;
  const brain = report.personalBrain;
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  if (executionMode === "mocked") {
    lines.push("> DETERMINISTIC HARNESS / MOCKED EXAMPLE");
    lines.push("");
  }
  lines.push(`Execution mode: ${executionMode}`);
  lines.push(`Fixture cases: ${caseCount}`);
  lines.push(`Valid plain results: ${plain.validResultCount}`);
  lines.push(`Valid Brain results: ${brain.validResultCount}`);
  lines.push("");
  lines.push("## Component metrics");
  lines.push("");
  lines.push("| Metric | Plain LLM | Personal Brain |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| Quantifier drift | ${plain.quantifierDriftCount} | ${brain.quantifierDriftCount} |`);
  lines.push(`| Relation violations | ${plain.relationViolationCount} | ${brain.relationViolationCount} |`);
  lines.push(`| Unsupported assumptions | ${plain.unsupportedAssumptionCount} | ${brain.unsupportedAssumptionCount} |`);
  lines.push(`| Semantic violations | ${plain.semanticViolationCount} | ${brain.semanticViolationCount} |`);
  lines.push(`| Ambiguity errors | ${plain.ambiguityErrorCount} | ${brain.ambiguityErrorCount} |`);
  lines.push(`| Mean correction burden | ${plain.meanCorrectionBurden.toFixed(2)} | ${brain.meanCorrectionBurden.toFixed(2)} |`);
  lines.push(`| Median correction burden | ${plain.medianCorrectionBurden.toFixed(2)} | ${brain.medianCorrectionBurden.toFixed(2)} |`);
  lines.push("");
  lines.push("## Paired deltas");
  lines.push("");
  for (const pair of report.paired) {
    lines.push(`- ${pair.caseId}: correction ${pair.correctionBurden}, violations ${pair.semanticViolations}, bindings ${pair.conceptBinding}`);
  }
  lines.push("");
  lines.push("This is instrument validation data, not empirical proof about Personal Brain.");
  return lines.join("\n");
}
