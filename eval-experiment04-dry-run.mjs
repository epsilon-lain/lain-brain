import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/Experiment04Definition';",
      "export { buildFrozenExperiment04ProviderMessages, renderExperiment04TreatmentPayload } from './src/Experiment04Instrument';",
      "export { validateExperiment04Preflight } from './src/Experiment04Preflight';"
    ].join("\n"),
    resolveDir: process.cwd(), sourcefile: "experiment04-dry-run-entry.ts", loader: "ts"
  },
  absWorkingDir: process.cwd(), bundle: true, platform: "node", format: "cjs", target: "es2021", write: false
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require, console });
const e = module.exports;
const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : e.canonicalize(value)).digest("hex");
const errors = e.validateExperiment04Preflight();
if (errors.length > 0) {
  process.stderr.write(`Experiment 04 preflight failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  const fixturesHash = sha(e.EXPERIMENT_04_FIXTURES);
  const manifestHash = sha(e.EXPERIMENT_04_TREATMENT_MANIFEST);
  const promptHash = sha(e.EXPERIMENT_04_COMMON_TASK_PROMPT);
  const schemaHash = sha(e.EXPERIMENT_04_RESPONSE_SCHEMA);
  const definition = { experimentId: e.EXPERIMENT_04_ID, seed: e.EXPERIMENT_04_SEED, repetitions: e.EXPERIMENT_04_REPETITIONS, provider: e.EXPERIMENT_04_PROVIDER, fixtures: e.EXPERIMENT_04_FIXTURES, conditions: e.EXPERIMENT_04_CONDITIONS, treatmentManifest: e.EXPERIMENT_04_TREATMENT_MANIFEST, taskPrompt: e.EXPERIMENT_04_COMMON_TASK_PROMPT, responseSchema: e.EXPERIMENT_04_RESPONSE_SCHEMA };
  const definitionHash = sha(definition);
  const plans = e.planExperiment04Trials();
  const auditDir = join(process.cwd(), "research-audit", "experiment04");
  mkdirSync(auditDir, { recursive: true });
  const rows = e.EXPERIMENT_04_FIXTURES.flatMap((fixture) => e.EXPERIMENT_04_CONDITIONS.map((condition) => {
    const payload = e.renderExperiment04TreatmentPayload(fixture, condition);
    const messages = e.buildFrozenExperiment04ProviderMessages(fixture, condition, e.EXPERIMENT_04_COMMON_TASK_PROMPT);
    return { fixtureId: fixture.fixtureId, condition, sourceHash: sha(fixture.sourceText), payloadHash: sha(payload ?? ""), contextChars: (payload ?? "").length, targetSemanticsPresent: condition === "plain_llm" || condition === "irrelevant_context" ? false : fixture.treatmentSufficiency.intendedTargetPresentInRelevantContext, expectedAbilityToGround: fixture.treatmentSufficiency.expectedAbilityToGround, ambiguityMustRemain: fixture.treatmentSufficiency.ambiguityMustRemain, finalRequestHash: sha(messages) };
  }));
  const freeze = { EXPERIMENT_04_DEFINITION_SHA256: definitionHash, fixtureTableSha256: fixturesHash, treatmentManifestSha256: manifestHash, commonTaskPromptSha256: promptHash, responseSchemaSha256: schemaHash, provider: e.EXPERIMENT_04_PROVIDER, fixtures: e.EXPERIMENT_04_FIXTURES.map((fixture) => ({ fixtureId: fixture.fixtureId, sourceSha256: sha(fixture.sourceText) })), trialCount: plans.length, seed: e.EXPERIMENT_04_SEED };
  writeFileSync(join(process.cwd(), "EXPERIMENT_04_FREEZE.json"), JSON.stringify(freeze, null, 2) + "\n");
  writeFileSync(join(auditDir, "treatment-sufficiency.json"), JSON.stringify(rows, null, 2) + "\n");
  const snapshots = e.EXPERIMENT_04_FIXTURES.map((fixture) => `## ${fixture.fixtureId}\n\n${e.EXPERIMENT_04_CONDITIONS.map((condition) => `### ${condition}\n\n\`\`\`text\n${e.buildFrozenExperiment04ProviderMessages(fixture, condition, e.EXPERIMENT_04_COMMON_TASK_PROMPT).map((message) => `${message.role}:\n${message.content}`).join("\n\n")}\n\`\`\``).join("\n\n")}`).join("\n\n");
  writeFileSync(join(auditDir, "provider-prompt-snapshots.md"), `# Experiment 04 Provider-visible Prompt Snapshots\n\nInternal experiment condition IDs are NOT model-visible; section headings are local audit metadata only.\n\n${snapshots}\n`);
  const representative = e.EXPERIMENT_04_FIXTURES.slice(0, 3).map((fixture) => `## ${fixture.fixtureId}\n\n${e.EXPERIMENT_04_CONDITIONS.map((condition) => `### ${condition}\n\n\`\`\`text\n${e.buildFrozenExperiment04ProviderMessages(fixture, condition, e.EXPERIMENT_04_COMMON_TASK_PROMPT).map((message) => `${message.role}:\n${message.content}`).join("\n\n")}\n\`\`\``).join("\n\n")}`).join("\n\n");
  writeFileSync(join(process.cwd(), "EXPERIMENT_04_PROMPT_AUDIT.md"), `# Experiment 04 Prompt Audit\n\nInternal experiment condition IDs are **NOT** model-visible. The complete offline snapshot set is at \`research-audit/experiment04/provider-prompt-snapshots.md\`. Only the semantic reference changes across conditions for a fixture; source text and common task prompt are byte-identical.\n\n${representative}\n`);
  const fixtureList = e.EXPERIMENT_04_FIXTURES.map((fixture) => `- \`${fixture.fixtureId}\` — ${fixture.sourceText}`).join("\n");
  writeFileSync(join(process.cwd(), "EXPERIMENT_04_PREREGISTRATION.md"), `# Experiment 04 Preregistration\n\n## Status\n\nFROZEN OFFLINE DESIGN. No provider request is authorized by this document. Experiment 03 remains an instrument/treatment validation failure; Experiment 04 is a corrected preregistered replication.\n\n## Research question and hypotheses\n\nDoes bounded synthetic Personal Brain semantic context improve locally verified grounding without increasing unsupported semantic commitments? H1: relevant identity/definition context improves verified grounding where personal meaning is required. H2: richer context can alter overreach in either direction. H3: no material advantage is expected for the precise logical fixture. H4: matched irrelevant material must not reproduce relevant grounding.\n\n## Frozen design\n\n- Definition SHA-256: \`${definitionHash}\`\n- Fixture table SHA-256: \`${fixturesHash}\`\n- Treatment manifest SHA-256: \`${manifestHash}\`\n- Common task prompt SHA-256: \`${promptHash}\`\n- Response schema SHA-256: \`${schemaHash}\`\n- Provider/model: ${e.EXPERIMENT_04_PROVIDER.provider} / ${e.EXPERIMENT_04_PROVIDER.model}\n- Seed: ${e.EXPERIMENT_04_SEED}\n- Repetitions: ${e.EXPERIMENT_04_REPETITIONS}\n- Trial count: ${e.EXPERIMENT_04_FIXTURES.length} fixtures × ${e.EXPERIMENT_04_CONDITIONS.length} conditions × ${e.EXPERIMENT_04_REPETITIONS} repetitions = ${plans.length}\n\n## Fixtures\n\n${fixtureList}\n\n## Conditions\n\nThe five local conditions are recorded only in local plans and results. Provider-visible prompts contain actual source text and, where applicable, condition-neutral semantic references. Plain has no reference; irrelevant has a non-target semantic object; identity has IDs/aliases/categories; definition adds bounded definitions; definition+relations adds only bounded fixture-relevant relations.\n\n## Outcomes and analysis\n\nPrimary outcomes: deterministic verified grounding accuracy and unsupported semantic-overreach count against each fixture's allowed commitment set. Secondary outcomes: ambiguity preservation, quantifier/relation/speech-act fidelity, missing-information recognition, invalid-output rate, and provider failure rate. Include only preflight-valid trials; exclude treatment-invalid outcomes; never impute or retry failures. Stop after all ${plans.length} planned trials or an explicit provider/environment failure. Report repeated runs separately with no significance testing.\n\n## Privacy and limits\n\nAll sources and semantic objects are synthetic; no Vault data or credentials are present. This small synthetic experiment cannot support a general superiority claim. Experiment 03 motivated label invisibility, real fixture freezing, prompt snapshots, and definition hashing.\n`);
  process.stdout.write(["Experiment 04 offline dry run", `Definition hash: ${definitionHash}`, `Fixtures: ${e.EXPERIMENT_04_FIXTURES.length}`, `Conditions: ${e.EXPERIMENT_04_CONDITIONS.join(", ")}`, `Repetitions: ${e.EXPERIMENT_04_REPETITIONS}`, `Planned trials: ${plans.length}`, `Seed: ${e.EXPERIMENT_04_SEED}`, `Provider/model: ${e.EXPERIMENT_04_PROVIDER.provider} / ${e.EXPERIMENT_04_PROVIDER.model}`, "Preflight: PASS", "Prompt-leak audit: PASS", "Network/provider requests: 0"].join("\n") + "\n");
}
