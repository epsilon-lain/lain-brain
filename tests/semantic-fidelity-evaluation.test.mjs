import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,",
      "  SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION,",
      "  computeSemanticFidelityMetrics,",
      "  compareConditions,",
      "  aggregateSemanticFidelity,",
      "  renderSemanticFidelityMarkdown",
      "} from './src/SemanticFidelityEvaluation';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "semantic-fidelity-evaluation-entry.ts",
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
  crypto: { randomUUID: () => "eval-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
  SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION,
  computeSemanticFidelityMetrics,
  compareConditions,
  aggregateSemanticFidelity,
  renderSemanticFidelityMarkdown
} = module.exports;

function result(overrides) {
  return {
    id: "trial",
    schemaVersion: SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION,
    caseId: "case",
    condition: "plain_llm",
    runId: "run-1",
    runIndex: 1,
    executionMode: "mocked",
    conceptBindings: [],
    relations: [],
    explicitAssumptions: [],
    addedImplicitAssumptions: [],
    missingConditions: [],
    ambiguities: [],
    validationFailures: [],
    timestamp: "2026-08-16T00:00:00.000Z",
    ...overrides
  };
}

function binding(phrase, conceptId, status = "resolved") {
  return { surfacePhrase: phrase, conceptId, status };
}

// ── T01: Personal definition improvement ───────────────────────────────
{
  const caseDef = {
    id: "personal-definition",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "ZIP X means the user-specific meaning.",
    tags: ["personal_definition"],
    rationale: "synthetic",
    expectedBindings: [{ surfacePhrase: "X", conceptId: "concept-personal-x" }],
    allowedAddedAssumptions: []
  };
  const plain = result({
    caseId: "personal-definition",
    conceptBindings: [binding("X", "concept-public-x")]
  });
  const brain = result({
    caseId: "personal-definition",
    condition: "personal_brain",
    conceptBindings: [binding("X", "concept-personal-x")]
  });
  const comparison = compareConditions(caseDef, plain, brain);
  assert.equal(comparison.conceptBinding, "improved");
  assert.equal(comparison.correctionBurden, "reduced");
  console.log("T01 PASS: personal definition improvement");
}

// ── T02: No difference ─────────────────────────────────────────────────
{
  const caseDef = {
    id: "no-difference",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "Every A has P.",
    tags: ["quantifier"],
    rationale: "synthetic",
    expectedQuantifier: "universal",
    expectedRelations: []
  };
  const plain = result({ caseId: "no-difference", quantifier: "universal" });
  const brain = result({
    caseId: "no-difference",
    condition: "personal_brain",
    quantifier: "universal"
  });
  const comparison = compareConditions(caseDef, plain, brain);
  assert.equal(comparison.quantifierPreservation, "unchanged");
  assert.equal(comparison.correctionBurden, "unchanged");
  console.log("T02 PASS: no difference");
}

// ── T03: Brain regression ──────────────────────────────────────────────
{
  const caseDef = {
    id: "brain-regression",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "A implies B.",
    tags: ["implication"],
    rationale: "synthetic",
    expectedRelations: ["implication"],
    forbiddenRelations: ["equivalence"],
    allowedAddedAssumptions: []
  };
  const plain = result({
    caseId: "brain-regression",
    relations: ["implication"]
  });
  const brain = result({
    caseId: "brain-regression",
    condition: "personal_brain",
    relations: ["equivalence"]
  });
  const comparison = compareConditions(caseDef, plain, brain);
  assert.equal(comparison.relationPreservation, "worsened");
  assert.equal(comparison.semanticViolations, "increased");
  console.log("T03 PASS: brain regression");
}

// ── T04: silent assumption vs missing condition ────────────────────────
{
  const caseDef = {
    id: "silent-assumption",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "Every normal operator has an eigenbasis.",
    tags: ["omitted_assumption"],
    rationale: "synthetic",
    allowedAddedAssumptions: [],
    expectedMissingConditions: ["finite-dimensionality"]
  };
  const plain = result({
    caseId: "silent-assumption",
    addedImplicitAssumptions: ["finite-dimensionality"],
    missingConditions: []
  });
  const brain = result({
    caseId: "silent-assumption",
    condition: "personal_brain",
    addedImplicitAssumptions: [],
    missingConditions: ["finite-dimensionality"]
  });
  const comparison = compareConditions(caseDef, plain, brain);
  assert.equal(comparison.unsupportedAssumptions, "reduced");
  assert.equal(comparison.correctionBurden, "reduced");
  console.log("T04 PASS: silent assumption vs missing condition");
}

// ── T05: semantically wrong but Lean-typechecked ───────────────────────
{
  const caseDef = {
    id: "lean-valid-wrong",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "A implies B.",
    tags: ["implication"],
    rationale: "synthetic",
    expectedRelations: ["implication"],
    forbiddenRelations: ["equivalence"]
  };
  const wrong = result({
    caseId: "lean-valid-wrong",
    relations: ["equivalence"],
    canonicalProposition: "A ↔ B",
    leanStatementTypechecked: true
  });
  const metrics = computeSemanticFidelityMetrics(caseDef, wrong);
  assert.equal(metrics.relations.violated.length, 1);
  assert.ok(metrics.semanticViolationCount >= 1);
  assert.equal(wrong.leanStatementTypechecked, true);
  console.log("T05 PASS: semantically wrong but Lean-typechecked");
}

// ── T06: ambiguity preserved vs collapsed ──────────────────────────────
{
  const caseDef = {
    id: "ambiguity",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "Space is finite-dimensional.",
    tags: ["ambiguity"],
    rationale: "synthetic",
    expectedAmbiguity: "preserve"
  };
  const collapsed = result({
    caseId: "ambiguity",
    conceptBindings: [binding("Space", "concept-space-a")]
  });
  const preserved = result({
    caseId: "ambiguity",
    condition: "personal_brain",
    conceptBindings: [{ surfacePhrase: "Space", status: "ambiguous" }]
  });
  const metrics = computeSemanticFidelityMetrics(caseDef, preserved);
  assert.equal(metrics.ambiguity.state, "correctly_preserved");
  const comparison = compareConditions(caseDef, collapsed, preserved);
  assert.equal(comparison.ambiguityHandling, "improved");
  console.log("T06 PASS: ambiguity preserved");
}

// ── T07: aggregate and markdown report ─────────────────────────────────
{
  const caseDefs = [
    {
      id: "a",
      schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
      sourceText: "Every A has P.",
      tags: ["quantifier"],
      rationale: "",
      expectedQuantifier: "universal"
    },
    {
      id: "b",
      schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
      sourceText: "A implies B.",
      tags: ["implication"],
      rationale: "",
      expectedRelations: ["implication"],
      forbiddenRelations: ["equivalence"]
    }
  ];
  const plainResults = {
    a: result({ caseId: "a", quantifier: "existential" }),
    b: result({ caseId: "b", relations: ["equivalence"] })
  };
  const brainResults = {
    a: result({ caseId: "a", condition: "personal_brain", quantifier: "universal" }),
    b: result({ caseId: "b", condition: "personal_brain", relations: ["implication"] })
  };
  const report = aggregateSemanticFidelity(caseDefs, plainResults, brainResults);
  assert.equal(report.paired.length, 2);
  const markdown = renderSemanticFidelityMarkdown(
    "Semantic fidelity mock",
    report,
    "mocked",
    caseDefs.length
  );
  assert.match(markdown, /DETERMINISTIC HARNESS \/ MOCKED EXAMPLE/);
  assert.match(markdown, /Component metrics/);
  console.log("T07 PASS: aggregate and markdown report");
}

console.log("semantic-fidelity-evaluation.test.mjs PASS");

