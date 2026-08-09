import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { LainBrainSession } from './src/LainBrainSession';",
      "export {",
      "  getClaimVerification,",
      "  normalizeClaimSuggestion,",
      "  normalizeReviewedClaim,",
      "  parseClaimSuggestionsJson",
      "} from './src/ClaimClassification';",
      "export {",
      "  createFormalizationRecord,",
      "  applyFormalizationReview",
      "} from './src/FormalizationProtocol';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "claim-classification-entry.ts",
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
  module,
  exports: module.exports,
  require,
  console,
  URL,
  Blob,
  crypto: { randomUUID: () => "test-id" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  setTimeout,
  clearTimeout
});
const {
  getClaimVerification,
  LainBrainSession,
  normalizeClaimSuggestion,
  normalizeReviewedClaim,
  parseClaimSuggestionsJson,
  createFormalizationRecord,
  applyFormalizationReview
} = module.exports;

const personal = normalizeReviewedClaim({
  id: "claim-candidate-a-personal",
  text: "I understand the operator as a geometric transformation.",
  kind: "personal_interpretation",
  verification: "source_pending",
  sourceReferences: [],
  sourceMessageIds: ["message-1"]
}, undefined, "2026-08-05T00:00:00.000Z");
assert.equal(personal.kind, "personal_interpretation");
assert.equal(personal.verification, "user_authored");
assert.equal(personal.text, "I understand the operator as a geometric transformation.");

const unsupportedFact = normalizeClaimSuggestion({
  text: "Every bounded operator has the stated property.",
  kind: "factual_claim",
  verification: "source_cited",
  sourceReferences: ["Invented Source"],
  sourceMessageIds: ["message-2"]
}, new Set(["message-2"]), "No cited source appears here.");
assert.equal(unsupportedFact.verification, "source_pending");
assert.deepEqual([...unsupportedFact.sourceReferences], []);
const citedFact = normalizeClaimSuggestion({
  text: "The cited statement appears in the supplied source.",
  kind: "factual_claim",
  verification: "source_cited",
  sourceReferences: ["https://example.test/source"],
  sourceMessageIds: ["message-2"]
}, new Set(["message-2"]), "See https://example.test/source");
assert.equal(citedFact.verification, "source_cited");
assert.deepEqual(
  [...citedFact.sourceReferences],
  ["https://example.test/source"]
);
assert.equal(
  getClaimVerification("formal_statement", [], "lean_checked"),
  "lean_pending"
);

assert.throws(
  () => parseClaimSuggestionsJson(
    "not json",
    new Set(["message-1"]),
    ""
  ),
  /invalid claim suggestions/
);

function makeCandidate(id, title, markdown, sourceMessageIds) {
  return {
    id,
    title,
    primaryConcept: { name: title, aliases: [title] },
    markdown,
    sourceMessageIds,
    viewMode: "edit",
    userEdited: false,
    revision: 0,
    claims: []
  };
}

function makeApp() {
  const files = new Map();
  const folders = new Set(["Lain Brain", "Lain Brain/Notes"]);
  const writes = [];
  const folderObject = (path) => ({ path, children: [] });

  return {
    writes,
    files,
    app: {
      vault: {
        cachedRead: async (file) => files.get(file.path)?.content ?? "",
        getMarkdownFiles: () => [],
        getFileByPath: (path) => files.get(path)?.file ?? null,
        getAbstractFileByPath: (path) =>
          files.get(path)?.file ??
          (folders.has(path) ? folderObject(path) : null),
        getFolderByPath: (path) =>
          folders.has(path) ? folderObject(path) : null,
        createFolder: async (path) => {
          folders.add(path);
          writes.push({ operation: "createFolder", path });
        },
        create: async (path, content) => {
          const file = {
            path,
            basename: path.slice(path.lastIndexOf("/") + 1)
              .replace(/\.md$/i, "")
          };
          files.set(path, { file, content });
          writes.push({ operation: "create", path, content });
          return file;
        },
        modify: async (file, content) => {
          const existing = files.get(file.path);
          files.set(file.path, { file, content });
          writes.push({
            operation: "modify",
            path: file.path,
            previous: existing?.content,
            content
          });
        },
        trash: async (file) => {
          files.delete(file.path);
          writes.push({ operation: "trash", path: file.path });
        }
      },
      metadataCache: {
        getFirstLinkpathDest: () => null
      },
      workspace: {
        getLeaf: () => ({
          openFile: async () => {}
        })
      }
    }
  };
}

const apiKey = "claim-test-api-key";
const originalA = [
  "# Operator interpretation",
  "",
  "Parent: [[Lain Brain/Notes/Operators|Operators]]",
  "",
  "The relation is written as $T^{+}T$.",
  "",
  "$$",
  "A = \\begin{bmatrix}",
  "1 & 0 \\\\",
  "0 & 1",
  "\\end{bmatrix}",
  "$$",
  "",
  "## Relationships",
  "- [[Adjoint Operator]]"
].join("\n");
const originalB = "# Independent candidate\n\nUntouched body.";
const candidateA = makeCandidate(
  "candidate-a",
  "Operator interpretation",
  originalA,
  ["message-1", "message-2"]
);
const candidateB = makeCandidate(
  "candidate-b",
  "Independent candidate",
  originalB,
  ["message-4"]
);
let classifierCalls = 0;
let capturedRequest;
const suggestions = [
  {
    text: "I see the operator as a geometric transformation.",
    kind: "personal_interpretation",
    verification: "user_authored",
    sourceReferences: [],
    sourceMessageIds: ["message-1"]
  },
  {
    text: "The operator has a stated algebraic property.",
    kind: "factual_claim",
    verification: "source_cited",
    sourceReferences: [],
    sourceMessageIds: ["message-2"]
  },
  {
    text: "Does the property hold without boundedness?",
    kind: "open_question",
    verification: "source_pending",
    sourceReferences: [],
    sourceMessageIds: ["message-1"]
  },
  {
    text: "For every $x$, $T^{+}Tx=x$ under the stated assumptions.",
    kind: "formal_statement",
    verification: "lean_checked",
    sourceReferences: [],
    sourceMessageIds: ["message-2"],
    leanStatement: "forall x, Tplus (T x) = x"
  }
];
const environment = makeApp();
const session = new LainBrainSession(
  environment.app,
  () => apiKey,
  () => null,
  { analyzeImage: async () => { throw new Error("Vision not expected"); } },
  async () => { throw new Error("Chat not expected"); },
  async (_key, request) => {
    classifierCalls += 1;
    capturedRequest = request;
    return suggestions;
  }
);
session.candidates = [candidateA, candidateB];
session.activeCandidateId = candidateA.id;
session.messages = [
  {
    id: "message-1",
    role: "user",
    content: "I see the operator as a geometric transformation.",
    includeInHistory: true
  },
  {
    id: "message-2",
    role: "assistant",
    content: "The operator has a stated algebraic property.",
    includeInHistory: true,
    attachment: {
      filename: "diagram.png",
      mimeType: "image/png",
      byteSize: 100,
      providerId: "vision",
      providerDisplayName: "Vision Provider"
    }
  },
  {
    id: "message-3",
    role: "user",
    content:
      "Unrelated secret " + apiKey +
      " data:image/png;base64,PRIVATE_IMAGE_DATA",
    includeInHistory: true
  }
];

const beforeUnchecked = candidateA.markdown;
const review = await session.generateClaimReview(candidateA.id);
assert.equal(review.ok, true);
assert.equal(classifierCalls, 1);
assert.equal(candidateA.markdown, beforeUnchecked);
assert.equal(candidateA.claims.length, 0);
assert.equal(environment.writes.length, 0);
assert.deepEqual(
  capturedRequest.sourceMessages.map((message) => message.id),
  ["message-1", "message-2"]
);
assert.equal(
  capturedRequest.sourceMessages.some(
    (message) => message.content.includes("PRIVATE_IMAGE_DATA")
  ),
  false
);

const reviewItems = review.items;
assert.equal(reviewItems.every((item) => item.id.startsWith("claim-candidate-a-")), true);

// Inject a formalization preview into the ephemeral store for the
// formal_statement suggestion so the "Formalize before Apply" guard passes.
const formalItem = reviewItems.find((item) => item.kind === "formal_statement");
if (formalItem !== undefined) {
  const formalizationRecord = createFormalizationRecord({
    claimId: formalItem.id,
    sourceRefs: formalItem.sourceMessageIds.map((messageId) => ({
      messageId,
      snapshot: "Test source message snapshot."
    })),
    speechAct: "theorem_claim",
    objects: [],
    explicitAssumptions: [],
    implicitAssumptions: [],
    quantifiers: "For every x",
    conclusion: "Tplus (T x) = x",
    ambiguities: [],
    missingConditions: [],
    semanticChanges: [],
    aiNormalizedStatement: "For every x, Tplus (T x) = x under the stated assumptions.",
    latexStatement: "\\forall x,\\, T^{+}Tx = x"
  });
  // Accept the formalization so Apply passes
  const accepted = applyFormalizationReview(
    formalizationRecord,
    "accepted"
  );
  // Store in ephemeral suggestionPreviews (NOT formalizationIndex)
  session.suggestionPreviews = new Map([
    [formalItem.id, [{
      record: accepted,
      suggestionId: formalItem.id,
      sourceText: formalItem.text,
      sourceKind: formalItem.kind
    }]]
  ]);
}

const applied = session.applyReviewedClaims(
  candidateA.id,
  reviewItems
);
assert.equal(applied.ok, true);
assert.equal(applied.appliedCount, 4);
assert.equal(candidateA.claims.length, 4);
assert.equal(candidateA.claims[0].kind, "personal_interpretation");
assert.equal(candidateA.claims[0].verification, "user_authored");
assert.equal(candidateA.claims[1].verification, "source_pending");
assert.equal(candidateA.claims[2].kind, "open_question");
assert.equal(candidateA.claims[3].verification, "lean_pending");
assert.equal(candidateA.claims[3].leanProofStatus, "not_started");
assert.equal(candidateA.markdown.startsWith(originalA + "\n\n"), true);
assert.equal(candidateA.markdown.includes("$T^{+}T$"), true);
assert.equal(candidateA.markdown.includes("\\begin{bmatrix}"), true);
assert.equal(candidateA.markdown.includes("- [[Adjoint Operator]]"), true);
assert.equal(candidateA.markdown.includes("## Knowledge status"), true);
assert.equal(candidateA.markdown.includes("### My interpretation"), true);
assert.equal(candidateA.markdown.includes("### Claims needing sources"), true);
assert.equal(candidateA.markdown.includes("### Open questions"), true);
assert.equal(candidateA.markdown.includes("### Formalization candidates"), true);
assert.equal(candidateA.markdown.includes("Ready for Lean review"), true);
assert.equal(candidateB.markdown, originalB);
assert.equal(candidateB.claims.length, 0);
assert.equal(environment.writes.length, 0);

const sameIdUpdate = {
  ...reviewItems[0],
  text: "I understand the operator as a transformation of geometry."
};
const reapplied = session.applyReviewedClaims(
  candidateA.id,
  [sameIdUpdate]
);
assert.equal(reapplied.ok, true);
assert.equal(candidateA.claims.length, 4);
assert.equal(
  candidateA.claims.filter(
    (claim) => claim.id === sameIdUpdate.id
  ).length,
  1
);
assert.equal(
  candidateA.markdown.includes(
    "I understand the operator as a transformation of geometry."
  ),
  true
);
assert.equal(
  candidateA.markdown.includes(
    "I see the operator as a geometric transformation."
  ),
  false
);

const beforeNoSelection = candidateA.markdown;
const claimsBeforeNoSelection = JSON.stringify(candidateA.claims);
const noSelection = session.applyReviewedClaims(candidateA.id, []);
assert.equal(noSelection.ok, true);
assert.equal(noSelection.appliedCount, 0);
assert.equal(candidateA.markdown, beforeNoSelection);
assert.equal(JSON.stringify(candidateA.claims), claimsBeforeNoSelection);

const unsafeItem = session.createEmptyClaimReviewItem(candidateA.id);
unsafeItem.text = "Do not store " + apiKey;
const beforeUnsafeMarkdown = candidateA.markdown;
const beforeUnsafeClaims = JSON.stringify(candidateA.claims);
const unsafeApply = session.applyReviewedClaims(
  candidateA.id,
  [unsafeItem]
);
assert.equal(unsafeApply.ok, false);
assert.equal(candidateA.markdown, beforeUnsafeMarkdown);
assert.equal(JSON.stringify(candidateA.claims), beforeUnsafeClaims);
assert.equal(environment.writes.length, 0);

const serializedClaims = JSON.stringify(candidateA.claims);
assert.equal(serializedClaims.includes(apiKey), false);
assert.equal(serializedClaims.includes("PRIVATE_IMAGE_DATA"), false);
assert.equal(serializedClaims.includes("data:image"), false);
assert.equal(classifierCalls, 1);

const createdMarkdown = candidateA.markdown;
const createResult = await session.createCandidateNote(
  candidateA.id,
  "Operator interpretation.md",
  "Lain Brain/Notes",
  undefined
);
assert.equal(createResult.ok, true);
const createWrites = environment.writes.filter(
  (write) => write.operation === "create"
);
assert.equal(createWrites.length, 1);
assert.equal(createWrites[0].content, createdMarkdown);
assert.equal(createWrites[0].content.includes("## Knowledge status"), true);

const createdVaultContent = createWrites[0].content;
session.setCandidateNoteMarkdown(
  candidateA.markdown.replace(
    "<!-- lain-brain:knowledge-status:start -->",
    ""
  )
);
assert.equal(candidateA.claims.length, 4);
assert.match(
  session.getClaimStatusWarning(candidateA.id),
  /could not be located safely/
);
assert.equal(
  environment.files.get(createResult.path).content,
  createdVaultContent
);
assert.equal(
  environment.writes.filter(
    (write) => write.operation === "modify"
  ).length,
  0
);

const invalidEnvironment = makeApp();
const invalidCandidate = makeCandidate(
  "candidate-invalid",
  "Invalid response candidate",
  "# Candidate\n\nOriginal.",
  ["message-invalid"]
);
const invalidSession = new LainBrainSession(
  invalidEnvironment.app,
  () => "configured-key",
  () => null,
  { analyzeImage: async () => { throw new Error("Vision not expected"); } },
  async () => { throw new Error("Chat not expected"); },
  async () => {
    parseClaimSuggestionsJson(
      "not json",
      new Set(["message-invalid"]),
      ""
    );
    return [];
  }
);
invalidSession.candidates = [invalidCandidate];
invalidSession.activeCandidateId = invalidCandidate.id;
invalidSession.messages = [{
  id: "message-invalid",
  role: "user",
  content: "Source message",
  includeInHistory: true
}];
const invalidBefore = invalidCandidate.markdown;
const invalidReview = await invalidSession.generateClaimReview(
  invalidCandidate.id
);
assert.equal(invalidReview.ok, false);
assert.equal(
  invalidReview.error,
  "Unable to review claims. DeepSeek returned invalid claim suggestions."
);
assert.equal(invalidCandidate.markdown, invalidBefore);
assert.equal(invalidCandidate.claims.length, 0);
assert.equal(invalidEnvironment.writes.length, 0);

const largeViewSource = fs.readFileSync(
  "src/LainBrainLargeView.ts",
  "utf8"
);
const modalSource = fs.readFileSync(
  "src/ReviewClaimsModal.ts",
  "utf8"
);
assert.match(largeViewSource, /text: "Review Claims"/);
assert.match(modalSource, /Apply selected claims/);
assert.match(modalSource, /Ready for Lean review/);
assert.doesNotMatch(modalSource, /Lean-checked/);

// ── Preview rendering ───────────────────────────────────────────
assert.match(modalSource, /LainBrainMarkdownRenderBatch/);
assert.match(modalSource, /makeReadOnlyTextSelectable/);
assert.match(modalSource, /Rendered preview/);
assert.match(modalSource, /schedulePreview/);
assert.match(modalSource, /clearPreviews/);
// Per-key cleanup
assert.match(modalSource, /previewCleanups/);
assert.match(modalSource, /registerPreviewCleanup/);
// Semantic changes before/after preview
assert.match(modalSource, /change\.before/);
assert.match(modalSource, /change\.after/);
assert.match(modalSource, /before:/);
assert.match(modalSource, /after:/);
// Claim text unchanged after validation
const latexClaim = normalizeReviewedClaim({
  id: "claim-latex-test",
  text: "The pseudoinverse $A^{+}$ satisfies $$A^{+} = (A^{T}A)^{-1}A^{T}$$",
  kind: "formal_statement",
  verification: "lean_pending",
  sourceReferences: [],
  sourceMessageIds: ["message-latex"]
}, undefined, "2026-08-06T00:00:00.000Z");
assert.equal(
  latexClaim.text,
  "The pseudoinverse $A^{+}$ satisfies $$A^{+} = (A^{T}A)^{-1}A^{T}$$"
);
// Matrix LaTeX preserved
const matrixClaim = normalizeReviewedClaim({
  id: "claim-matrix-test",
  text:
    "The matrix $$\\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix}$$ is identity.",
  kind: "factual_claim",
  verification: "source_pending",
  sourceReferences: [],
  sourceMessageIds: ["message-matrix"]
}, undefined, "2026-08-06T00:00:00.000Z");
assert.match(matrixClaim.text, /\\begin\{bmatrix\}/);
assert.match(matrixClaim.text, /\\end\{bmatrix\}/);
// Inline math preserved
const inlineMathClaim = normalizeReviewedClaim({
  id: "claim-inline-test",
  text: "The norm $\\lVert x \\rVert$ is positive definite.",
  kind: "factual_claim",
  verification: "source_pending",
  sourceReferences: [],
  sourceMessageIds: ["message-inline"]
}, undefined, "2026-08-06T00:00:00.000Z");
assert.match(inlineMathClaim.text, /\$\\lVert x \\rVert\$/);
// \(...\) delimiters preserved
const parenMathClaim = normalizeReviewedClaim({
  id: "claim-paren-test",
  text: "The expression \\(A^{+}\\) is the pseudoinverse.",
  kind: "factual_claim",
  verification: "source_pending",
  sourceReferences: [],
  sourceMessageIds: ["message-paren"]
}, undefined, "2026-08-06T00:00:00.000Z");
assert.ok(parenMathClaim.text.includes("\\(A^{+}\\)"));

console.log(JSON.stringify({
  personalInterpretationPreserved: true,
  unsupportedFactStatus: "source_pending",
  uncheckedMutationCount: 0,
  candidateBodyAndLatexPreserved: true,
  isolatedCandidateCount: 2,
  createdNoteContainsKnowledgeStatus: true,
  invalidJsonVaultWrites: invalidEnvironment.writes.length,
  reviewVaultWritesBeforeCreate: 0,
  classifierCalls,
  latexPreservedInClaim: true,
  matrixPreservedInClaim: true,
  inlineMathPreservedInClaim: true,
  parenMathPreservedInClaim: true,
  previewRendererImported: true,
  previewLabelPresent: true,
  previewCleanupPresent: true,
  perKeyCleanupMap: true,
  semanticChangeBeforeAfterPreview: true,
  result: "PASS"
}, null, 2));
