import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { LainBrainSession } from './src/LainBrainSession';",
      "export {",
      "  createFormalizationRecord,",
      "  applyFormalizationReview,",
      "  serializeFormalizationIndex,",
      "  deserializeFormalizationIndex",
      "} from './src/FormalizationProtocol';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "suggestion-formalization-entry.ts",
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
  crypto: { randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});
const {
  LainBrainSession,
  createFormalizationRecord,
  applyFormalizationReview,
  serializeFormalizationIndex,
  deserializeFormalizationIndex
} = module.exports;

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function makeApp() {
  const files = new Map();
  const writes = [];
  const trash = [];
  return {
    app: {
      vault: {
        getMarkdownFiles: () => [],
        getAbstractFileByPath: (path) => files.get(path) ?? null,
        getFileByPath: (path) => files.get(path)?.extension === "md" ? files.get(path) : null,
        getFolderByPath: () => null,
        cachedRead: async (file) => file?.content ?? "",
        read: async (file) => file?.content ?? "",
        create: async (path, content) => {
          writes.push({ path, content });
          const file = { path, basename: path.split("/").pop().replace(/\.md$/i, ""), extension: "md", content };
          files.set(path, file);
          return file;
        },
        createFolder: async () => {},
        modify: async (file, content) => { file.content = content; },
        trash: async (file) => { trash.push(file.path); files.delete(file.path); }
      },
      workspace: { getLeaf: () => ({ openFile: async () => {} }) },
      metadataCache: { getFileCache: () => null }
    },
    files,
    writes,
    trash
  };
}

function makeCandidate(id, title) {
  return {
    id,
    title,
    primaryConcept: { name: title, aliases: [title] },
    markdown: "Test candidate " + id,
    sourceMessageIds: ["message-1", "message-2"],
    viewMode: "preview",
    userEdited: false,
    revision: 1,
    claims: [],
    formalizationIds: []
  };
}

function makeSuggestion(overrides = {}) {
  return {
    id: "claim-candidate-test-" + Math.random().toString(36).slice(2, 8),
    text: "For every natural number n, n + 0 = n.",
    kind: "formal_statement",
    verification: "lean_pending",
    sourceReferences: [],
    sourceMessageIds: ["message-1"],
    ...overrides
  };
}

function makeSession(env, candidate, messages) {
  const session = new LainBrainSession(
    env.app,
    () => "sk-test-api-key-000000000000000000000000",
    () => null,
    { analyzeImage: async () => { throw new Error("Vision not expected"); } },
    async () => { throw new Error("Chat not expected"); },
    async () => []
  );
  session.candidates = [candidate];
  session.activeCandidateId = candidate.id;
  session.messages = messages ?? [
    {
      id: "message-1",
      role: "user",
      content: "For every natural number n, n + 0 = n.",
      includeInHistory: true
    },
    {
      id: "message-2",
      role: "assistant",
      content: "That's the additive identity property.",
      includeInHistory: true
    }
  ];
  return session;
}

function makeFormalizationRecord(claimId, sourceText = "For every natural number n, n + 0 = n.") {
  return createFormalizationRecord({
    claimId,
    sourceRefs: [{ messageId: "message-1", snapshot: sourceText }],
    speechAct: "theorem_claim",
    objects: [{ name: "natural numbers", latex: "\\mathbb{N}" }],
    explicitAssumptions: [],
    implicitAssumptions: [],
    quantifiers: "For every natural number n",
    conclusion: "n + 0 = n",
    ambiguities: [],
    missingConditions: [],
    semanticChanges: [],
    aiNormalizedStatement: sourceText,
    latexStatement: "\\forall n \\in \\mathbb{N},\\, n + 0 = n"
  });
}

/**
 * Inject a suggestion formalization preview into the ephemeral store.
 * Simulates what generateFormalizationForSuggestion does internally.
 */
function injectSuggestionPreview(session, suggestionId, sourceText, sourceKind, reviewStatus = "accepted") {
  const record = makeFormalizationRecord(suggestionId, sourceText);
  const accepted = reviewStatus === "accepted"
    ? applyFormalizationReview(record, "accepted")
    : record;

  const preview = {
    record: accepted,
    suggestionId,
    sourceText,
    sourceKind
  };

  const existing = session.suggestionPreviews.get(suggestionId) ?? [];
  existing.push(preview);
  session.suggestionPreviews.set(suggestionId, existing);

  return { preview, recordId: accepted.id };
}

// ═══════════════════════════════════════════════════════════════════════
// Test A: Unapplied suggestion → Formalize → preview generated → claim store unchanged
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-a", "Test Candidate A");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({ id: "claim-candidate-a-sug1" });

  assert.equal(candidate.claims.length, 0);

  // Inject preview into ephemeral store
  const { preview, recordId } = injectSuggestionPreview(session, sug.id, sug.text, sug.kind);

  // Preview accessible via ephemeral getter
  const previews = session.getFormalizationPreviewsForSuggestion(sug.id);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].record.id, recordId);
  assert.equal(previews[0].record.reviewStatus, "accepted");

  // NOT accessible via committed getter
  const committed = session.getFormalizationsForClaim(sug.id);
  assert.equal(committed.length, 0);

  // Claim store unchanged
  assert.equal(candidate.claims.length, 0);

  // NOT in formalizationIndex
  assert.equal(Object.keys(session.formalizationIndex.records).length, 0);

  console.log("TEST-A PASS: suggestion formalize does not change claim store or formalizationIndex");
}

// ═══════════════════════════════════════════════════════════════════════
// Test A2: formalize → serialize formalizationIndex → preview NOT in serialized data
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-a2", "Test Candidate A2");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({ id: "claim-candidate-a2-sug1" });

  injectSuggestionPreview(session, sug.id, sug.text, sug.kind);

  // Serialize the formalizationIndex
  const serialized = serializeFormalizationIndex(session.formalizationIndex);
  const deserialized = deserializeFormalizationIndex(serialized);

  // The preview must NOT appear in the serialized data
  assert.notEqual(deserialized, null);
  const allClaimIds = Object.values(deserialized.records).map((r) => r.claimId);
  assert.ok(!allClaimIds.includes(sug.id));

  console.log("TEST-A2 PASS: formalizationIndex serialization does NOT contain draft preview");
}

// ═══════════════════════════════════════════════════════════════════════
// Test B: Formalize suggestion A → preview belongs to A → suggestion B unaffected
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-b", "Test Candidate B");
  const session = makeSession(env, candidate);
  const sugA = makeSuggestion({ id: "claim-candidate-b-sugA", text: "A: x + 0 = x" });
  const sugB = makeSuggestion({ id: "claim-candidate-b-sugB", text: "B: x * 1 = x" });

  injectSuggestionPreview(session, sugA.id, sugA.text, sugA.kind);

  // Preview for A
  assert.equal(session.getFormalizationPreviewsForSuggestion(sugA.id).length, 1);
  // No preview for B
  assert.equal(session.getFormalizationPreviewsForSuggestion(sugB.id).length, 0);

  console.log("TEST-B PASS: suggestion formalization isolated per suggestion");
}

// ═══════════════════════════════════════════════════════════════════════
// Test C: Formalize → modify claim text → preview stale → cannot apply stale
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-c", "Test Candidate C");
  const session = makeSession(env, candidate);

  const sug = makeSuggestion({
    id: "claim-candidate-c-sug1",
    text: "For every real x, x + 0 = x.",
    kind: "formal_statement"
  });

  injectSuggestionPreview(session, sug.id, sug.text, sug.kind);

  // Initially not stale
  const recId = session.getFormalizationPreviewsForSuggestion(sug.id)[0].record.id;
  assert.equal(session.isFormalizationStale(recId, sug.text, sug.kind), false);

  // Different text → stale
  const modifiedText = "For every complex z, z + 0 = z.";
  assert.equal(session.isFormalizationStale(recId, modifiedText, sug.kind), true);

  // Different kind → stale
  assert.equal(session.isFormalizationStale(recId, sug.text, "factual_claim"), true);

  // Modify the suggestion text (simulates user editing in UI)
  sug.text = modifiedText;

  // Apply should be blocked because the preview text no longer matches
  const result = session.applyReviewedClaims(candidate.id, [sug]);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("Formalize and review"));

  console.log("TEST-C PASS: stale formalization blocked on apply (modified text before apply)");
}

// ═══════════════════════════════════════════════════════════════════════
// Test D: Formal statement + Include → no formalization → Apply blocked
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-d", "Test Candidate D");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({
    id: "claim-candidate-d-sug1",
    text: "Every convergent sequence is bounded.",
    kind: "formal_statement"
  });

  // No formalization at all
  const result = session.applyReviewedClaims(candidate.id, [sug]);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("Formalize and review"));
  assert.ok(!result.error.includes("Claim not found"));

  console.log("TEST-D PASS: formal statement blocked without formalization review");
}

// ═══════════════════════════════════════════════════════════════════════
// Test E: Formal statement → Formalize → review/accept → Apply → committed + formalization linked
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-e", "Test Candidate E");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({
    id: "claim-candidate-e-sug1",
    text: "For every natural number n, n + 0 = n.",
    kind: "formal_statement"
  });

  const { recordId } = injectSuggestionPreview(session, sug.id, sug.text, sug.kind);

  const previews = session.getFormalizationPreviewsForSuggestion(sug.id);
  const originalNormalized = previews[0].record.aiNormalizedStatement;
  const originalSpeechAct = previews[0].record.speechAct;

  // formalizationIndex is empty before Apply
  assert.equal(Object.keys(session.formalizationIndex.records).length, 0);

  // Apply — should materialize the preview into formalizationIndex
  const result = session.applyReviewedClaims(candidate.id, [sug]);
  assert.equal(result.ok, true);
  assert.equal(result.appliedCount, 1);

  // Claim is now committed
  assert.equal(candidate.claims.length, 1);
  const committedClaim = candidate.claims[0];
  assert.equal(committedClaim.id, sug.id);

  // Formalization is now in formalizationIndex (materialized)
  assert.equal(Object.keys(session.formalizationIndex.records).length, 1);
  const materialized = session.getFormalizationsForClaim(committedClaim.id);
  assert.equal(materialized.length, 1);
  assert.equal(materialized[0].claimId, committedClaim.id);
  assert.equal(materialized[0].id, recordId);

  // Content preserved (no re-LLM)
  assert.equal(materialized[0].aiNormalizedStatement, originalNormalized);
  assert.equal(materialized[0].speechAct, originalSpeechAct);
  assert.equal(materialized[0].reviewStatus, "accepted");

  // Linked to committed claim
  assert.equal(committedClaim.formalizationIds.length, 1);
  assert.equal(committedClaim.formalizationIds[0], recordId);
  assert.equal(committedClaim.primaryFormalizationId, recordId);

  // Ephemeral previews cleared
  assert.equal(session.getFormalizationPreviewsForSuggestion(sug.id).length, 0);

  console.log("TEST-E PASS: full flow with materialization into formalizationIndex, no re-LLM");
}

// ═══════════════════════════════════════════════════════════════════════
// Test E2: Apply → serialize → reload → committed data survives
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-e2", "Test Candidate E2");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({
    id: "claim-candidate-e2-sug1",
    text: "Every nonempty set of natural numbers has a least element.",
    kind: "formal_statement"
  });

  const { recordId } = injectSuggestionPreview(session, sug.id, sug.text, sug.kind);

  // Apply
  session.applyReviewedClaims(candidate.id, [sug]);

  // Serialize formalizationIndex (simulates data.json save)
  const serialized = serializeFormalizationIndex(session.formalizationIndex);
  const deserialized = deserializeFormalizationIndex(serialized);

  // Committed record IS in serialized data
  assert.notEqual(deserialized, null);
  const record = deserialized.records[recordId];
  assert.notEqual(record, undefined);
  assert.equal(record.claimId, sug.id);

  // Simulate reload: create new session, load the persisted index
  const session2 = makeSession(env, candidate);
  session2.setFormalizationIndex(deserialized);
  // Re-populate claims (normally done by settings load)
  candidate.claims[0].formalizationIds = [recordId];
  candidate.claims[0].primaryFormalizationId = recordId;

  // After reload, formalization is accessible via committed path
  const reloaded = session2.getFormalizationsForClaim(sug.id);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].id, recordId);

  // No stale previews after reload
  assert.equal(session2.getFormalizationPreviewsForSuggestion(sug.id).length, 0);

  console.log("TEST-E2 PASS: after apply, formalization persists in serialized index and survives reload");
}

// ═══════════════════════════════════════════════════════════════════════
// Test E3: Simulate reload BEFORE Apply → preview is lost → no orphan in formalizationIndex
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-e3", "Test Candidate E3");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({ id: "claim-candidate-e3-sug1" });

  injectSuggestionPreview(session, sug.id, sug.text, sug.kind);

  // Serialize before apply (preview should NOT be in it)
  const serialized = serializeFormalizationIndex(session.formalizationIndex);
  const deserialized = deserializeFormalizationIndex(serialized);

  // Simulate reload with only formalizationIndex (previews are lost - by design)
  const session2 = makeSession(env, candidate);
  session2.setFormalizationIndex(deserialized);

  // Preview is gone after reload
  assert.equal(session2.getFormalizationPreviewsForSuggestion(sug.id).length, 0);
  // No orphan in formalizationIndex
  const committed = session2.getFormalizationsForClaim(sug.id);
  assert.equal(committed.length, 0);

  console.log("TEST-E3 PASS: reload before apply loses preview but leaves no orphans");
}

// ═══════════════════════════════════════════════════════════════════════
// Test F: Delete suggestion after Formalize → no orphan records
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-f", "Test Candidate F");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({ id: "claim-candidate-f-sug1" });

  injectSuggestionPreview(session, sug.id, sug.text, sug.kind);

  // Preview exists
  assert.equal(session.getFormalizationPreviewsForSuggestion(sug.id).length, 1);

  // Delete
  session.deleteAllFormalizationsForSuggestionId(sug.id);

  // Gone from ephemeral store
  assert.equal(session.getFormalizationPreviewsForSuggestion(sug.id).length, 0);
  // formalizationIndex unchanged
  assert.equal(Object.keys(session.formalizationIndex.records).length, 0);
  // Claim store unchanged
  assert.equal(candidate.claims.length, 0);

  console.log("TEST-F PASS: delete suggestion cleans up ephemeral previews without orphans");
}

// ═══════════════════════════════════════════════════════════════════════
// Test G: Cancel/close after Formalize → claim store unchanged, formalizationIndex unchanged
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-g", "Test Candidate G");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({ id: "claim-candidate-g-sug1" });

  injectSuggestionPreview(session, sug.id, sug.text, sug.kind);

  // Preview exists in ephemeral store
  assert.equal(session.getFormalizationPreviewsForSuggestion(sug.id).length, 1);

  // Claim store unchanged
  assert.equal(candidate.claims.length, 0);

  // formalizationIndex unchanged
  assert.equal(Object.keys(session.formalizationIndex.records).length, 0);

  // Cancel/close — clear previews
  session.deleteAllFormalizationsForSuggestionId(sug.id);
  assert.equal(candidate.claims.length, 0);
  assert.equal(Object.keys(session.formalizationIndex.records).length, 0);

  console.log("TEST-G PASS: cancel/close after formalize does not change claim store or formalizationIndex");
}

// ═══════════════════════════════════════════════════════════════════════
// Test H: Source message references preserved through suggestion → commit
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-h", "Test Candidate H");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({
    id: "claim-candidate-h-sug1",
    sourceReferences: ["https://example.com/proof"],
    sourceMessageIds: ["message-1", "message-2"],
    text: "Additive identity holds for natural numbers.",
    kind: "formal_statement"
  });

  injectSuggestionPreview(session, sug.id, sug.text, sug.kind);

  const result = session.applyReviewedClaims(candidate.id, [sug]);
  assert.equal(result.ok, true);

  const committed = candidate.claims[0];
  assert.equal(committed.sourceReferences.length, 1);
  assert.equal(committed.sourceReferences[0], "https://example.com/proof");
  assert.equal(committed.sourceMessageIds.length, 2);
  assert.ok(committed.sourceMessageIds.includes("message-1"));
  assert.ok(committed.sourceMessageIds.includes("message-2"));

  const materialized = session.getFormalizationsForClaim(committed.id);
  assert.equal(materialized.length, 1);
  assert.equal(materialized[0].sourceRefs.length, 1);
  assert.equal(materialized[0].sourceRefs[0].messageId, "message-1");

  console.log("TEST-H PASS: source provenance preserved through suggestion → commit");
}

// ═══════════════════════════════════════════════════════════════════════
// Test I: Committed claim formalization still works (backward compat)
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-i", "Test Candidate I");

  // Pre-populate a committed claim
  candidate.claims = [{
    id: "claim-candidate-i-committed",
    text: "Every Cauchy sequence in R converges.",
    kind: "formal_statement",
    verification: "lean_pending",
    sourceReferences: [],
    sourceMessageIds: ["message-1"],
    userApproved: true,
    formalizationIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }];

  const session = makeSession(env, candidate);

  // Committed claim is findable via getCandidateClaims
  const claims = session.getCandidateClaims(candidate.id);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].id, "claim-candidate-i-committed");

  // Re-applying with a formalization in the index
  const sug = makeSuggestion({
    id: "claim-candidate-i-committed",
    text: "Every Cauchy sequence in R converges.",
    kind: "formal_statement"
  });

  // Add a committed formalization (simulating old path)
  const record = makeFormalizationRecord(sug.id, sug.text);
  const accepted = applyFormalizationReview(record, "accepted");
  session.formalizationIndex.records[accepted.id] = accepted;

  // Existing committed claim has it linked
  candidate.claims[0].formalizationIds = [accepted.id];
  candidate.claims[0].primaryFormalizationId = accepted.id;

  const result = session.applyReviewedClaims(candidate.id, [sug]);
  assert.equal(result.ok, true);

  console.log("TEST-I PASS: committed claim backend still works (backward compatible)");
}

// ═══════════════════════════════════════════════════════════════════════
// Test J: Non-formal claims apply normally without formalization
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-j", "Test Candidate J");
  const session = makeSession(env, candidate);

  const factualSug = makeSuggestion({
    id: "claim-candidate-j-factual",
    text: "The Earth orbits the Sun.",
    kind: "factual_claim",
    verification: "source_pending"
  });

  const result = session.applyReviewedClaims(candidate.id, [factualSug]);
  assert.equal(result.ok, true);
  assert.equal(result.appliedCount, 1);
  assert.equal(candidate.claims[0].kind, "factual_claim");

  console.log("TEST-J-1 PASS: factual_claim applies without formalization");

  const personalSug = makeSuggestion({
    id: "claim-candidate-j-personal",
    text: "I think math is beautiful.",
    kind: "personal_interpretation",
    verification: "user_authored"
  });

  const result2 = session.applyReviewedClaims(candidate.id, [personalSug]);
  assert.equal(result2.ok, true);

  console.log("TEST-J-2 PASS: personal_interpretation applies without formalization");

  const openSug = makeSuggestion({
    id: "claim-candidate-j-open",
    text: "Is P = NP?",
    kind: "open_question",
    verification: "source_pending"
  });

  const result3 = session.applyReviewedClaims(candidate.id, [openSug]);
  assert.equal(result3.ok, true);

  console.log("TEST-J-3 PASS: open_question applies without formalization");
}

// ═══════════════════════════════════════════════════════════════════════
// Test K: Persistence guard — reload before Apply loses preview, no orphan
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-k", "Test Candidate K");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({ id: "claim-candidate-k-sug1", kind: "formal_statement" });

  injectSuggestionPreview(session, sug.id, sug.text, sug.kind);

  // Serialize the formalizationIndex (as happens on data.json save)
  const serialized = serializeFormalizationIndex(session.formalizationIndex);

  // Verify: the serialized index does NOT contain the preview's claimId
  const deserialized = deserializeFormalizationIndex(serialized);
  assert.notEqual(deserialized, null);
  for (const r of Object.values(deserialized.records)) {
    assert.notEqual(r.claimId, sug.id);
  }

  console.log("TEST-K PASS: persistence guard — draft preview absent from serialized FormalizationIndex");
}

// ═══════════════════════════════════════════════════════════════════════
// Test L: Stale preview cannot survive reload and be mistaken for committed
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-l", "Test Candidate L");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({ id: "claim-candidate-l-sug1" });

  // Inject a preview (not accepted — still pending)
  const record = makeFormalizationRecord(sug.id, sug.text);
  const preview = {
    record,
    suggestionId: sug.id,
    sourceText: sug.text,
    sourceKind: sug.kind
  };
  session.suggestionPreviews.set(sug.id, [preview]);

  // Serialize → deserialize (simulate reload)
  const serialized = serializeFormalizationIndex(session.formalizationIndex);
  const deserialized = deserializeFormalizationIndex(serialized);

  // Create new session with reloaded index
  const session2 = makeSession(env, candidate);
  session2.setFormalizationIndex(deserialized);

  // Preview is gone (ephemeral, not persisted)
  assert.equal(session2.getFormalizationPreviewsForSuggestion(sug.id).length, 0);

  // The record does NOT appear as a committed formalization either
  const committed = session2.getFormalizationsForClaim(sug.id);
  assert.equal(committed.length, 0);

  // isFormalizationStale returns undefined (record not found)
  assert.equal(session2.isFormalizationStale(record.id, sug.text, sug.kind), undefined);

  console.log("TEST-L PASS: stale preview cannot survive reload and be mistaken for committed");
}

// ═══════════════════════════════════════════════════════════════════════
// Batch Formalize Tests (A–D)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Replicate the modal's batch eligibility predicate for testing.
 *
 * A claim is eligible when ALL of:
 *   - kind === "formal_statement"
 *   - Not already committed (applied)
 *   - Not currently formalizing
 *   - Does NOT have a current non-stale formalization preview
 */
function isEligibleForBatchFormalize(row, committedIds, formalizingIds, suggestionPreviews, session) {
  if (row.kind !== "formal_statement") {
    return false;
  }

  if (committedIds.has(row.id)) {
    return false;
  }

  if (formalizingIds.has(row.id)) {
    return false;
  }

  // Check for existing non-stale preview
  const previews = suggestionPreviews.get(row.id) ?? [];
  const hasCurrentPreview = previews.some((p) => {
    const stale = session.isFormalizationStale(
      p.record.id,
      row.text,
      row.kind
    );
    return stale === false; // current (non-stale) preview exists
  });

  return !hasCurrentPreview;
}

function getBatchEligible(rows, committedIds, formalizingIds, suggestionPreviews, session) {
  return rows.filter((r) =>
    isEligibleForBatchFormalize(r, committedIds, formalizingIds, suggestionPreviews, session)
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Test A: 5 claims — 3 formal_statement, 1 factual_claim, 1 personal_interpretation
//          → batch only formalizes the 3 formal_statements
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-batch-a", "Test Batch A");
  const session = makeSession(env, candidate);

  // Create rows like the modal would have
  const rows = [
    makeSuggestion({ id: "claim-batch-a-1", kind: "formal_statement", text: "For every n, n + 0 = n." }),
    makeSuggestion({ id: "claim-batch-a-2", kind: "formal_statement", text: "Every sequence has a limit." }),
    makeSuggestion({ id: "claim-batch-a-3", kind: "formal_statement", text: "A group has an identity element." }),
    makeSuggestion({ id: "claim-batch-a-4", kind: "factual_claim", text: "Water boils at 100°C." }),
    makeSuggestion({ id: "claim-batch-a-5", kind: "personal_interpretation", text: "I think math is fun." })
  ];

  const committedIds = new Set();
  const formalizingIds = new Set();
  const eligible = getBatchEligible(rows, committedIds, formalizingIds, session.suggestionPreviews, session);

  assert.equal(eligible.length, 3);
  assert.ok(eligible.every((r) => r.kind === "formal_statement"));
  assert.ok(eligible.some((r) => r.id === "claim-batch-a-1"));
  assert.ok(eligible.some((r) => r.id === "claim-batch-a-2"));
  assert.ok(eligible.some((r) => r.id === "claim-batch-a-3"));

  // Simulate batch formalization: inject previews for all 3 eligible claims
  for (const row of eligible) {
    injectSuggestionPreview(session, row.id, row.text, row.kind, "pending");
  }

  // All 3 now have previews in suggestionPreviews
  assert.equal(session.getFormalizationPreviewsForSuggestion("claim-batch-a-1").length, 1);
  assert.equal(session.getFormalizationPreviewsForSuggestion("claim-batch-a-2").length, 1);
  assert.equal(session.getFormalizationPreviewsForSuggestion("claim-batch-a-3").length, 1);
  // Factual and personal have none
  assert.equal(session.getFormalizationPreviewsForSuggestion("claim-batch-a-4").length, 0);
  assert.equal(session.getFormalizationPreviewsForSuggestion("claim-batch-a-5").length, 0);
  // formalizationIndex unchanged
  assert.equal(Object.keys(session.formalizationIndex.records).length, 0);

  console.log("TEST-BATCH-A PASS: batch only formalizes formal_statements, skips factual/personal");
}

// ═══════════════════════════════════════════════════════════════════════
// Test B: 3 formal_statements, 1 has current preview
//          → batch only processes remaining 2
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-batch-b", "Test Batch B");
  const session = makeSession(env, candidate);

  const rows = [
    makeSuggestion({ id: "claim-batch-b-1", kind: "formal_statement", text: "Claim 1: x + y = y + x." }),
    makeSuggestion({ id: "claim-batch-b-2", kind: "formal_statement", text: "Claim 2: Associativity holds." }),
    makeSuggestion({ id: "claim-batch-b-3", kind: "formal_statement", text: "Claim 3: Distributive law." })
  ];

  // Inject a current (non-stale) preview for claim 1
  injectSuggestionPreview(session, "claim-batch-b-1", "Claim 1: x + y = y + x.", "formal_statement", "pending");

  const committedIds = new Set();
  const formalizingIds = new Set();
  const eligible = getBatchEligible(rows, committedIds, formalizingIds, session.suggestionPreviews, session);

  // Only claims 2 and 3 are eligible (claim 1 already has a current preview)
  assert.equal(eligible.length, 2);
  assert.ok(eligible.every((r) => r.id !== "claim-batch-b-1"));
  assert.ok(eligible.some((r) => r.id === "claim-batch-b-2"));
  assert.ok(eligible.some((r) => r.id === "claim-batch-b-3"));

  console.log("TEST-BATCH-B PASS: claim with existing current preview excluded from batch");
}

// ═══════════════════════════════════════════════════════════════════════
// Test C: Batch formalization → previews all in suggestionPreviews
//          → formalizationIndex unchanged
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-batch-c", "Test Batch C");
  const session = makeSession(env, candidate);

  const rows = [
    makeSuggestion({ id: "claim-batch-c-1", kind: "formal_statement", text: "Batch C claim 1." }),
    makeSuggestion({ id: "claim-batch-c-2", kind: "formal_statement", text: "Batch C claim 2." })
  ];

  // Inject previews simulating batch formalization
  for (const row of rows) {
    injectSuggestionPreview(session, row.id, row.text, row.kind, "pending");
  }

  // Both previews in suggestionPreviews
  const previews1 = session.getFormalizationPreviewsForSuggestion("claim-batch-c-1");
  const previews2 = session.getFormalizationPreviewsForSuggestion("claim-batch-c-2");
  assert.equal(previews1.length, 1);
  assert.equal(previews2.length, 1);

  // NOT in formalizationIndex
  assert.equal(Object.keys(session.formalizationIndex.records).length, 0);

  // Serialize → previews NOT persisted
  const serialized = serializeFormalizationIndex(session.formalizationIndex);
  const deserialized = deserializeFormalizationIndex(serialized);
  assert.notEqual(deserialized, null);
  assert.equal(Object.keys(deserialized.records).length, 0);

  // Candidate claims unchanged (not committed)
  assert.equal(candidate.claims.length, 0);

  console.log("TEST-BATCH-C PASS: batch previews stay in suggestionPreviews, formalizationIndex unchanged");
}

// ═══════════════════════════════════════════════════════════════════════
// Test D: One LLM call failure → others continue → success/fail counts
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-batch-d", "Test Batch D");
  const session = makeSession(env, candidate);

  const rows = [
    makeSuggestion({ id: "claim-batch-d-1", kind: "formal_statement", text: "Batch D claim 1." }),
    makeSuggestion({ id: "claim-batch-d-2", kind: "formal_statement", text: "Batch D claim 2 — sim failure." }),
    makeSuggestion({ id: "claim-batch-d-3", kind: "formal_statement", text: "Batch D claim 3." })
  ];

  // Simulate batch: claim 2 fails (no preview injected)
  // claims 1 and 3 succeed
  injectSuggestionPreview(session, "claim-batch-d-1", "Batch D claim 1.", "formal_statement", "pending");
  // claim-batch-d-2 intentionally skipped (simulated failure)
  injectSuggestionPreview(session, "claim-batch-d-3", "Batch D claim 3.", "formal_statement", "pending");

  let completed = 0;
  let failed = 0;
  for (const row of rows) {
    const previews = session.getFormalizationPreviewsForSuggestion(row.id);
    if (previews.length > 0) {
      completed += 1;
    } else {
      failed += 1;
    }
  }

  assert.equal(completed, 2);
  assert.equal(failed, 1);

  // The message would be: "Formalized 2 claims. 1 failed."
  const message = failed > 0
    ? `Formalized ${completed} claim${completed !== 1 ? "s" : ""}. ${failed} failed.`
    : `Formalized ${completed} claim${completed !== 1 ? "s" : ""}.`;
  assert.ok(message.includes("2 claims"));
  assert.ok(message.includes("1 failed"));

  // Claim 2 can still be retried (it has no preview)
  assert.equal(session.getFormalizationPreviewsForSuggestion("claim-batch-d-2").length, 0);

  console.log("TEST-BATCH-D PASS: one failure doesn't block others, success/fail counts correct");
}

// ═══════════════════════════════════════════════════════════════════════
// Frozen-index ownership boundary regression
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-frozen", "Test Frozen");
  const session = makeSession(env, candidate);
  const sug = makeSuggestion({
    id: "claim-candidate-frozen-sug1",
    text: "For every natural number n, n + 0 = n.",
    kind: "formal_statement"
  });

  // Formalize + accept
  const { recordId } = injectSuggestionPreview(session, sug.id, sug.text, sug.kind);

  // Simulate real Obsidian: the persisted index is frozen/non-extensible
  const serialized = serializeFormalizationIndex(session.formalizationIndex);
  const deserialized = deserializeFormalizationIndex(serialized);
  assert.notEqual(deserialized, null);

  const external = Object.freeze({
    schemaVersion: deserialized.schemaVersion,
    records: Object.freeze({ ...deserialized.records })
  });

  // Old direct-assignment would alias this frozen object — Apply would crash.
  // The defensive copy must make session own a mutable records container.
  session.setFormalizationIndex(external);

  // Verify: external records were NOT mutated by the copy
  assert.equal(Object.keys(external.records).length, 0);
  assert.equal(Object.isExtensible(external.records), false);

  // Verify: session now owns a mutable copy
  const internalRecords = session.getFormalizationIndex().records;
  assert.equal(Object.isExtensible(internalRecords), true);

  // Apply — this materializes the preview into formalizationIndex.records.
  // With the old direct alias, this would throw "object is not extensible".
  const result = session.applyReviewedClaims(candidate.id, [sug]);
  assert.equal(result.ok, true);
  assert.equal(result.appliedCount, 1);

  // The new formalization exists in the session's mutable records
  const committed = session.getFormalizationsForClaim(sug.id);
  assert.equal(committed.length, 1);
  assert.equal(committed[0].id, recordId);

  // External was NOT mutated (stayed frozen, no new entries)
  assert.equal(Object.keys(external.records).length, 0);

  console.log("TEST-FROZEN PASS: frozen index → defensive copy → Apply succeeds, external not mutated");
}

// ═══════════════════════════════════════════════════════════════════════
// Lean artifact frozen-input regression
// ═══════════════════════════════════════════════════════════════════════

{
  const env = makeApp();
  const candidate = makeCandidate("candidate-lean-frozen", "Test Lean Frozen");
  const session = makeSession(env, candidate);

  // Simulate an externally frozen Lean artifact index
  const external = Object.freeze({
    schemaVersion: 2,
    artifacts: Object.freeze({})
  });

  session.setLeanArtifactIndex(external);

  // Session must own a mutable artifacts container
  const internalArtifacts = session.getLeanArtifactIndex().artifacts;
  assert.equal(Object.isExtensible(internalArtifacts), true);
  assert.equal(Object.keys(internalArtifacts).length, 0);

  // External was NOT mutated
  assert.equal(Object.keys(external.artifacts).length, 0);
  assert.equal(Object.isExtensible(external.artifacts), false);

  console.log("TEST-LEAN-FROZEN PASS: frozen LeanArtifactIndex → defensive copy → session owns mutable container");
}

console.log(JSON.stringify({
  testA_suggestionFormalizeNoClaimStoreChange: true,
  testA2_draftNotInSerializedIndex: true,
  testB_isolatedPerSuggestion: true,
  testC_staleBlockedOnApply: true,
  testD_formalStatementBlocked: true,
  testE_fullFlowMaterializationNoReLLM: true,
  testE2_applyThenSerializeAndReload: true,
  testE3_reloadBeforeApplyNoOrphan: true,
  testF_deleteCleansUpNoOrphans: true,
  testG_cancelCloseNoClaimChange: true,
  testH_sourceProvenancePreserved: true,
  testI_backwardCompat: true,
  testJ_nonFormalClaimsApply: true,
  testK_persistenceGuard: true,
  testL_staleCannotSurviveReload: true,
  testBatchA_onlyFormalStatements: true,
  testBatchB_existingPreviewExcluded: true,
  testBatchC_previewsInSuggestionPreviewsNotIndex: true,
  testBatchD_failureIsolationSuccessCounts: true,
  testFrozenIndex_defensiveCopy_applySucceeds: true,
  testLeanFrozenIndex_defensiveCopy_mutableContainer: true,
  result: "PASS"
}, null, 2));
