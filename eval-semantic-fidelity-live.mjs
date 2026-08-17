import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { requestDeepSeek } from './src/DeepSeekClient';",
      "export {",
      "  SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,",
      "  SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION,",
      "  aggregateSemanticFidelity,",
      "  renderSemanticFidelityMarkdown",
      "} from './src/SemanticFidelityEvaluation';",
      "export {",
      "  planLiveTrials,",
      "  executeLiveTrials,",
      "  renderDryRunPlan",
      "} from './src/SemanticFidelityLive';"
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
  write: false,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian",
        namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: [
          "exports.normalizePath = (value) => value;",
          "exports.requestUrl = async ({ url, method, headers, body }) => {",
          "  const response = await fetch(url, { method, headers, body });",
          "  const text = await response.text();",
          "  let json;",
          "  try { json = JSON.parse(text); } catch { json = { error: text }; }",
          "  return { status: response.status, json, text };",
          "};"
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console,
  URL,
  fetch,
  crypto: { randomUUID: () => "live-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  requestDeepSeek,
  SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
  SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION,
  aggregateSemanticFidelity,
  renderSemanticFidelityMarkdown,
  planLiveTrials,
  executeLiveTrials,
  renderDryRunPlan
} = module.exports;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";

const cases = [
  {
    id: "personal-definition",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "ZIP X has property P.",
    tags: ["personal_definition"],
    rationale: "Public meaning differs from synthetic personal meaning.",
    expectedBindings: [{ surfacePhrase: "X", conceptId: "concept-personal-x" }]
  },
  {
    id: "overloaded-term",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "A field is closed under the operation.",
    tags: ["overloaded_term"],
    rationale: "Overloaded term resolved by Personal Brain.",
    expectedBindings: [{ surfacePhrase: "field", conceptId: "concept-field-synthetic" }]
  },
  {
    id: "universal",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "Every element of A has property P.",
    tags: ["quantifier"],
    rationale: "Universal quantifier must be preserved.",
    expectedQuantifier: "universal"
  },
  {
    id: "implication",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "A implies B.",
    tags: ["implication"],
    rationale: "Implication must not become equivalence.",
    expectedRelations: ["implication"],
    forbiddenRelations: ["equivalence"]
  },
  {
    id: "ambiguity",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "Space is finite-dimensional.",
    tags: ["ambiguity"],
    rationale: "Legitimate ambiguity should be preserved.",
    expectedAmbiguity: "preserve"
  },
  {
    id: "missing-assumption",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "Every normal operator has an eigenbasis.",
    tags: ["omitted_assumption"],
    rationale: "Missing finite-dimensionality should be exposed.",
    expectedMissingConditions: ["finite-dimensionality"]
  },
  {
    id: "proof-sketch",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "By the spectral theorem, T diagonalizes.",
    tags: ["proof_sketch"],
    rationale: "Incomplete reasoning remains proof_sketch.",
    expectedSpeechAct: "proof_sketch"
  },
  {
    id: "no-advantage",
    schemaVersion: SEMANTIC_FIDELITY_CASE_SCHEMA_VERSION,
    sourceText: "Every integer has an additive inverse.",
    tags: ["quantifier"],
    rationale: "Brain context plausibly provides no advantage.",
    expectedQuantifier: "universal"
  }
];

const brainContext = {
  "personal-definition":
    "Concept X: concept-personal-x@1. Personal definition: a synthetic user-specific meaning.",
  "overloaded-term":
    "Concept field: concept-field-synthetic@1. Personal definition: an algebraic structure with addition and multiplication.",
  "ambiguity":
    "Two concepts share title Space: concept-space-a@1 and concept-space-b@1."
};

const config = {
  experimentId: `semantic-fidelity-live-${Date.now()}`,
  runsPerCondition: 3,
  selectedCaseIds: cases.map((caseDef) => caseDef.id),
  orderStrategy: "alternating",
  providerModel: "deepseek-v4-flash"
};

if (dryRun) {
  process.stdout.write(renderDryRunPlan(cases, config) + "\n");
} else if (apiKey === "") {
  process.stdout.write(
    "Live experiment not run: no DEEPSEEK_API_KEY is configured. " +
    "Run with --dry-run to inspect the planned trials.\n"
  );
} else {
  const analyzer = {
    async analyze({ caseDef, condition, runIndex, trialId }) {
      const context = condition === "personal_brain"
        ? (brainContext[caseDef.id] ?? "No bounded Personal Brain context.")
        : "No Personal Brain context.";
      const system =
        "Return strict JSON only with the following shape: " +
        '{"conceptBindings":[{"surfacePhrase":"...","conceptId":"...","status":"resolved|ambiguous|unresolved|proposed_new"}],' +
        '"quantifier":"universal|existential|uniqueness",' +
        '"relations":["implication|equivalence|analogy|subset|equality|membership|part_of|identity"],' +
        '"addedImplicitAssumptions":["..."],"missingConditions":["..."],"ambiguities":["..."],' +
        '"speechAct":"definition_candidate|theorem_claim|proof_sketch|intuition|equivalence_claim|conjecture"}';
      const response = await requestDeepSeek(apiKey, [
        { role: "system", content: system },
        {
          role: "user",
          content:
            "Source:\n" + caseDef.sourceText +
            "\n\nCondition context:\n" + context
        }
      ]);
      const parsed = JSON.parse(response);
      return {
        id: `live-${caseDef.id}-${condition}`,
        schemaVersion: SEMANTIC_FIDELITY_RESULT_SCHEMA_VERSION,
        caseId: caseDef.id,
        condition,
        runId: config.experimentId,
        runIndex,
        id: trialId,
        executionMode: "live",
        conceptBindings: Array.isArray(parsed.conceptBindings) ? parsed.conceptBindings : [],
        quantifier: parsed.quantifier,
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
        explicitAssumptions: [],
        addedImplicitAssumptions: Array.isArray(parsed.addedImplicitAssumptions) ? parsed.addedImplicitAssumptions : [],
        missingConditions: Array.isArray(parsed.missingConditions) ? parsed.missingConditions : [],
        ambiguities: Array.isArray(parsed.ambiguities) ? parsed.ambiguities : [],
        speechAct: parsed.speechAct,
        validationFailures: [],
        providerModel: config.providerModel,
        timestamp: new Date().toISOString()
      };
    }
  };
  const outcome = await executeLiveTrials(cases, config, analyzer);
  const plain = {};
  const brain = {};
  for (const item of outcome.completed) {
    if (item.plan.condition === "plain_llm") {
      plain[item.plan.caseId] = item.result;
    } else {
      brain[item.plan.caseId] = item.result;
    }
  }
  const report = aggregateSemanticFidelity(cases, plain, brain);
  const outputDir = join(process.cwd(), "evaluation-results");
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = join(outputDir, `${config.experimentId}.json`);
  const mdPath = join(outputDir, `${config.experimentId}.md`);
  writeFileSync(jsonPath, JSON.stringify({
    experimentId: config.experimentId,
    schemaVersion: 1,
    plannedTrials: outcome.plans.length,
    completedTrials: outcome.completed.length,
    failures: outcome.failures.map((item) => ({
      trialId: item.plan.trialId,
      error: item.error
    })),
    outcomes: outcome.completed.map((item) => ({
      plan: item.plan,
      result: item.result
    }))
  }, null, 2));
  writeFileSync(mdPath, renderSemanticFidelityMarkdown(
    "Semantic fidelity — LIVE PAIRED EXPERIMENT",
    report,
    "live",
    cases.length
  ));
  process.stdout.write(
    `Live run complete. ${outcome.completed.length}/${outcome.plans.length} trials.\n` +
    `JSON: ${jsonPath}\nMarkdown: ${mdPath}\n`
  );
}
