import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,",
      "  planExperiment03Trials,",
      "  renderExperiment03DryRun",
      "} from './src/SemanticFidelityV2';",
      "export { executeExperiment03Trials } from './src/SemanticFidelityV2Live';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "experiment03-live-entry.ts",
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
  console,
  URL,
  crypto: { randomUUID: () => "e03-test-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
  planExperiment03Trials,
  renderExperiment03DryRun,
  executeExperiment03Trials
} = module.exports;

const ids = Array.from({ length: 12 }, (_, i) => `case-${i + 1}`);
const cases = ids.map((id) => ({
  id,
  schemaVersion: SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
  sourceText: `${id} source`,
  tags: [],
  rationale: "",
  treatmentManifest: { condition: "plain_llm", suppliedContext: "none" }
}));

function resultFor(plan) {
  return {
    id: plan.trialId,
    schemaVersion: SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
    caseId: plan.caseId,
    condition: plan.condition,
    runId: "exp03",
    runIndex: plan.runIndex,
    executionMode: "mocked",
    conceptBindings: [],
    relations: [],
    semanticCommitments: [],
    sourceStatedConditions: [],
    treatmentContextConditions: [],
    missingConditions: [],
    assumedConditions: [],
    ambiguities: [],
    validationFailures: [],
    timestamp: "2026-08-17T00:00:00.000Z"
  };
}

// ── T01: 180 plans, uniqueness, condition/case/run distribution ───────
const plans = planExperiment03Trials(cases, "exp03", 3, 12345);
assert.equal(plans.length, 180);
assert.equal(new Set(plans.map((p) => p.trialId)).size, 180);
for (const condition of [
  "plain_llm",
  "irrelevant_context",
  "brain_identity_only",
  "brain_definition",
  "brain_definition_plus_relations"
]) {
  assert.equal(plans.filter((p) => p.condition === condition).length, 36);
}
for (const caseDef of cases) {
  assert.equal(plans.filter((p) => p.caseId === caseDef.id).length, 15);
  for (const condition of [
    "plain_llm",
    "irrelevant_context",
    "brain_identity_only",
    "brain_definition",
    "brain_definition_plus_relations"
  ]) {
    assert.equal(
      plans.filter((p) => p.caseId === caseDef.id && p.condition === condition).length,
      3
    );
  }
}
assert.deepEqual(plans, planExperiment03Trials(cases, "exp03", 3, 12345));
console.log("T01 PASS: 180 unique balanced seeded plans");

// ── T02: dry run text is exact and offline ────────────────────────────
const dryRun = renderExperiment03DryRun(cases, "exp03", 3, 12345);
assert.match(dryRun, /Cases: 12/);
assert.match(dryRun, /Planned trials: 180/);
assert.match(dryRun, /Seed: 12345/);
assert.match(dryRun, /no provider requests/);
console.log("T02 PASS: dry run exact");

// ── T03: execute covers all conditions and resume skips completed ─────
const calls = [];
const analyzer = {
  async analyze({ caseDef, condition, runIndex, trialId }) {
    calls.push(`${caseDef.id}:${condition}:${runIndex}`);
    return resultFor({ caseId: caseDef.id, condition, runIndex, trialId });
  }
};
const first = await executeExperiment03Trials(cases, {
  experimentId: "exp03",
  seed: 12345,
  runsPerCondition: 3
}, analyzer);
assert.equal(calls.length, 180);
assert.equal(first.completed.length, 180);

const existing = Object.fromEntries(
  first.completed.map((o) => [o.plan.trialId, o.result])
);
const resumed = await executeExperiment03Trials(cases, {
  experimentId: "exp03",
  seed: 12345,
  runsPerCondition: 3
}, analyzer, existing);
assert.equal(calls.length, 180);
assert.equal(resumed.completed.length, 180);
console.log("T03 PASS: execute and resume");

// ── T04: failures remain visible ──────────────────────────────────────
const failingAnalyzer = {
  async analyze({ caseDef, condition }) {
    if (caseDef.id === "case-1" && condition === "plain_llm") {
      throw new Error("provider down");
    }
    return resultFor({ caseId: caseDef.id, condition, runIndex: 1, trialId: "x" });
  }
};
const failed = await executeExperiment03Trials(cases, {
  experimentId: "exp03",
  seed: 12345,
  runsPerCondition: 3
}, failingAnalyzer);
assert.ok(failed.failures.length > 0);
assert.ok(failed.completed.length < 180);
console.log("T04 PASS: failures visible");

console.log("experiment03-live.test.mjs PASS");

