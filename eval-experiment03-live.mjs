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
          "  let json; try { json = JSON.parse(text); } catch { json = { error: text }; }",
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
  crypto: { randomUUID: () => "e03-live-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  requestDeepSeek,
  SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
  planExperiment03Trials,
  renderExperiment03DryRun,
  executeExperiment03Trials
} = module.exports;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
const seed = 12345;
const runs = 3;
const experimentId = `experiment03-live-${Date.now()}`;

const ids = [
  "personal_meaning_a",
  "personal_meaning_b",
  "personal_meaning_c",
  "overloaded_a",
  "overloaded_b",
  "ambiguity_two_candidates",
  "missing_condition",
  "precise_no_brain",
  "irrelevant_context_sensitive",
  "definition_vs_theorem",
  "proof_sketch",
  "stale_revision"
];

const cases = ids.map((id) => ({
  id,
  schemaVersion: SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
  sourceText: `${id} synthetic source.`,
  tags: ["synthetic"],
  rationale: "Experiment 03 frozen fixture",
  treatmentManifest: { condition: "plain_llm", suppliedContext: "none" }
}));

if (dryRun) {
  process.stdout.write(renderExperiment03DryRun(cases, experimentId, runs, seed) + "\n");
} else if (apiKey === "") {
  process.stdout.write(
    "Experiment 03 live run not started: no DEEPSEEK_API_KEY is configured.\n"
  );
} else {
  const analyzer = {
    async analyze({ caseDef, condition, runIndex, trialId }) {
      const response = await requestDeepSeek(apiKey, [
        {
          role: "system",
          content:
            "Return strict JSON only with fields: conceptBindings, semanticCommitments, " +
            "sourceStatedConditions, treatmentContextConditions, missingConditions, assumedConditions, " +
            "ambiguities, quantifier, relations, speechAct."
        },
        {
          role: "user",
          content:
            `Source: ${caseDef.sourceText}\nCondition: ${condition}`
        }
      ]);
      const parsed = JSON.parse(response);
      return {
        id: trialId,
        schemaVersion: SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
        caseId: caseDef.id,
        condition,
        runId: experimentId,
        runIndex,
        executionMode: "live",
        conceptBindings: Array.isArray(parsed.conceptBindings) ? parsed.conceptBindings : [],
        quantifier: parsed.quantifier,
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
        speechAct: parsed.speechAct,
        semanticCommitments: Array.isArray(parsed.semanticCommitments) ? parsed.semanticCommitments : [],
        sourceStatedConditions: Array.isArray(parsed.sourceStatedConditions) ? parsed.sourceStatedConditions : [],
        treatmentContextConditions: Array.isArray(parsed.treatmentContextConditions) ? parsed.treatmentContextConditions : [],
        missingConditions: Array.isArray(parsed.missingConditions) ? parsed.missingConditions : [],
        assumedConditions: Array.isArray(parsed.assumedConditions) ? parsed.assumedConditions : [],
        ambiguities: Array.isArray(parsed.ambiguities) ? parsed.ambiguities : [],
        validationFailures: [],
        timestamp: new Date().toISOString()
      };
    }
  };
  const plans = planExperiment03Trials(cases, experimentId, runs, seed);
  const outcome = await executeExperiment03Trials(cases, {
    experimentId,
    seed,
    runsPerCondition: runs
  }, analyzer);
  const dir = join(process.cwd(), "evaluation-results");
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${experimentId}.json`);
  writeFileSync(jsonPath, JSON.stringify({
    experimentId,
    seed,
    runs,
    plannedTrials: plans.length,
    outcomes: outcome.outcomes
  }, null, 2));
  process.stdout.write(`Experiment 03 live complete: ${outcome.completed.length}/${plans.length}.\n`);
}

