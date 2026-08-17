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
      "  scoreVerifiedGrounding,",
      "  scoreOverreach,",
      "  validateTreatmentIntegrity,",
      "  detectMissingAssumedContradiction",
      "} from './src/SemanticFidelityV2';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "semantic-fidelity-v2-entry.ts",
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
  crypto: { randomUUID: () => "v2-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
  planExperiment03Trials,
  scoreVerifiedGrounding,
  scoreOverreach,
  validateTreatmentIntegrity,
  detectMissingAssumedContradiction
} = module.exports;

const caseIds = Array.from({ length: 12 }, (_, i) => `case-${i + 1}`);
const cases = caseIds.map((id) => ({
  id,
  schemaVersion: SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
  sourceText: `${id} source`,
  tags: [],
  rationale: "",
  treatmentManifest: { condition: "plain_llm", suppliedContext: "none" }
}));

function result(overrides = {}) {
  return {
    id: "trial",
    schemaVersion: SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
    caseId: "case-1",
    condition: "plain_llm",
    runId: "exp",
    runIndex: 1,
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
    timestamp: "2026-08-17T00:00:00.000Z",
    ...overrides
  };
}

// ── T01: 180 unique planned trials ─────────────────────────────────────
const plans = planExperiment03Trials(cases, "exp03", 3, 12345);
assert.equal(plans.length, 180);
assert.equal(new Set(plans.map((p) => p.trialId)).size, 180);
assert.deepEqual(plans, planExperiment03Trials(cases, "exp03", 3, 12345));
console.log("T01 PASS: 180 unique, seeded deterministic trials");

// ── T02: verified grounding rules ──────────────────────────────────────
const bindingCase = {
  id: "grounding",
  schemaVersion: SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
  sourceText: "X",
  tags: [],
  rationale: "",
  treatmentManifest: { condition: "plain_llm", suppliedContext: "none" },
  expectedBindings: [
    {
      expectedConceptId: "concept-x",
      acceptedSurfaceForms: ["X", "ZIP X"],
      requirement: "required"
    },
    {
      expectedConceptId: "concept-optional",
      acceptedSurfaceForms: ["OPT"],
      requirement: "optional"
    }
  ]
};

const correct = scoreVerifiedGrounding(bindingCase, result({
  conceptBindings: [
    { surfaceForm: "ZIP X", conceptId: "concept-x@1", status: "resolved" }
  ]
}));
assert.equal(correct.verified, 1);
assert.equal(correct.missingRequired, 0);

const invented = scoreVerifiedGrounding(bindingCase, result({
  conceptBindings: [
    { surfaceForm: "X", conceptId: "FileFormat:ZIP", status: "resolved" }
  ]
}));
assert.equal(invented.verified, 0);
assert.equal(invented.wrong, 1);

const missingRequired = scoreVerifiedGrounding(bindingCase, result({
  conceptBindings: []
}));
assert.equal(missingRequired.missingRequired, 1);
assert.equal(missingRequired.verified, 0);
console.log("T02 PASS: verified grounding rules");

// ── T03: overreach is independent from grounding ───────────────────────
const overreachCase = {
  id: "overreach",
  schemaVersion: SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
  sourceText: "X",
  tags: [],
  rationale: "",
  treatmentManifest: { condition: "plain_llm", suppliedContext: "none" },
  allowedOverreachCommitments: ["ALLOWED"]
};
assert.equal(scoreOverreach(overreachCase, result({ semanticCommitments: ["BAD"] })), 1);
assert.equal(scoreOverreach(overreachCase, result({ semanticCommitments: ["ALLOWED"] })), 0);
console.log("T03 PASS: overreach independent");

// ── T04: treatment integrity and missing/assumed contradiction ─────────
const treatmentIssues = validateTreatmentIntegrity({
  id: "brain",
  schemaVersion: SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
  sourceText: "X",
  tags: [],
  rationale: "",
  treatmentManifest: {
    condition: "brain_definition",
    suppliedContext: "definition",
    suppliedConceptIds: ["concept-x"]
  },
  expectedBindings: []
}, result({
  condition: "brain_definition",
  treatmentContextConditions: []
}));
assert.ok(treatmentIssues.length > 0);
assert.equal(detectMissingAssumedContradiction(result({
  assumedConditions: ["finite"],
  missingConditions: ["finite"]
})), true);
console.log("T04 PASS: treatment integrity and contradiction detection");

console.log("semantic-fidelity-v2.test.mjs PASS");

