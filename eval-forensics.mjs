import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const resultsDir = join(process.cwd(), "evaluation-results");
const jsonPath = join(resultsDir, "semantic-fidelity-live-1786896465176.json");
const mdPath = join(resultsDir, "semantic-fidelity-live-1786896465176.md");
const data = JSON.parse(readFileSync(jsonPath, "utf8"));

const cases = [
  {
    id: "personal-definition",
    expectedBindings: [{ surfacePhrase: "X", conceptId: "concept-personal-x" }]
  },
  {
    id: "overloaded-term",
    expectedBindings: [{ surfacePhrase: "field", conceptId: "concept-field-synthetic" }]
  },
  { id: "universal", expectedQuantifier: "universal" },
  {
    id: "implication",
    expectedRelations: ["implication"],
    forbiddenRelations: ["equivalence"]
  },
  { id: "ambiguity", expectedAmbiguity: "preserve" },
  { id: "missing-assumption", expectedMissingConditions: ["finite-dimensionality"] },
  { id: "proof-sketch", expectedSpeechAct: "proof_sketch" },
  { id: "no-advantage", expectedQuantifier: "universal" }
];

function sha(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function normId(id) {
  return typeof id === "string" ? id.replace(/@\d+$/, "") : undefined;
}

function bindingScore(result, caseDef) {
  const expected = caseDef.expectedBindings ?? [];
  if (expected.length === 0) {
    return { correct: 0, wrong: 0, unresolved: 0, total: 0, accuracy: undefined };
  }
  let correct = 0, wrong = 0, unresolved = 0;
  for (const exp of expected) {
    const found = (result.conceptBindings ?? []).find(
      (b) => b.surfacePhrase === exp.surfacePhrase
    );
    if (!found || found.status !== "resolved") {
      unresolved += 1;
    } else if (normId(found.conceptId) === exp.conceptId) {
      correct += 1;
    } else {
      wrong += 1;
    }
  }
  return {
    correct,
    wrong,
    unresolved,
    total: expected.length,
    accuracy: expected.length ? correct / expected.length : undefined
  };
}

function metrics(result, caseDef) {
  const bind = bindingScore(result, caseDef);
  const quantifierDrift =
    caseDef.expectedQuantifier !== undefined &&
    result.quantifier !== undefined &&
    result.quantifier !== caseDef.expectedQuantifier ? 1 : 0;
  const relationViolations = (caseDef.forbiddenRelations ?? [])
    .filter((rel) => (result.relations ?? []).includes(rel)).length;
  const unsupported = (result.addedImplicitAssumptions ?? []).length;
  const missingExpected = caseDef.expectedMissingConditions ?? [];
  const identifiedMissing = (result.missingConditions ?? []).filter(
    (c) => missingExpected.includes(c)
  ).length;
  const ambiguityError =
    caseDef.expectedAmbiguity === "preserve" &&
    (result.ambiguities ?? []).length === 0 &&
    !(result.conceptBindings ?? []).some(
      (b) => b.status === "ambiguous" || b.status === "unresolved"
    ) ? 1 : 0;
  const speechMismatch =
    caseDef.expectedSpeechAct !== undefined &&
    result.speechAct !== caseDef.expectedSpeechAct ? 1 : 0;
  const correctionUnits =
    bind.wrong + bind.unresolved + quantifierDrift + relationViolations +
    unsupported + Math.max(0, missingExpected.length - identifiedMissing) +
    ambiguityError + speechMismatch;
  const violations =
    relationViolations + unsupported + quantifierDrift + ambiguityError + speechMismatch;
  return {
    bind,
    quantifierDrift,
    relationViolations,
    unsupported,
    missingIdentified: identifiedMissing,
    ambiguityError,
    speechMismatch,
    correctionUnits,
    violations
  };
}

function aggregate(outcomes) {
  const values = outcomes.map((o) => metrics(o.result, cases.find((c) => c.id === o.plan.caseId)));
  const valid = values;
  return {
    n: values.length,
    quantifierDrift: values.reduce((s, m) => s + m.quantifierDrift, 0),
    relationViolations: values.reduce((s, m) => s + m.relationViolations, 0),
    unsupported: values.reduce((s, m) => s + m.unsupported, 0),
    ambiguityErrors: values.reduce((s, m) => s + m.ambiguityError, 0),
    speechMismatch: values.reduce((s, m) => s + m.speechMismatch, 0),
    violations: values.reduce((s, m) => s + m.violations, 0),
    meanCorrection: values.reduce((s, m) => s + m.correctionUnits, 0) / (values.length || 1),
    medianCorrection: median(values.map((m) => m.correctionUnits)),
    bindingCorrect: values.reduce((s, m) => s + m.bind.correct, 0),
    bindingWrong: values.reduce((s, m) => s + m.bind.wrong, 0),
    bindingUnresolved: values.reduce((s, m) => s + m.bind.unresolved, 0),
    bindingScored: values.filter((m) => m.bind.total > 0).length
  };
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function caseTrend(caseId) {
  const outs = data.outcomes.filter((o) => o.plan.caseId === caseId);
  const byRun = new Map();
  for (const o of outs) {
    const key = o.plan.runIndex;
    if (!byRun.has(key)) byRun.set(key, {});
    byRun.get(key)[o.plan.condition] = o.result;
  }
  const diffs = [];
  for (const [run, pair] of byRun) {
    if (pair.plain_llm && pair.personal_brain) {
      const p = metrics(pair.plain_llm, cases.find((c) => c.id === caseId));
      const b = metrics(pair.personal_brain, cases.find((c) => c.id === caseId));
      diffs.push({
        run,
        correctionDelta: b.correctionUnits - p.correctionUnits,
        violationDelta: b.violations - p.violations
      });
    }
  }
  if (!diffs.length) return "incomplete";
  const improved = diffs.every((d) => d.correctionDelta < 0 && d.violationDelta <= 0);
  const regressed = diffs.every((d) => d.correctionDelta > 0 && d.violationDelta >= 0);
  const same = diffs.every((d) => d.correctionDelta === 0 && d.violationDelta === 0);
  if (improved) return "brain_improved";
  if (regressed) return "brain_regressed";
  if (same) {
    const avg = diffs.length ? diffs[0] : null;
    return avg ? "unchanged_both_same" : "unchanged";
  }
  return "mixed";
}

function renderMarkdown() {
  const plainOuts = data.outcomes.filter((o) => o.plan.condition === "plain_llm");
  const brainOuts = data.outcomes.filter((o) => o.plan.condition === "personal_brain");
  const plainAgg = aggregate(plainOuts);
  const brainAgg = aggregate(brainOuts);

  const lines = [];
  lines.push("# EVAL02 Forensic Analysis");
  lines.push("");
  lines.push("## Immutable inputs");
  lines.push(`- JSON SHA-256: \`${sha(jsonPath)}\``);
  lines.push(`- Markdown SHA-256: \`${sha(mdPath)}\``);
  lines.push("");
  lines.push("## Integrity");
  lines.push(`- Planned: ${data.plannedTrials}`);
  lines.push(`- Completed: ${data.completedTrials}`);
  lines.push(`- Failed: ${data.failures.length}`);
  for (const failure of data.failures) {
    lines.push(`- Missing trial: \`${failure.trialId}\` (${failure.error})`);
  }
  lines.push(`- Plain completed: ${plainOuts.length}`);
  lines.push(`- Brain completed: ${brainOuts.length}`);
  lines.push("");
  lines.push("## Repeated-run-aware component metrics");
  lines.push("");
  lines.push("| Metric | Plain LLM | Personal Brain |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| Completed runs | ${plainAgg.n} | ${brainAgg.n} |`);
  lines.push(`| Quantifier drift | ${plainAgg.quantifierDrift} | ${brainAgg.quantifierDrift} |`);
  lines.push(`| Relation violations | ${plainAgg.relationViolations} | ${brainAgg.relationViolations} |`);
  lines.push(`| Unsupported assumptions | ${plainAgg.unsupported} | ${brainAgg.unsupported} |`);
  lines.push(`| Ambiguity errors | ${plainAgg.ambiguityErrors} | ${brainAgg.ambiguityErrors} |`);
  lines.push(`| Speech-act mismatches | ${plainAgg.speechMismatch} | ${brainAgg.speechMismatch} |`);
  lines.push(`| Semantic violations | ${plainAgg.violations} | ${brainAgg.violations} |`);
  lines.push(`| Mean correction burden | ${plainAgg.meanCorrection.toFixed(2)} | ${brainAgg.meanCorrection.toFixed(2)} |`);
  lines.push(`| Median correction burden | ${plainAgg.medianCorrection.toFixed(2)} | ${brainAgg.medianCorrection.toFixed(2)} |`);
  lines.push(`| Verified binding correct | ${plainAgg.bindingCorrect} | ${brainAgg.bindingCorrect} |`);
  lines.push(`| Model-invented/wrong bindings | ${plainAgg.bindingWrong} | ${brainAgg.bindingWrong} |`);
  lines.push(`| Unresolved bindings | ${plainAgg.bindingUnresolved} | ${brainAgg.bindingUnresolved} |`);
  lines.push("");
  lines.push("## Case trend taxonomy");
  for (const caseDef of cases) {
    lines.push(`- ${caseDef.id}: ${caseTrend(caseDef.id)}`);
  }
  lines.push("");
  lines.push("This is a post-hoc, repeated-run-aware reanalysis. It is NOT a pre-registered claim.");
  return lines.join("\n");
}

const forensicPath = join(process.cwd(), "EVAL02_FORENSIC_ANALYSIS.md");
writeFileSync(forensicPath, renderMarkdown());
console.log("Wrote", forensicPath);
console.log("v1 md:\n" + readFileSync(mdPath, "utf8"));
console.log("v2 markdown:\n" + renderMarkdown());

