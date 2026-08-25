import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,",
      "  renderExperiment03DryRun,",
      "  planExperiment03Trials",
      "} from './src/SemanticFidelityV2';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "experiment03-dry-run-entry.ts",
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
  crypto: { randomUUID: () => "e03-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  SEMANTIC_FIDELITY_V2_SCHEMA_VERSION,
  renderExperiment03DryRun,
  planExperiment03Trials
} = module.exports;

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
  rationale: "Experiment 03 synthetic fixture",
  treatmentManifest: {
    condition: "plain_llm",
    suppliedContext: "none"
  }
}));

const plans = planExperiment03Trials(cases, "experiment-03-dry", 3, 12345);
process.stdout.write(renderExperiment03DryRun(cases, "experiment-03-dry", 3, 12345) + "\n");
if (plans.length !== 180) {
  process.exitCode = 1;
  process.stderr.write(`Unexpected trial count ${plans.length}\n`);
}

