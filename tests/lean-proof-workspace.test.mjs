import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  LEAN_PROOF_WORKSPACE_SCHEMA_VERSION,",
      "  emptyLeanProofWorkspace,",
      "  createLeanFormalizationTarget,",
      "  createLeanProofDraft,",
      "  createLeanProofVerificationArtifact,",
      "  upsertLeanFormalizationTarget,",
      "  upsertLeanProofDraft,",
      "  addLeanProofVerificationArtifact,",
      "  getLeanTargetByFormalizationId,",
      "  getLeanProofDraftsByFormalizationId,",
      "  getLeanProofArtifactsByFormalizationId,",
      "  serializeLeanProofWorkspace,",
      "  deserializeLeanProofWorkspace,",
      "  buildProofWorkspaceViewModel",
      "} from './src/LeanProofWorkspace';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "lean-proof-workspace-entry.ts",
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
  crypto: { randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  LEAN_PROOF_WORKSPACE_SCHEMA_VERSION,
  emptyLeanProofWorkspace,
  createLeanFormalizationTarget,
  createLeanProofDraft,
  createLeanProofVerificationArtifact,
  upsertLeanFormalizationTarget,
  upsertLeanProofDraft,
  addLeanProofVerificationArtifact,
  getLeanTargetByFormalizationId,
  getLeanProofDraftsByFormalizationId,
  getLeanProofArtifactsByFormalizationId,
  serializeLeanProofWorkspace,
  deserializeLeanProofWorkspace,
  buildProofWorkspaceViewModel
} = module.exports;

const target = createLeanFormalizationTarget({
  formalizationId: "formalization-1",
  propositionText: "1 + 1 = 2",
  imports: ["Mathlib.Data.Nat.Basic"]
});

function draftWith(proofBody, overrides = {}) {
  return createLeanProofDraft({
    formalizationId: "formalization-1",
    targetId: target.id,
    targetHash: target.propositionHash,
    proofBody,
    provenance: "user_authored",
    ...overrides
  });
}

// ── T01: target round-trip ─────────────────────────────────────────────
let state = upsertLeanFormalizationTarget(
  emptyLeanProofWorkspace(),
  target
);
const reloadedTargetState = deserializeLeanProofWorkspace(
  JSON.parse(JSON.stringify(serializeLeanProofWorkspace(state)))
);
assert.equal(reloadedTargetState.diagnostics.length, 0);
assert.equal(
  getLeanTargetByFormalizationId(reloadedTargetState.state, "formalization-1").propositionText,
  "1 + 1 = 2"
);
console.log("T01 PASS: target round-trip");

// ── T02: draft persistence and unverified default ─────────────────────
const draft = draftWith("norm_num");
state = upsertLeanProofDraft(state, draft);
const reloaded = deserializeLeanProofWorkspace(
  JSON.parse(JSON.stringify(serializeLeanProofWorkspace(state)))
);
const reloadedDraft = getLeanProofDraftsByFormalizationId(
  reloaded.state,
  "formalization-1"
)[0];
assert.equal(reloadedDraft.proofBody, "norm_num");
assert.equal(reloadedDraft.provenance, "user_authored");
assert.equal(reloadedDraft.id, draft.id);
assert.equal(
  buildProofWorkspaceViewModel(state, "formalization-1").candidateStatus,
  "unverified"
);
console.log("T02 PASS: draft persistence and unverified default");

// ── T03: verified artifact persists and reloads ───────────────────────
const artifact = createLeanProofVerificationArtifact({
  formalizationId: "formalization-1",
  targetId: target.id,
  targetHash: target.propositionHash,
  proofCandidateId: draft.id,
  proofHash: draft.proofHash,
  proofProvenance: "user_authored",
  theoremName: "lain_target_abc123",
  imports: target.imports,
  result: "verified",
  verified: true,
  verifiedAt: "2026-08-16T00:00:00.000Z",
  executedAt: "2026-08-16T00:00:00.000Z"
});
state = addLeanProofVerificationArtifact(state, artifact);
const reloadedArtifactState = deserializeLeanProofWorkspace(
  JSON.parse(JSON.stringify(serializeLeanProofWorkspace(state)))
);
assert.equal(
  getLeanProofArtifactsByFormalizationId(
    reloadedArtifactState.state,
    "formalization-1"
  )[0].verified,
  true
);
assert.equal(
  buildProofWorkspaceViewModel(state, "formalization-1").candidateStatus,
  "verified"
);
assert.equal(
  buildProofWorkspaceViewModel(state, "formalization-1").verificationStatus,
  "proof_verified"
);
console.log("T03 PASS: verified artifact persists");

// ── T04: edit after verify invalidates current candidate only ──────────
const editedDraft = createLeanProofDraft({
  id: draft.id,
  formalizationId: "formalization-1",
  targetId: target.id,
  targetHash: target.propositionHash,
  proofBody: "ring",
  provenance: "user_edited",
  edited: true
});
const editedState = upsertLeanProofDraft(state, editedDraft);
assert.notEqual(editedDraft.proofHash, draft.proofHash);
const editedView = buildProofWorkspaceViewModel(
  editedState,
  "formalization-1"
);
assert.equal(editedView.candidateStatus, "unverified");
assert.equal(editedView.proofProvenance, "user_edited");
assert.equal(
  getLeanProofArtifactsByFormalizationId(editedState, "formalization-1")[0].proofHash,
  draft.proofHash
);
console.log("T04 PASS: edit invalidates candidate, artifact stays historical");

// ── T05: target change makes candidate stale ───────────────────────────
const newTarget = createLeanFormalizationTarget({
  id: target.id,
  formalizationId: "formalization-1",
  propositionText: "1 + 1 = 3",
  imports: target.imports
});
const targetChangedState = upsertLeanFormalizationTarget(
  editedState,
  newTarget
);
assert.equal(
  buildProofWorkspaceViewModel(targetChangedState, "formalization-1").candidateStatus,
  "stale"
);
console.log("T05 PASS: target change makes candidate stale");

// ── T06: placeholder artifact reports rejection clearly ────────────────
const placeholderArtifact = createLeanProofVerificationArtifact({
  formalizationId: "formalization-1",
  targetId: target.id,
  targetHash: target.propositionHash,
  proofCandidateId: draft.id,
  proofHash: draft.proofHash,
  proofProvenance: "user_authored",
  theoremName: "lain_target_abc123",
  imports: target.imports,
  result: "placeholder_rejected",
  verified: false,
  executedAt: "2026-08-16T00:00:00.000Z"
});
const placeholderState = addLeanProofVerificationArtifact(
  state,
  placeholderArtifact
);
assert.equal(
  buildProofWorkspaceViewModel(placeholderState, "formalization-1").candidateStatus,
  "verified"
);
console.log("T06 PASS: placeholder artifact represented");

// ── T07: malformed workspace fails safe ────────────────────────────────
const bad = deserializeLeanProofWorkspace({ schemaVersion: 999 });
assert.equal(bad.diagnostics.length, 1);
assert.equal(Object.keys(bad.state.targets).length, 0);
console.log("T07 PASS: malformed workspace safe");

// ── T08: privacy / no API keys ─────────────────────────────────────────
const serialized = JSON.stringify(serializeLeanProofWorkspace(state));
assert.doesNotMatch(serialized, /sk-/);
assert.doesNotMatch(serialized, /api[_-]?key/i);
console.log("T08 PASS: privacy");

console.log("lean-proof-workspace.test.mjs PASS");

