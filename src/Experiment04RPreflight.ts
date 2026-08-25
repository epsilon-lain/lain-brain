import {
  EXPERIMENT_04R_COMMON_TASK_PROMPT,
  EXPERIMENT_04R_CONDITIONS,
  EXPERIMENT_04R_FIXTURES,
  EXPERIMENT_04R_RESPONSE_SCHEMA,
  planExperiment04RTrials,
  type Experiment04RFixture
} from "./Experiment04RDefinition";
import {
  buildFrozenExperiment04RProviderMessages,
  renderExperiment04RTreatmentPayload
} from "./Experiment04RInstrument";
import {
  findEvaluatorMetadataLeaks,
  findForbiddenFragmentsInText,
  validateExperiment04RAuditCoverage
} from "./Experiment04RAudit";

const PLACEHOLDER_PATTERNS = [/synthetic source\./i, /<fixture_id>/i, /\bTODO\b/i, /\bTBD\b/i];
const INVISIBLE_TERMS = [
  ...EXPERIMENT_04R_CONDITIONS,
  "private_meaning",
  "overloaded_public_term",
  "genuine_ambiguity",
  "missing_condition",
  "no_brain_advantage",
  "irrelevant_context_sensitive_control",
  "definition_vs_theorem",
  "proof_sketch",
  "stale_revision",
  "treatment metadata",
  "experimental group",
  "control group"
];

function visible(messages: readonly { readonly content: string }[]): string {
  return messages.map((message) => message.content).join("\n");
}
function hasAny(text: string, terms: readonly string[]): string | undefined {
  return terms.find((term) => text.includes(term));
}
function validateFixture(fixture: Readonly<Experiment04RFixture>): readonly string[] {
  const errors: string[] = [];
  if (fixture.sourceText.trim() === "" || fixture.sourceText.trim() === fixture.fixtureId) errors.push(`${fixture.fixtureId}: invalid source text.`);
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(fixture.sourceText))) errors.push(`${fixture.fixtureId}: placeholder source.`);
  if (fixture.expectedPersonalConcepts.length === 0) errors.push(`${fixture.fixtureId}: no semantic objects.`);
  const conceptIds = new Set(fixture.expectedPersonalConcepts.map((concept) => concept.stableConceptId));
  for (const binding of fixture.expectedBindings) if (!conceptIds.has(binding.expectedConceptId)) errors.push(`${fixture.fixtureId}: binding target absent from semantic objects.`);
  if (fixture.treatmentSufficiency.expectedAbilityToGround === "required" && fixture.expectedBindings.length === 0) errors.push(`${fixture.fixtureId}: required grounding has no expected binding.`);
  if (fixture.treatmentSufficiency.ambiguityMustRemain && !fixture.expectedBindings.some((binding) => (binding.expectedAmbiguitySet?.length ?? 0) === 2)) errors.push(`${fixture.fixtureId}: ambiguity lacks two candidates.`);
  const targetIds = fixture.expectedPersonalConcepts.map((concept) => concept.stableConceptId);
  const irrelevantPayload = renderExperiment04RTreatmentPayload(fixture, "irrelevant_context") ?? "";
  if (irrelevantPayload === "" || hasAny(irrelevantPayload, targetIds) !== undefined) errors.push(`${fixture.fixtureId}: invalid irrelevant payload.`);
  for (const condition of EXPERIMENT_04R_CONDITIONS) {
    const payload = renderExperiment04RTreatmentPayload(fixture, condition);
    if (condition === "plain_llm" && payload !== undefined) errors.push(`${fixture.fixtureId}: plain payload is non-empty.`);
    if (condition !== "plain_llm" && payload?.trim() === "") errors.push(`${fixture.fixtureId}: required payload empty for ${condition}.`);
    if (payload !== undefined && PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(payload))) errors.push(`${fixture.fixtureId}: placeholder payload for ${condition}.`);
    if (condition === "brain_identity_only" && (payload?.includes("Definition:") || payload?.includes("Relation:"))) errors.push(`${fixture.fixtureId}: identity payload contains semantic detail.`);
    if (condition === "brain_definition" && (payload?.includes("Definition:") !== true || payload.includes("Relation:"))) errors.push(`${fixture.fixtureId}: definition payload composition wrong.`);
    if (condition === "brain_definition_plus_relations" && (payload?.includes("Definition:") !== true || payload.includes("Relation:") !== true)) errors.push(`${fixture.fixtureId}: relation payload composition wrong.`);
    const messages = buildFrozenExperiment04RProviderMessages(fixture, condition, EXPERIMENT_04R_COMMON_TASK_PROMPT);
    const prompt = visible(messages);
    const leak = hasAny(prompt, [...INVISIBLE_TERMS, fixture.fixtureId]);
    if (leak !== undefined) errors.push(`${fixture.fixtureId}: provider-visible leak ${leak}.`);
    if (messages[0]?.content !== EXPERIMENT_04R_COMMON_TASK_PROMPT || !prompt.includes(fixture.sourceText)) errors.push(`${fixture.fixtureId}: common prompt/source mismatch.`);
    const forbiddenFragments = findForbiddenFragmentsInText(prompt);
    if (forbiddenFragments.length > 0) errors.push(`${fixture.fixtureId}: provider-visible answer-bearing fragment ${forbiddenFragments.join(", ")}.`);
    const metadataLeaks = findEvaluatorMetadataLeaks(fixture, messages);
    if (metadataLeaks.length > 0) errors.push(`${fixture.fixtureId}: evaluator metadata leak ${metadataLeaks.join(", ")}.`);
  }
  return errors;
}

export function validateExperiment04RPreflight(): readonly string[] {
  const errors = EXPERIMENT_04R_FIXTURES.flatMap(validateFixture);
  const plans = planExperiment04RTrials();
  if (new Set(plans.map((plan) => plan.trialId)).size !== plans.length) errors.push("duplicate trial ID.");
  if (plans.length !== EXPERIMENT_04R_FIXTURES.length * EXPERIMENT_04R_CONDITIONS.length * 3) errors.push("incorrect trial count.");
  for (const plan of plans) {
    const fixture = EXPERIMENT_04R_FIXTURES.find((item) => item.fixtureId === plan.fixtureId);
    if (fixture === undefined) errors.push(`missing fixture for ${plan.trialId}.`);
    else buildFrozenExperiment04RProviderMessages(fixture, plan.condition, EXPERIMENT_04R_COMMON_TASK_PROMPT);
  }
  if (JSON.stringify(EXPERIMENT_04R_RESPONSE_SCHEMA).length === 0) errors.push("empty response schema.");
  errors.push(...validateExperiment04RAuditCoverage(EXPERIMENT_04R_FIXTURES.map((fixture) => fixture.fixtureId)));
  return errors;
}
