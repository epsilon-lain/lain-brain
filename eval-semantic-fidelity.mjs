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
      "  aggregateSemanticFidelity,",
      "  renderSemanticFidelityMarkdown",
      "} from './src/SemanticFidelityEvaluation';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "semantic-fidelity-cli-entry.ts",
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
  crypto: { randomUUID: () => "eval-cli-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
  SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION,
  aggregateSemanticFidelity,
  renderSemanticFidelityMarkdown
} = module.exports;

function trial(caseId, condition, overrides = {}) {
  return {
    id: `${caseId}-${condition}`,
    schemaVersion: SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION,
    caseId,
    condition,
    runId: "deterministic-mock-run",
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

const cases = [
  {
    id: "improvement-personal-definition",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "ZIP X is used here.",
    tags: ["personal_definition"],
    rationale: "Plain resolves public meaning; Brain resolves personal concept.",
    expectedBindings: [{ surfacePhrase: "X", conceptId: "concept-personal-x" }]
  },
  {
    id: "unchanged-universal",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "Every A has P.",
    tags: ["quantifier"],
    rationale: "Both conditions preserve the universal quantifier.",
    expectedQuantifier: "universal"
  },
  {
    id: "regression-extra-context",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "A implies B.",
    tags: ["implication"],
    rationale: "Brain context introduces unnecessary equivalence in this mock.",
    expectedRelations: ["implication"],
    forbiddenRelations: ["equivalence"]
  }
];

const plainResults = {
  "improvement-personal-definition": trial(
    "improvement-personal-definition",
    "plain_llm",
    { conceptBindings: [{ surfacePhrase: "X", conceptId: "concept-public-x", status: "resolved" }] }
  ),
  "unchanged-universal": trial("unchanged-universal", "plain_llm", { quantifier: "universal" }),
  "regression-extra-context": trial("regression-extra-context", "plain_llm", { relations: ["implication"] })
};

const brainResults = {
  "improvement-personal-definition": trial(
    "improvement-personal-definition",
    "personal_brain",
    { conceptBindings: [{ surfacePhrase: "X", conceptId: "concept-personal-x", status: "resolved" }] }
  ),
  "unchanged-universal": trial("unchanged-universal", "personal_brain", { quantifier: "universal" }),
  "regression-extra-context": trial("regression-extra-context", "personal_brain", { relations: ["equivalence"] })
};

const report = aggregateSemanticFidelity(cases, plainResults, brainResults);
process.stdout.write(
  renderSemanticFidelityMarkdown(
    "Semantic fidelity evaluation — deterministic mock",
    report,
    "mocked",
    cases.length
  ) + "\n"
);

