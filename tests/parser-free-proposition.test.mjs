import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { LainBrainSession } from './src/LainBrainSession';",
      "export { createFormalizationRecord, applyFormalizationReview } from './src/FormalizationProtocol';",
      "export {",
      "  validateCanonicalLeanProposition,",
      "  buildLeanStatementCheckSource,",
      "  createLeanFormalizationTarget",
      "} from './src/LeanProofWorkspace';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "parser-free-proposition-entry.ts",
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
          "exports.requestUrl = async () => { throw new Error('Unexpected network request'); };"
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  DOMMatrix: class { constructor(){} },
  module,
  exports: module.exports,
  require,
  console,
  URL,
  crypto: { randomUUID: () => "parser-free-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  LainBrainSession,
  createFormalizationRecord,
  applyFormalizationReview,
  validateCanonicalLeanProposition,
  buildLeanStatementCheckSource,
  createLeanFormalizationTarget
} = module.exports;

// ── Pure proposition-boundary validation ───────────────────────────────
assert.equal(
  Array.from(validateCanonicalLeanProposition("∀ n : Nat, n + 0 = n")).length,
  0
);
for (const bad of [
  "#check (∀ n : Nat, n + 0 = n)",
  "theorem foo : P := by trivial",
  "lemma foo : P := by exact trivial",
  "```lean\nP\n```",
  "import Mathlib\nP",
  "axiom magic : P",
  "",
  "   ",
  "sorry"
]) {
  assert.ok(
    validateCanonicalLeanProposition(bad).length > 0,
    `should reject: ${JSON.stringify(bad)}`
  );
}
console.log("PURE-1 PASS: proposition boundary validation");

// ── Deterministic statement source projection ─────────────────────────
const target = createLeanFormalizationTarget({
  formalizationId: "formalization-1",
  propositionText: "∀ value : ℝ, value + 0 = value",
  imports: ["Mathlib.Data.Real.Basic"],
  provenance: "structured_generation"
});
const source = buildLeanStatementCheckSource(target);
assert.equal(
  source,
  "import Mathlib.Data.Real.Basic\n\n" +
  "set_option autoImplicit false\n\n" +
  "#check (∀ value : ℝ, value + 0 = value)"
);
console.log("PURE-2 PASS: deterministic statement-check source");

// ── New-path session flow uses structured proposition ──────────────────
const sourceText = "任意实数加零还是它自己。";
const proposition = "∀ value : ℝ, value + 0 = value";

function makeApp() {
  return {
    vault: {
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null,
      getFileByPath: () => null,
      getFolderByPath: () => null,
      cachedRead: async () => "",
      read: async () => ""
    },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) },
    metadataCache: { getFileCache: () => null }
  };
}

function makeCandidate() {
  return {
    id: "candidate-structured-prop",
    title: "Real addition identity",
    primaryConcept: { name: "additive identity", aliases: ["addition by zero"] },
    markdown: "# Real addition identity",
    sourceMessageIds: ["message-user-structured"],
    viewMode: "preview",
    userEdited: false,
    revision: 1,
    claims: [],
    formalizationIds: []
  };
}

function makeAcceptedPreview(suggestionId) {
  const draft = createFormalizationRecord({
    claimId: suggestionId,
    sourceRefs: [{ messageId: "message-user-structured", snapshot: sourceText }],
    speechAct: "theorem_claim",
    objects: [{ name: "ℝ", latex: "\\mathbb{R}", domain: "real numbers" }],
    explicitAssumptions: [],
    implicitAssumptions: [],
    quantifiers: "∀ value : ℝ",
    conclusion: "value + 0 = value",
    ambiguities: [],
    missingConditions: [],
    semanticChanges: [],
    aiNormalizedStatement: "∀ value : ℝ, value + 0 = value",
    latexStatement: "\\forall value \\in \\mathbb{R}, value + 0 = value"
  });
  return applyFormalizationReview(draft, "accepted");
}

function makeSession(candidate, runner) {
  const runnerRequests = [];
  const session = new LainBrainSession(
    makeApp(),
    () => "test-api-key",
    () => null,
    { analyzeImage: async () => { throw new Error("Vision not expected"); } },
    async () => { throw new Error("Chat not expected"); },
    async () => [],
    async (_apiKey, _request) => ({
      proposition,
      notes: [],
      unresolvedMappings: []
    })
  );
  session.candidates = [candidate];
  session.activeCandidateId = candidate.id;
  session.messages = [{
    id: "message-user-structured",
    role: "user",
    content: sourceText,
    includeInHistory: true
  }];
  session.setLeanRunner({
    async check(request) {
      runnerRequests.push(request);
      return runner(request);
    }
  });
  return { session, runnerRequests };
}

{
  const candidate = makeCandidate();
  const suggestion = {
    id: "claim-candidate-structured-prop-suggestion",
    text: sourceText,
    kind: "formal_statement",
    verification: "lean_pending",
    sourceReferences: [],
    sourceMessageIds: ["message-user-structured"]
  };
  const accepted = makeAcceptedPreview(suggestion.id);
  const { session, runnerRequests } = makeSession(candidate, async (request) => {
    assert.match(request.code, /#check \(∀ value : ℝ, value \+ 0 = value\)/);
    return {
      status: "statement_typechecked",
      diagnostics: [],
      exitCode: 0,
      stdout: "∀ value : ℝ, value + 0 = value : Prop\n",
      stderr: ""
    };
  });

  session.suggestionPreviews.set(suggestion.id, [{
    record: accepted,
    suggestionId: suggestion.id,
    sourceText: suggestion.text,
    sourceKind: suggestion.kind
  }]);
  const applied = session.applyReviewedClaims(candidate.id, [suggestion]);
  assert.equal(applied.ok, true);

  const committedClaim = candidate.claims[0];
  assert.equal(committedClaim.primaryFormalizationId, accepted.id);
  const result = await session.generateAndRunLeanCheck(
    committedClaim.id,
    accepted.id
  );
  assert.equal(result.ok, true);
  assert.equal(runnerRequests.length, 1);

  const canonicalTarget = session.getLeanFormalizationTarget(accepted.id);
  assert.ok(canonicalTarget);
  assert.equal(canonicalTarget.propositionText, proposition);
  assert.equal(canonicalTarget.provenance, "structured_generation");
  assert.doesNotMatch(result.artifact.generatedCode, /theorem|lemma/);
  console.log("SESSION-1 PASS: new path uses structured proposition");
}

console.log("parser-free-proposition.test.mjs PASS");
