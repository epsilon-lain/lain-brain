import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: { contents: ["export * from './src/Experiment04Definition';", "export { buildFrozenExperiment04ProviderMessages, renderExperiment04TreatmentPayload } from './src/Experiment04Instrument';", "export { validateExperiment04Preflight } from './src/Experiment04Preflight';"].join("\n"), resolveDir: process.cwd(), sourcefile: "experiment04-freeze-entry.ts", loader: "ts" },
  absWorkingDir: process.cwd(), bundle: true, platform: "node", format: "cjs", target: "es2021", write: false
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require, console });
const e = module.exports;

assert.equal(e.EXPERIMENT_04_FIXTURES.length, 12);
assert.equal(e.planExperiment04Trials().length, 180);
assert.equal(new Set(e.planExperiment04Trials().map((plan) => plan.trialId)).size, 180);
assert.deepEqual(e.planExperiment04Trials(), e.planExperiment04Trials());
assert.equal(e.validateExperiment04Preflight().length, 0);

for (const fixture of e.EXPERIMENT_04_FIXTURES) {
  assert.notEqual(fixture.sourceText, fixture.fixtureId);
  assert.ok(fixture.sourceText.length > 20);
  assert.doesNotMatch(fixture.sourceText, /synthetic source\.|<fixture_id>|\bTODO\b|\bTBD\b/i);
  assert.ok(fixture.expectedPersonalConcepts.length > 0);
  for (const condition of e.EXPERIMENT_04_CONDITIONS) {
    const messages = e.buildFrozenExperiment04ProviderMessages(fixture, condition, e.EXPERIMENT_04_COMMON_TASK_PROMPT);
    const prompt = messages.map((message) => message.content).join("\n");
    assert.equal(messages[0].content, e.EXPERIMENT_04_COMMON_TASK_PROMPT);
    assert.ok(prompt.includes(fixture.sourceText));
    for (const forbidden of [...e.EXPERIMENT_04_CONDITIONS, fixture.fixtureId, fixture.category, "treatment metadata", "experimental group", "control group"]) assert.equal(prompt.includes(forbidden), false, `${fixture.fixtureId} leaked ${forbidden}`);
    const payload = e.renderExperiment04TreatmentPayload(fixture, condition);
    if (condition === "plain_llm") assert.equal(payload, undefined);
    else assert.ok(payload.length > 0);
    if (condition === "brain_identity_only") assert.equal(/Definition:|Relation:/.test(payload), false);
    if (condition === "brain_definition") assert.equal(/Definition:/.test(payload) && !/Relation:/.test(payload), true);
    if (condition === "brain_definition_plus_relations") assert.equal(/Definition:/.test(payload) && /Relation:/.test(payload), true);
    if (condition === "irrelevant_context") for (const concept of fixture.expectedPersonalConcepts) assert.equal(payload.includes(concept.stableConceptId), false);
  }
}

const ambiguity = e.EXPERIMENT_04_FIXTURES.find((fixture) => fixture.fixtureId === "bridge-ambiguity");
assert.equal(ambiguity.expectedBindings[0].expectedAmbiguitySet.length, 2);
const required = e.EXPERIMENT_04_FIXTURES.flatMap((fixture) => fixture.expectedBindings.filter((binding) => binding.requirement === "required"));
assert.ok(required.length > 0);
assert.ok(required.every((binding) => binding.expectedConceptId.startsWith("synthetic://")));
assert.equal(e.canonicalize({ b: 1, a: [true, null] }), e.canonicalize({ a: [true, null], b: 1 }));
console.log("experiment04-freeze.test.mjs PASS");
