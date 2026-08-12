import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { LainBrainSession } from './src/LainBrainSession';",
      "export { createFormalizationRecord, applyFormalizationReview } from './src/FormalizationProtocol';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "accepted-lean-e2e-entry.ts",
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
  crypto: {
    randomUUID: () => "accepted-lean-e2e-" + Math.random().toString(36).slice(2, 8)
  },
  setTimeout,
  clearTimeout
});

const {
  LainBrainSession,
  createFormalizationRecord,
  applyFormalizationReview
} = module.exports;

const sourceText = "任意实数加零还是它自己。";
const leanBody = [
  "set_option autoImplicit false",
  "",
  "#check (∀ value : ℝ, value + 0 = value)"
].join("\n");
const expectedCode = [
  "import Mathlib.Data.Real.Basic",
  "",
  leanBody
].join("\n");

function makeCandidate() {
  return {
    id: "candidate-real-add-zero",
    title: "Real addition identity",
    primaryConcept: {
      name: "additive identity",
      aliases: ["addition by zero"]
    },
    markdown: "# Real addition identity",
    sourceMessageIds: ["message-user-real"],
    viewMode: "preview",
    userEdited: false,
    revision: 1,
    claims: [],
    formalizationIds: []
  };
}

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
    workspace: {
      getLeaf: () => ({ openFile: async () => {} })
    },
    metadataCache: { getFileCache: () => null }
  };
}

function makeAcceptedPreview(suggestionId) {
  const draft = createFormalizationRecord({
    claimId: suggestionId,
    sourceRefs: [{
      messageId: "message-user-real",
      snapshot: sourceText
    }],
    speechAct: "theorem_claim",
    objects: [{
      name: "ℝ",
      latex: "\\mathbb{R}",
      domain: "real numbers"
    }],
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
  const generationRequests = [];
  const runnerRequests = [];
  const session = new LainBrainSession(
    makeApp(),
    () => "test-api-key",
    () => null,
    { analyzeImage: async () => { throw new Error("Vision not expected"); } },
    async () => { throw new Error("Chat not expected"); },
    async () => [],
    async (_apiKey, request) => {
      generationRequests.push(request);
      return {
        leanCode: leanBody,
        notes: [],
        unresolvedMappings: []
      };
    }
  );

  session.candidates = [candidate];
  session.activeCandidateId = candidate.id;
  session.messages = [{
    id: "message-user-real",
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

  return { session, generationRequests, runnerRequests };
}

// Canonical Review Claims path: accepted ephemeral preview -> Apply ->
// committed formalization -> LeanArtifact -> LeanRunner -> committed status.
{
  const candidate = makeCandidate();
  const suggestion = {
    id: "claim-candidate-real-add-zero-suggestion",
    text: sourceText,
    kind: "formal_statement",
    verification: "lean_pending",
    sourceReferences: [],
    sourceMessageIds: ["message-user-real"]
  };
  const accepted = makeAcceptedPreview(suggestion.id);
  const { session, generationRequests, runnerRequests } = makeSession(
    candidate,
    async (request) => {
      assert.equal(request.code, expectedCode);
      return {
        status: "statement_typechecked",
        diagnostics: [],
        exitCode: 0,
        stdout: "∀ value : ℝ, value + 0 = value : Prop\n",
        stderr: ""
      };
    }
  );

  session.suggestionPreviews.set(suggestion.id, [{
    record: accepted,
    suggestionId: suggestion.id,
    sourceText: suggestion.text,
    sourceKind: suggestion.kind
  }]);

  assert.equal(Object.keys(session.formalizationIndex.records).length, 0);
  const applied = session.applyReviewedClaims(candidate.id, [suggestion]);
  assert.equal(applied.ok, true);
  assert.equal(session.getFormalizationPreviewsForSuggestion(suggestion.id).length, 0);

  const committedClaim = candidate.claims[0];
  assert.ok(committedClaim);
  assert.equal(committedClaim.primaryFormalizationId, accepted.id);

  const result = await session.generateAndRunLeanCheck(
    committedClaim.id,
    accepted.id
  );
  assert.equal(result.ok, true);
  assert.equal(generationRequests.length, 1);
  assert.equal(runnerRequests.length, 1);
  assert.deepEqual(Array.from(result.artifact.imports), [
    "Mathlib.Data.Real.Basic"
  ]);
  assert.equal(result.artifact.generatedCode, expectedCode);
  assert.equal(result.artifact.status, "statement_typechecked");

  const committedFormalization = session.getFormalization(accepted.id);
  assert.equal(
    committedFormalization.verificationStatus,
    "statement_typechecked"
  );
  assert.notEqual(committedFormalization.verificationStatus, "proof_verified");
  assert.equal(committedFormalization.leanStatement, expectedCode);

  console.log("ACCEPTED-LEAN-E2E-1 PASS: Apply reaches statement_typechecked with narrow import");
}

// Failed Lean verification preserves detailed diagnostics and never upgrades
// the committed formalization to proof_verified or statement_typechecked.
{
  const candidate = makeCandidate();
  const suggestion = {
    id: "claim-candidate-real-add-zero-failure",
    text: sourceText,
    kind: "formal_statement",
    verification: "lean_pending",
    sourceReferences: [],
    sourceMessageIds: ["message-user-real"]
  };
  const accepted = makeAcceptedPreview(suggestion.id);
  const { session } = makeSession(candidate, async () => ({
    status: "error",
    diagnostics: [{
      severity: "error",
      message: "unknown identifier 'value'",
      line: 5,
      column: 18
    }],
    exitCode: 1,
    stdout: "",
    stderr: "Main.lean:5:18: error: unknown identifier 'value'"
  }));

  session.suggestionPreviews.set(suggestion.id, [{
    record: accepted,
    suggestionId: suggestion.id,
    sourceText: suggestion.text,
    sourceKind: suggestion.kind
  }]);
  assert.equal(session.applyReviewedClaims(candidate.id, [suggestion]).ok, true);

  const result = await session.generateAndRunLeanCheck(
    suggestion.id,
    accepted.id
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "Lean statement check failed.");
  assert.equal(result.diagnostics[0].line, 5);
  assert.ok(result.diagnostics[0].message.includes("unknown identifier"));
  assert.equal(
    session.getFormalization(accepted.id).verificationStatus,
    "not_checked"
  );

  console.log("ACCEPTED-LEAN-E2E-2 PASS: failed check exposes diagnostics without verification upgrade");
}

console.log(JSON.stringify({
  acceptedApplyToLeanArtifactToRunner: true,
  canonicalRealStatementUsesNarrowImport: true,
  statementTypecheckedIsNotProofVerified: true,
  failureDiagnosticsPreserved: true,
  result: "PASS"
}, null, 2));
