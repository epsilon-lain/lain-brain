import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/Experiment04RDefinition';",
      "export { buildFrozenExperiment04RProviderMessages, renderExperiment04RTreatmentPayload } from './src/Experiment04RInstrument';",
      "export { validateExperiment04RPreflight } from './src/Experiment04RPreflight';",
      "export {",
      "  EXPERIMENT_04R_AUDIT_MANIFEST,",
      "  EXPERIMENT_04R_FORBIDDEN_FRAGMENTS,",
      "  validateExperiment04RAuditCoverage,",
      "  findForbiddenFragmentsInText,",
      "  assertNoForbiddenFragmentsInProviderVisible,",
      "  findEvaluatorMetadataLeaks,",
      "  assertNoEvaluatorMetadataLeaks",
      "} from './src/Experiment04RAudit';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "experiment04r-freeze-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  write: false
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console
});

const {
  EXPERIMENT_04R_ID,
  EXPERIMENT_04R_SEED,
  EXPERIMENT_04R_REPETITIONS,
  EXPERIMENT_04R_PROVIDER,
  EXPERIMENT_04R_CONDITIONS,
  EXPERIMENT_04R_FIXTURES,
  EXPERIMENT_04R_COMMON_TASK_PROMPT,
  EXPERIMENT_04R_RESPONSE_SCHEMA,
  EXPERIMENT_04R_TREATMENT_MANIFEST,
  planExperiment04RTrials,
  canonicalize,
  buildFrozenExperiment04RProviderMessages,
  renderExperiment04RTreatmentPayload,
  validateExperiment04RPreflight,
  EXPERIMENT_04R_AUDIT_MANIFEST,
  EXPERIMENT_04R_FORBIDDEN_FRAGMENTS,
  validateExperiment04RAuditCoverage,
  findForbiddenFragmentsInText,
  assertNoForbiddenFragmentsInProviderVisible,
  findEvaluatorMetadataLeaks,
  assertNoEvaluatorMetadataLeaks
} = module.exports;

// ---------------------------------------------------------------------------
// Frozen design identity.
// ---------------------------------------------------------------------------

assert.equal(EXPERIMENT_04R_ID, "experiment04-semantic-fidelity-v1-r1");
assert.equal(EXPERIMENT_04R_SEED, 240417);
assert.equal(EXPERIMENT_04R_REPETITIONS, 3);
assert.deepEqual(JSON.parse(JSON.stringify(EXPERIMENT_04R_PROVIDER)), { provider: "DeepSeek", model: "deepseek-v4-flash" });
assert.equal(EXPERIMENT_04R_FIXTURES.length, 12);
assert.equal(EXPERIMENT_04R_CONDITIONS.length, 5);
assert.equal(EXPERIMENT_04R_TREATMENT_MANIFEST.plain_llm.length > 0, true);
assert.ok(EXPERIMENT_04R_COMMON_TASK_PROMPT.length > 0);
assert.ok(JSON.stringify(EXPERIMENT_04R_RESPONSE_SCHEMA).length > 0);

const plans = planExperiment04RTrials();
assert.equal(plans.length, 180);
assert.equal(new Set(plans.map((plan) => plan.trialId)).size, 180);
assert.deepEqual(plans, planExperiment04RTrials());

// ---------------------------------------------------------------------------
// Preflight: must pass with zero errors.
// ---------------------------------------------------------------------------

const preflightErrors = validateExperiment04RPreflight();
if (preflightErrors.length > 0) console.error(preflightErrors);
assert.equal(preflightErrors.length, 0);

// ---------------------------------------------------------------------------
// Answer-bearing-context audit coverage: complete, all gates true.
// ---------------------------------------------------------------------------

const fixtureIds = EXPERIMENT_04R_FIXTURES.map((fixture) => fixture.fixtureId);
const auditCoverageErrors = validateExperiment04RAuditCoverage(fixtureIds);
if (auditCoverageErrors.length > 0) console.error(auditCoverageErrors);
assert.equal(auditCoverageErrors.length, 0);
assert.equal(EXPERIMENT_04R_AUDIT_MANIFEST.length, 12);
assert.deepEqual(
  new Set(EXPERIMENT_04R_AUDIT_MANIFEST.map((entry) => entry.fixtureId)),
  new Set(fixtureIds)
);
for (const entry of EXPERIMENT_04R_AUDIT_MANIFEST) {
  assert.equal(entry.definitionSourceIndependent, true, entry.fixtureId);
  assert.equal(entry.relationsSourceIndependent, true, entry.fixtureId);
  assert.equal(entry.noSpeechActLeakage, true, entry.fixtureId);
  assert.equal(entry.noMissingConditionLeakage, true, entry.fixtureId);
  assert.equal(entry.noRevisionAnswerLeakage, true, entry.fixtureId);
  assert.ok(entry.reviewerRationale.trim().length > 0, entry.fixtureId);
}

// ---------------------------------------------------------------------------
// Provider-visible leak audit across all rendered messages.
// ---------------------------------------------------------------------------

for (const fixture of EXPERIMENT_04R_FIXTURES) {
  for (const condition of EXPERIMENT_04R_CONDITIONS) {
    const messages = buildFrozenExperiment04RProviderMessages(fixture, condition, EXPERIMENT_04R_COMMON_TASK_PROMPT);
    const prompt = messages.map((message) => message.content).join("\n");
    const label = `${fixture.fixtureId}:${condition}`;
    assert.equal(findForbiddenFragmentsInText(prompt).length, 0, `${label} forbidden fragments`);
    assertNoForbiddenFragmentsInProviderVisible(messages);
    assert.equal(findEvaluatorMetadataLeaks(fixture, messages).length, 0, `${label} evaluator metadata`);
    assertNoEvaluatorMetadataLeaks(fixture, messages);
    assert.equal(messages[0].content, EXPERIMENT_04R_COMMON_TASK_PROMPT, `${label} system prompt`);
    assert.ok(prompt.includes(fixture.sourceText), `${label} source text`);
    for (const forbidden of [...EXPERIMENT_04R_CONDITIONS, fixture.fixtureId, fixture.category]) {
      assert.equal(prompt.includes(forbidden), false, `${label} leaked ${forbidden}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Forbidden-fragment registry itself: every registered fragment is detectable,
// and none of the frozen fixtures is modified to make this pass.
// ---------------------------------------------------------------------------

for (const fragment of EXPERIMENT_04R_FORBIDDEN_FRAGMENTS) {
  assert.ok(
    findForbiddenFragmentsInText(`Injected context: ${fragment}.`).includes(fragment),
    `fragment not detectable: ${fragment}`
  );
}

// ---------------------------------------------------------------------------
// Structural invariants preserved from the frozen design.
// ---------------------------------------------------------------------------

for (const fixture of EXPERIMENT_04R_FIXTURES) {
  assert.notEqual(fixture.sourceText, fixture.fixtureId);
  assert.ok(fixture.sourceText.length > 20);
  assert.ok(fixture.expectedPersonalConcepts.length > 0);
  const payload = renderExperiment04RTreatmentPayload(fixture, "plain_llm");
  assert.equal(payload, undefined);
}
const ambiguity = EXPERIMENT_04R_FIXTURES.find((fixture) => fixture.fixtureId === "bridge-ambiguity");
assert.equal(ambiguity.expectedBindings[0].expectedAmbiguitySet.length, 2);
const required = EXPERIMENT_04R_FIXTURES.flatMap((fixture) =>
  fixture.expectedBindings.filter((binding) => binding.requirement === "required")
);
assert.ok(required.length > 0);
assert.ok(required.every((binding) => binding.expectedConceptId.startsWith("synthetic://")));
assert.equal(canonicalize({ b: 1, a: [true, null] }), canonicalize({ a: [true, null], b: 1 }));

console.log("experiment04r-freeze.test.mjs PASS");
