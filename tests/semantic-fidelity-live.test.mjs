import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  planLiveTrials,",
      "  executeLiveTrials,",
      "  renderDryRunPlan",
      "} from './src/SemanticFidelityLive';",
      "export {",
      "  SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,",
      "  SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION",
      "} from './src/SemanticFidelityEvaluation';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "semantic-fidelity-live-entry.ts",
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
  crypto: { randomUUID: () => "live-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  planLiveTrials,
  executeLiveTrials,
  renderDryRunPlan,
  SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
  SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION
} = module.exports;

const cases = [
  {
    id: "case-a",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "Every A has P.",
    tags: ["quantifier"],
    rationale: "",
    expectedQuantifier: "universal"
  },
  {
    id: "case-b",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "A implies B.",
    tags: ["implication"],
    rationale: "",
    expectedRelations: ["implication"]
  }
];

function result(plan) {
  return {
    id: plan.trialId,
    schemaVersion: SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION,
    caseId: plan.caseId,
    condition: plan.condition,
    runId: "exp",
    runIndex: plan.runIndex,
    executionMode: "mocked",
    conceptBindings: [],
    relations: [],
    explicitAssumptions: [],
    addedImplicitAssumptions: [],
    missingConditions: [],
    ambiguities: [],
    validationFailures: [],
    timestamp: "2026-08-16T00:00:00.000Z"
  };
}

// ── T01: alternating plan and trial indexing ───────────────────────────
{
  const plans = planLiveTrials(cases, {
    experimentId: "exp",
    runsPerCondition: 2,
    orderStrategy: "alternating"
  });
  assert.equal(plans.length, 8);
  assert.equal(new Set(plans.map((p) => p.trialId)).size, 8);
  assert.equal(plans[0].runIndex, 1);
  assert.equal(plans[plans.length - 1].orderIndex, 7);
  // First run of first case: brain then plain; first run of second case: plain then brain.
  assert.equal(plans[0].condition, "personal_brain");
  assert.equal(plans[1].condition, "plain_llm");
  assert.equal(plans[4].condition, "plain_llm");
  assert.equal(plans[5].condition, "personal_brain");
  console.log("T01 PASS: alternating plan");
}

// ── T02: seeded order is deterministic ────────────────────────────────
{
  const a = planLiveTrials(cases, {
    experimentId: "exp",
    runsPerCondition: 1,
    orderStrategy: "seeded",
    seed: 7
  });
  const b = planLiveTrials(cases, {
    experimentId: "exp",
    runsPerCondition: 1,
    orderStrategy: "seeded",
    seed: 7
  });
  assert.deepEqual(a, b);
  console.log("T02 PASS: seeded order deterministic");
}

// ── T03: execute with fake analyzer, both conditions, resume ──────────
{
  const calls = [];
  const analyzer = {
    async analyze({ caseDef, condition }) {
      calls.push(`${caseDef.id}:${condition}`);
      return result({ caseId: caseDef.id, condition, runIndex: 1 });
    }
  };
  const outcome = await executeLiveTrials(cases, {
    experimentId: "exp",
    runsPerCondition: 1,
    orderStrategy: "alternating"
  }, analyzer);
  assert.equal(outcome.plans.length, 4);
  assert.equal(outcome.completed.length, 4);
  assert.equal(outcome.failures.length, 0);
  assert.equal(calls.length, 4);

  const existing = Object.fromEntries(
    outcome.completed.map((item) => [item.plan.trialId, item.result])
  );
  const resumed = await executeLiveTrials(cases, {
    experimentId: "exp",
    runsPerCondition: 1,
    orderStrategy: "alternating"
  }, analyzer, existing);
  assert.equal(resumed.completed.length, 4);
  assert.equal(calls.length, 4);
  console.log("T03 PASS: execute and resume");
}

// ── T04: failures recorded, no overwrite ───────────────────────────────
{
  const analyzer = {
    async analyze({ caseDef }) {
      if (caseDef.id === "case-b") {
        throw new Error("network");
      }
      return result({ caseId: caseDef.id, condition: "plain_llm", runIndex: 1 });
    }
  };
  const outcome = await executeLiveTrials(cases, {
    experimentId: "exp",
    runsPerCondition: 1,
    orderStrategy: "alternating"
  }, analyzer);
  assert.ok(outcome.failures.length > 0);
  assert.ok(outcome.completed.length > 0);
  console.log("T04 PASS: failures recorded");
}

// ── T05: dry run makes no provider requests and exposes plan ──────────
{
  const dryRun = renderDryRunPlan(cases, {
    experimentId: "exp",
    runsPerCondition: 2,
    orderStrategy: "alternating"
  });
  assert.match(dryRun, /Planned trial count: 8/);
  assert.match(dryRun, /Dry run: no provider requests were made/);
  console.log("T05 PASS: dry run");
}

console.log("semantic-fidelity-live.test.mjs PASS");
