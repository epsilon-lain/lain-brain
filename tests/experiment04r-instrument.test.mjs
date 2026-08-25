import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/Experiment04RDefinition';",
      "export {",
      "  buildExperiment04RProviderMessages,",
      "  assertExperiment04RPromptHasNoInternalConditionIds,",
      "  buildFrozenExperiment04RProviderMessages,",
      "  renderExperiment04RTreatmentPayload",
      "} from './src/Experiment04RInstrument';",
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
    sourcefile: "experiment04r-instrument-entry.ts",
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
  EXPERIMENT_04R_CONDITIONS,
  EXPERIMENT_04R_FIXTURES,
  EXPERIMENT_04R_COMMON_TASK_PROMPT,
  planExperiment04RTrials,
  canonicalize,
  buildExperiment04RProviderMessages,
  assertExperiment04RPromptHasNoInternalConditionIds,
  buildFrozenExperiment04RProviderMessages,
  renderExperiment04RTreatmentPayload,
  EXPERIMENT_04R_AUDIT_MANIFEST,
  EXPERIMENT_04R_FORBIDDEN_FRAGMENTS,
  validateExperiment04RAuditCoverage,
  findForbiddenFragmentsInText,
  assertNoForbiddenFragmentsInProviderVisible,
  findEvaluatorMetadataLeaks,
  assertNoEvaluatorMetadataLeaks
} = module.exports;

// ---------------------------------------------------------------------------
// Trial planning: 12 fixtures, 5 conditions, 3 repetitions, deterministic, unique IDs.
// ---------------------------------------------------------------------------

assert.equal(EXPERIMENT_04R_FIXTURES.length, 12);
assert.equal(EXPERIMENT_04R_CONDITIONS.length, 5);
assert.deepEqual(Array.from(EXPERIMENT_04R_CONDITIONS), [
  "plain_llm",
  "irrelevant_context",
  "brain_identity_only",
  "brain_definition",
  "brain_definition_plus_relations"
]);

const plans = planExperiment04RTrials();
assert.equal(plans.length, 180);
assert.equal(plans.length, 12 * 5 * 3);
assert.equal(new Set(plans.map((plan) => plan.trialId)).size, 180);
assert.deepEqual(plans, planExperiment04RTrials());
for (const plan of plans) {
  assert.ok(plan.trialId.startsWith(`${EXPERIMENT_04R_ID}:`));
  assert.ok(EXPERIMENT_04R_CONDITIONS.includes(plan.condition));
}
for (const fixture of EXPERIMENT_04R_FIXTURES) {
  for (const condition of EXPERIMENT_04R_CONDITIONS) {
    const perCell = plans.filter((plan) => plan.fixtureId === fixture.fixtureId && plan.condition === condition);
    assert.equal(perCell.length, 3, `${fixture.fixtureId}:${condition} cell size`);
    assert.equal(new Set(perCell.map((plan) => plan.runIndex)).size, 3);
  }
}

// ---------------------------------------------------------------------------
// Provider-visible messages per fixture x condition.
// ---------------------------------------------------------------------------

for (const fixture of EXPERIMENT_04R_FIXTURES) {
  const prompts = new Map();
  for (const condition of EXPERIMENT_04R_CONDITIONS) {
    const messages = buildFrozenExperiment04RProviderMessages(fixture, condition, EXPERIMENT_04R_COMMON_TASK_PROMPT);
    prompts.set(condition, messages.map((message) => message.content).join("\n"));
    const prompt = prompts.get(condition);
    // Common system prompt stays identical.
    assert.equal(messages[0].content, EXPERIMENT_04R_COMMON_TASK_PROMPT, `${fixture.fixtureId}:${condition} system prompt`);
    // Source text stays identical across conditions and is always present.
    assert.ok(prompt.includes(`Source text:\n${fixture.sourceText}`), `${fixture.fixtureId}:${condition} source text`);
    // Internal identifiers are not provider-visible.
    for (const forbidden of [
      ...EXPERIMENT_04R_CONDITIONS,
      fixture.fixtureId,
      fixture.category,
      "treatment metadata",
      "experimental group",
      "control group"
    ]) {
      assert.equal(prompt.includes(forbidden), false, `${fixture.fixtureId}:${condition} leaked ${forbidden}`);
    }
    // Answer-bearing fragments and evaluator metadata must be absent.
    assert.equal(findForbiddenFragmentsInText(prompt).length, 0, `${fixture.fixtureId}:${condition} fragments`);
    assertNoForbiddenFragmentsInProviderVisible(messages);
    assert.equal(findEvaluatorMetadataLeaks(fixture, messages).length, 0, `${fixture.fixtureId}:${condition} metadata`);
    assertNoEvaluatorMetadataLeaks(fixture, messages);
    // Payload composition per condition.
    const payload = renderExperiment04RTreatmentPayload(fixture, condition);
    if (condition === "plain_llm") {
      assert.equal(payload, undefined, `${fixture.fixtureId} plain payload`);
      assert.equal(prompt.includes("Semantic reference:"), false);
    } else {
      assert.ok(payload.length > 0, `${fixture.fixtureId}:${condition} payload`);
    }
    if (condition === "brain_identity_only") {
      assert.equal(/Definition:|Relation:/.test(payload), false, `${fixture.fixtureId} identity composition`);
    }
    if (condition === "brain_definition") {
      assert.equal(/Definition:/.test(payload) && !/Relation:/.test(payload), true, `${fixture.fixtureId} definition composition`);
    }
    if (condition === "brain_definition_plus_relations") {
      assert.equal(/Definition:/.test(payload) && /Relation:/.test(payload), true, `${fixture.fixtureId} relations composition`);
    }
    if (condition === "irrelevant_context") {
      for (const concept of fixture.expectedPersonalConcepts) {
        assert.equal(payload.includes(concept.stableConceptId), false, `${fixture.fixtureId} irrelevant leaks ${concept.stableConceptId}`);
      }
    }
  }
  // Source stays identical across all conditions for this fixture.
  const sourceBlocks = new Set(
    [...prompts.values()].map((prompt) => prompt.split("\n").find((line) => line.startsWith("Source text:")))
  );
  assert.equal(sourceBlocks.size, 1, `${fixture.fixtureId} source varies across conditions`);
}

// ---------------------------------------------------------------------------
// Ambiguity fixture keeps two candidates with neutral provider-visible IDs.
// ---------------------------------------------------------------------------

const ambiguity = EXPERIMENT_04R_FIXTURES.find((fixture) => fixture.fixtureId === "bridge-ambiguity");
assert.ok(ambiguity);
assert.equal(ambiguity.expectedBindings[0].expectedAmbiguitySet.length, 2);
assert.deepEqual(
  new Set(ambiguity.expectedPersonalConcepts.map((concept) => concept.stableConceptId)),
  new Set(["synthetic://personal/bridge-a@1@1", "synthetic://personal/bridge-b@1@1"])
);
for (const condition of ["brain_identity_only", "brain_definition", "brain_definition_plus_relations"]) {
  const payload = renderExperiment04RTreatmentPayload(ambiguity, condition);
  assert.ok(payload.includes("bridge-a@1"), `${condition} missing bridge-a`);
  assert.ok(payload.includes("bridge-b@1"), `${condition} missing bridge-b`);
  assert.equal(payload.includes("bridge-dialogue"), false, `${condition} leaked old candidate ID`);
  assert.equal(payload.includes("bridge-transition"), false, `${condition} leaked old candidate ID`);
}

// ---------------------------------------------------------------------------
// Audit manifest coverage.
// ---------------------------------------------------------------------------

assert.equal(EXPERIMENT_04R_AUDIT_MANIFEST.length, 12);
assert.equal(
  validateExperiment04RAuditCoverage(EXPERIMENT_04R_FIXTURES.map((fixture) => fixture.fixtureId)).length,
  0
);
// Coverage gate negative cases: synthetic ID lists only, frozen fixtures untouched.
assert.ok(validateExperiment04RAuditCoverage([]).length > 0, "empty fixture list accepted");
assert.ok(
  validateExperiment04RAuditCoverage([
    ...EXPERIMENT_04R_FIXTURES.map((fixture) => fixture.fixtureId),
    "unknown-fixture"
  ]).some((error) => error.includes("missing audit entry")),
  "fixture without an audit entry accepted"
);
assert.ok(
  validateExperiment04RAuditCoverage(
    EXPERIMENT_04R_FIXTURES.map((fixture) => fixture.fixtureId).slice(1)
  ).some((error) => error.includes("unknown fixture ID")),
  "audit entry for a non-fixture ID accepted"
);

// ---------------------------------------------------------------------------
// Synthetic instrument builder (condition composition, no provider).
// ---------------------------------------------------------------------------

const syntheticFixture = {
  id: "synthetic-fixture",
  sourceText: "The synthetic term has a private meaning.",
  treatmentPayloads: {
    irrelevant: "A basalt column forms when lava cools slowly.",
    identityOnly: "Concept ID: synthetic://personal/term@1. Aliases: term.",
    definition: "Definition: The term is a private handle.",
    relations: "Relations: The term is stored with its notes."
  }
};
const expectedContext = {
  plain_llm: undefined,
  irrelevant_context: syntheticFixture.treatmentPayloads.irrelevant,
  brain_identity_only: syntheticFixture.treatmentPayloads.identityOnly,
  brain_definition: [syntheticFixture.treatmentPayloads.identityOnly, syntheticFixture.treatmentPayloads.definition].join("\n"),
  brain_definition_plus_relations: [
    syntheticFixture.treatmentPayloads.identityOnly,
    syntheticFixture.treatmentPayloads.definition,
    syntheticFixture.treatmentPayloads.relations
  ].join("\n")
};
for (const [condition, context] of Object.entries(expectedContext)) {
  const messages = buildExperiment04RProviderMessages(syntheticFixture, condition);
  const visible = messages.map((message) => message.content).join("\n");
  assert.match(visible, /The synthetic term has a private meaning\./);
  if (context === undefined) {
    assert.equal(visible.includes("Reference context:"), false);
  } else {
    assert.ok(visible.includes(context));
  }
  for (const internalId of EXPERIMENT_04R_CONDITIONS) {
    assert.equal(visible.includes(internalId), false, `${condition} leaked ${internalId}`);
  }
}

// ---------------------------------------------------------------------------
// Negative tests: the answer-bearing validator must reject deliberately bad
// synthetic provider-visible payloads (the frozen fixtures are NOT modified).
// ---------------------------------------------------------------------------

const badPayload = "Reference: the lantern keeps the associated project open while its notes are revised.";
assert.ok(findForbiddenFragmentsInText(badPayload).includes("keeps the associated project open"));
assert.ok(findForbiddenFragmentsInText("A keep-or-remove review follows the harbor.").includes("keep-or-remove"));
assert.ok(findForbiddenFragmentsInText("This field may split into two inquiry clusters.").includes("may split into two inquiry clusters"));
assert.ok(findForbiddenFragmentsInText("normal operators need a finite dimensionality qualification").includes("finite-dimensionality qualification"));
assert.ok(findForbiddenFragmentsInText("modus ponens derives Q from P").includes("derives Q from P"));
assert.ok(findForbiddenFragmentsInText("the compass   selects reversible steps").includes("selects reversible steps"));
assert.ok(findForbiddenFragmentsInText("the current compass supersedes compass-prior").includes("supersedes compass-prior"));
assert.ok(findForbiddenFragmentsInText("the proof can be retraced step by step").includes("retraced step by step"));
assert.ok(findForbiddenFragmentsInText("the final explicit distinction preserved before combining").includes("final explicit distinction preserved"));
assert.ok(findForbiddenFragmentsInText("old IDs bridge-dialogue and bridge-transition leaked").includes("bridge-dialogue"));
assert.ok(findForbiddenFragmentsInText("old IDs bridge-dialogue and bridge-transition leaked").includes("bridge-transition"));
assert.equal(findForbiddenFragmentsInText("A neutral statement about a project and its notes.").length, 0);
assert.throws(
  () => assertNoForbiddenFragmentsInProviderVisible([{ role: "user", content: badPayload }]),
  /answer-bearing fragment/
);
assert.doesNotThrow(() =>
  assertNoForbiddenFragmentsInProviderVisible([{ role: "user", content: "A neutral statement." }])
);

const syntheticMetadataFixture = {
  sourceStatedFacts: ["FINITE_DIMENSIONALITY_MAY_BE_MISSING"],
  permittedBackgroundFacts: ["HYPOTHESES_NOT_YET_CHECKED"],
  allowedSemanticCommitments: ["MODUS_PONENS"],
  forbiddenSemanticCommitments: ["IMPLICATION_IS_EQUIVALENCE"]
};
assert.deepEqual(
  Array.from(findEvaluatorMetadataLeaks(syntheticMetadataFixture, [
    { role: "user", content: "Missing scope: FINITE_DIMENSIONALITY_MAY_BE_MISSING." }
  ])),
  ["FINITE_DIMENSIONALITY_MAY_BE_MISSING"]
);
assert.deepEqual(
  Array.from(findEvaluatorMetadataLeaks(syntheticMetadataFixture, [
    { role: "user", content: "Missing scope: finite dimensionality may be missing." }
  ])),
  ["FINITE_DIMENSIONALITY_MAY_BE_MISSING"]
);
// Ordinary English that merely resembles a short symbolic label is NOT banned.
assert.equal(
  findEvaluatorMetadataLeaks(syntheticMetadataFixture, [
    { role: "user", content: "The pattern modus ponens appears in the source." }
  ]).length,
  0
);
assert.throws(
  () => assertNoEvaluatorMetadataLeaks(syntheticMetadataFixture, [{ role: "user", content: "FINITE_DIMENSIONALITY_MAY_BE_MISSING" }]),
  /evaluator-only metadata/
);

assert.throws(
  () => assertExperiment04RPromptHasNoInternalConditionIds([
    { role: "user", content: "Condition: brain_definition" }
  ]),
  /internal condition identifier/
);

assert.equal(
  canonicalize({ b: 1, a: [true, null] }),
  canonicalize({ a: [true, null], b: 1 })
);

console.log("experiment04r-instrument.test.mjs PASS");
