import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

// Experiment 04R OFFLINE-ONLY dry run.
//
// This script makes ZERO network/provider requests. It bundles the frozen
// TypeScript modules in memory, validates them, and writes local audit
// artifacts only. It fails closed: any preflight or audit error aborts
// before any artifact is written. It does NOT authorize any live run.

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/Experiment04RDefinition';",
      "export { buildFrozenExperiment04RProviderMessages, renderExperiment04RTreatmentPayload } from './src/Experiment04RInstrument';",
      "export { validateExperiment04RPreflight } from './src/Experiment04RPreflight';",
      "export { EXPERIMENT_04R_AUDIT_MANIFEST, validateExperiment04RAuditCoverage, findForbiddenFragmentsInText, findEvaluatorMetadataLeaks } from './src/Experiment04RAudit';"
    ].join("\n"),
    resolveDir: process.cwd(), sourcefile: "experiment04r-dry-run-entry.ts", loader: "ts"
  },
  absWorkingDir: process.cwd(), bundle: true, platform: "node", format: "cjs", target: "es2021", write: false
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require, console });
const e = module.exports;
const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : e.canonicalize(value)).digest("hex");

// ---------------------------------------------------------------------------
// Gates (fail closed). No artifact is written unless every gate passes.
// ---------------------------------------------------------------------------

const preflightErrors = e.validateExperiment04RPreflight();
if (preflightErrors.length > 0) {
  process.stderr.write(`Experiment 04R preflight FAILED:\n${preflightErrors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exit(1);
}

const auditErrors = e.validateExperiment04RAuditCoverage(e.EXPERIMENT_04R_FIXTURES.map((fixture) => fixture.fixtureId));
if (auditErrors.length > 0) {
  process.stderr.write(`Experiment 04R answer-bearing-context audit FAILED:\n${auditErrors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exit(1);
}

const leakRows = [];
const promptLeakErrors = [];
for (const fixture of e.EXPERIMENT_04R_FIXTURES) {
  for (const condition of e.EXPERIMENT_04R_CONDITIONS) {
    const messages = e.buildFrozenExperiment04RProviderMessages(fixture, condition, e.EXPERIMENT_04R_COMMON_TASK_PROMPT);
    const prompt = messages.map((message) => message.content).join("\n");
    const fragments = e.findForbiddenFragmentsInText(prompt);
    const metadataLeaks = e.findEvaluatorMetadataLeaks(fixture, messages);
    leakRows.push({ fixtureId: fixture.fixtureId, condition, noForbiddenFragments: fragments.length === 0, noEvaluatorMetadataLeaks: metadataLeaks.length === 0, forbiddenFragments: fragments, evaluatorMetadataLeaks: metadataLeaks });
    if (fragments.length > 0) promptLeakErrors.push(`${fixture.fixtureId}:${condition}: forbidden fragment(s) ${fragments.join(", ")}.`);
    if (metadataLeaks.length > 0) promptLeakErrors.push(`${fixture.fixtureId}:${condition}: evaluator metadata leak(s) ${metadataLeaks.join(", ")}.`);
  }
}
if (promptLeakErrors.length > 0) {
  process.stderr.write(`Experiment 04R prompt-leak audit FAILED:\n${promptLeakErrors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Deterministic hashes.
// ---------------------------------------------------------------------------

const definition = {
  experimentId: e.EXPERIMENT_04R_ID,
  seed: e.EXPERIMENT_04R_SEED,
  repetitions: e.EXPERIMENT_04R_REPETITIONS,
  provider: e.EXPERIMENT_04R_PROVIDER,
  fixtures: e.EXPERIMENT_04R_FIXTURES,
  conditions: e.EXPERIMENT_04R_CONDITIONS,
  treatmentManifest: e.EXPERIMENT_04R_TREATMENT_MANIFEST,
  taskPrompt: e.EXPERIMENT_04R_COMMON_TASK_PROMPT,
  responseSchema: e.EXPERIMENT_04R_RESPONSE_SCHEMA
};
const definitionHash = sha(definition);
const fixturesHash = sha(e.EXPERIMENT_04R_FIXTURES);
const manifestHash = sha(e.EXPERIMENT_04R_TREATMENT_MANIFEST);
const promptHash = sha(e.EXPERIMENT_04R_COMMON_TASK_PROMPT);
const schemaHash = sha(e.EXPERIMENT_04R_RESPONSE_SCHEMA);
const auditManifestHash = sha(e.EXPERIMENT_04R_AUDIT_MANIFEST);
const plans = e.planExperiment04RTrials();

// ---------------------------------------------------------------------------
// Local audit artifacts.
// ---------------------------------------------------------------------------

const auditDir = join(process.cwd(), "research-audit", "experiment04r");
mkdirSync(auditDir, { recursive: true });

const treatmentRows = e.EXPERIMENT_04R_FIXTURES.flatMap((fixture) => e.EXPERIMENT_04R_CONDITIONS.map((condition) => {
  const payload = e.renderExperiment04RTreatmentPayload(fixture, condition);
  const messages = e.buildFrozenExperiment04RProviderMessages(fixture, condition, e.EXPERIMENT_04R_COMMON_TASK_PROMPT);
  const leak = leakRows.find((row) => row.fixtureId === fixture.fixtureId && row.condition === condition);
  return {
    fixtureId: fixture.fixtureId,
    condition,
    sourceHash: sha(fixture.sourceText),
    payloadHash: sha(payload ?? ""),
    contextChars: (payload ?? "").length,
    targetSemanticsPresent: condition === "plain_llm" || condition === "irrelevant_context" ? false : fixture.treatmentSufficiency.intendedTargetPresentInRelevantContext,
    expectedAbilityToGround: fixture.treatmentSufficiency.expectedAbilityToGround,
    ambiguityMustRemain: fixture.treatmentSufficiency.ambiguityMustRemain,
    auditFlags: { noForbiddenFragments: leak.noForbiddenFragments, noEvaluatorMetadataLeaks: leak.noEvaluatorMetadataLeaks },
    finalRequestHash: sha(messages)
  };
}));

const freeze = {
  EXPERIMENT_04R_DEFINITION_SHA256: definitionHash,
  fixtureTableSha256: fixturesHash,
  treatmentManifestSha256: manifestHash,
  commonTaskPromptSha256: promptHash,
  responseSchemaSha256: schemaHash,
  auditManifestSha256: auditManifestHash,
  provider: e.EXPERIMENT_04R_PROVIDER,
  fixtures: e.EXPERIMENT_04R_FIXTURES.map((fixture) => {
    const audit = e.EXPERIMENT_04R_AUDIT_MANIFEST.find((entry) => entry.fixtureId === fixture.fixtureId);
    return {
      fixtureId: fixture.fixtureId,
      sourceSha256: sha(fixture.sourceText),
      auditGates: {
        definitionSourceIndependent: audit.definitionSourceIndependent,
        relationsSourceIndependent: audit.relationsSourceIndependent,
        noSpeechActLeakage: audit.noSpeechActLeakage,
        noMissingConditionLeakage: audit.noMissingConditionLeakage,
        noRevisionAnswerLeakage: audit.noRevisionAnswerLeakage
      }
    };
  }),
  trialCount: plans.length,
  seed: e.EXPERIMENT_04R_SEED
};
writeFileSync(join(process.cwd(), "EXPERIMENT_04R_FREEZE.json"), JSON.stringify(freeze, null, 2) + "\n");

writeFileSync(join(auditDir, "treatment-sufficiency.json"), JSON.stringify({
  experimentId: e.EXPERIMENT_04R_ID,
  auditManifestSha256: auditManifestHash,
  trialCount: plans.length,
  seed: e.EXPERIMENT_04R_SEED,
  rows: treatmentRows,
  auditManifest: e.EXPERIMENT_04R_AUDIT_MANIFEST
}, null, 2) + "\n");

const snapshots = e.EXPERIMENT_04R_FIXTURES.map((fixture) => `## ${fixture.fixtureId}\n\n${e.EXPERIMENT_04R_CONDITIONS.map((condition) => `### ${condition}\n\n\`\`\`text\n${e.buildFrozenExperiment04RProviderMessages(fixture, condition, e.EXPERIMENT_04R_COMMON_TASK_PROMPT).map((message) => `${message.role}:\n${message.content}`).join("\n\n")}\n\`\`\``).join("\n\n")}`).join("\n\n");
writeFileSync(join(auditDir, "provider-prompt-snapshots.md"), `# Experiment 04R Provider-visible Prompt Snapshots\n\nInternal experiment condition IDs, fixture IDs, and evaluator metadata are NOT model-visible; section headings are local audit metadata only.\n\n${snapshots}\n`);

const representative = e.EXPERIMENT_04R_FIXTURES.slice(0, 3).map((fixture) => `## ${fixture.fixtureId}\n\n${e.EXPERIMENT_04R_CONDITIONS.map((condition) => `### ${condition}\n\n\`\`\`text\n${e.buildFrozenExperiment04RProviderMessages(fixture, condition, e.EXPERIMENT_04R_COMMON_TASK_PROMPT).map((message) => `${message.role}:\n${message.content}`).join("\n\n")}\n\`\`\``).join("\n\n")}`).join("\n\n");
writeFileSync(join(process.cwd(), "EXPERIMENT_04R_PROMPT_AUDIT.md"), `# Experiment 04R Prompt Audit\n\nInternal experiment condition IDs, fixture IDs, and evaluator metadata are **NOT** model-visible. The complete offline snapshot set is at \`research-audit/experiment04r/provider-prompt-snapshots.md\`. Only the semantic reference changes across conditions for a fixture; source text and common task prompt are byte-identical.\n\nAnswer-bearing-context audit: PASS. Prompt-leak audit (forbidden fragments + evaluator metadata): PASS. Audit manifest SHA-256: \`${auditManifestHash}\`.\n\n${representative}\n`);

const fixtureList = e.EXPERIMENT_04R_FIXTURES.map((fixture) => `- \`${fixture.fixtureId}\` — ${fixture.sourceText}`).join("\n");
const auditList = e.EXPERIMENT_04R_AUDIT_MANIFEST.map((entry) => `- \`${entry.fixtureId}\`: ${entry.reviewerRationale}`).join("\n");
writeFileSync(join(process.cwd(), "EXPERIMENT_04R_PREREGISTRATION.md"), `# Experiment 04R Preregistration\n\n## Status\n\nFROZEN OFFLINE DESIGN. No provider request is authorized by this document.\n\n## Why Experiment 04R exists\n\nExperiment 04 (\`experiment04-semantic-fidelity-v1\`) was blocked pre-live by human review due to answer-bearing-context confounding: several provider-visible semantic definitions/relations conflated useful Personal Brain context with directly supplying the scored answer. Experiment 04 made zero provider calls; no Experiment 04 live result exists and none is implied. The original Experiment 04 files and artifacts remain frozen and unchanged as historical evidence of that failure.\n\nExperiment 04R (\`experiment04-semantic-fidelity-v1-r1\`) is a new frozen revision: the same 12 fixtures, 5 conditions, 3 repetitions, seed, and provider/model, with de-leaked treatment content, a typed per-fixture answer-bearing-context audit manifest, deterministic forbidden-fragment regression guards, and hard evaluator-metadata-absence preflight checks.\n\n## Research question and hypotheses\n\nDoes bounded synthetic Personal Brain semantic context improve locally verified grounding without increasing unsupported semantic commitments? H1: relevant identity/definition context improves verified grounding where personal meaning is required. H2: richer context can alter overreach in either direction. H3: no material advantage is expected for the precise logical fixture. H4: matched irrelevant material must not reproduce relevant grounding.\n\n## Frozen design\n\n- Definition SHA-256: \`${definitionHash}\`\n- Fixture table SHA-256: \`${fixturesHash}\`\n- Treatment manifest SHA-256: \`${manifestHash}\`\n- Common task prompt SHA-256: \`${promptHash}\`\n- Response schema SHA-256: \`${schemaHash}\`\n- Answer-bearing-context audit manifest SHA-256: \`${auditManifestHash}\`\n- Provider/model: ${e.EXPERIMENT_04R_PROVIDER.provider} / ${e.EXPERIMENT_04R_PROVIDER.model}\n- Seed: ${e.EXPERIMENT_04R_SEED}\n- Repetitions: ${e.EXPERIMENT_04R_REPETITIONS}\n- Trial count: ${e.EXPERIMENT_04R_FIXTURES.length} fixtures × ${e.EXPERIMENT_04R_CONDITIONS.length} conditions × ${e.EXPERIMENT_04R_REPETITIONS} repetitions = ${plans.length}\n\n## Fixtures\n\n${fixtureList}\n\n## Conditions\n\nThe five local conditions are recorded only in local plans and results. Provider-visible prompts contain actual source text and, where applicable, condition-neutral semantic references. Plain has no reference; irrelevant has a non-target semantic object; identity has IDs/aliases/categories; definition adds bounded definitions; definition+relations adds only bounded fixture-relevant relations.\n\n## Answer-bearing-context audit\n\nEvery fixture has exactly one human-reviewed audit entry; all gates (definitionSourceIndependent, relationsSourceIndependent, noSpeechActLeakage, noMissingConditionLeakage, noRevisionAnswerLeakage) are true before preflight can pass. Deterministic forbidden-fragment and evaluator-metadata-absence checks run over every provider-visible rendered message; they are regression guards only and are not a substitute for human review.\n\n${auditList}\n\n## Outcomes and analysis\n\nPrimary outcomes: deterministic verified grounding accuracy and unsupported semantic-overreach count against each fixture's allowed commitment set. Secondary outcomes: ambiguity preservation, quantifier/relation/speech-act fidelity, missing-information recognition, invalid-output rate, and provider failure rate. Include only preflight-valid trials; exclude treatment-invalid outcomes; never impute or retry failures. Stop after all ${plans.length} planned trials or an explicit provider/environment failure. Report repeated runs separately with no significance testing.\n\n## Privacy and limits\n\nAll sources and semantic objects are synthetic; no Vault data or credentials are present. This small synthetic experiment cannot support a general superiority claim. Experiment 04's human-review block motivated the 04R answer-bearing-context audit manifest and leak gates.\n\n## Authorization\n\nThis offline dry run made zero provider/network requests and authorizes nothing. No Experiment 04R live request is authorized merely by the offline dry run; any live run requires separate, explicit human approval.\n`);

process.stdout.write(["Experiment 04R offline dry run", `Definition hash: ${definitionHash}`, `Fixtures: ${e.EXPERIMENT_04R_FIXTURES.length}`, `Conditions: ${e.EXPERIMENT_04R_CONDITIONS.join(", ")}`, `Repetitions: ${e.EXPERIMENT_04R_REPETITIONS}`, `Planned trials: ${plans.length}`, `Seed: ${e.EXPERIMENT_04R_SEED}`, `Provider/model: ${e.EXPERIMENT_04R_PROVIDER.provider} / ${e.EXPERIMENT_04R_PROVIDER.model}`, "Preflight: PASS", "Answer-bearing-context audit: PASS", "Prompt-leak audit: PASS", "Network/provider requests: 0"].join("\n") + "\n");
