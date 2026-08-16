import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { createConceptNode } from './src/BrainGrowth';",
      "export { createConceptIndex } from './src/BrainGrowthIndex';",
      "export {",
      "  BrainFormalizationWorkflow,",
      "  discoverConceptCandidates,",
      "  buildBrainFormalizationEvaluation",
      "} from './src/BrainFormalizationWorkflow';",
      "export {",
      "  parsePersonalSemanticIRResponse,",
      "  buildBrainFormalizationAnalysisMessages,",
      "  BRAIN_AWARE_FORMALIZATION_RULES",
      "} from './src/BrainAwareFormalizationAnalyzer';",
      "export { validateFormalizationInvariants } from './src/FormalizationProtocol';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "brain-formalization-workflow-entry.ts",
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
  createConceptNode,
  createConceptIndex,
  BrainFormalizationWorkflow,
  discoverConceptCandidates,
  buildBrainFormalizationEvaluation,
  parsePersonalSemanticIRResponse,
  buildBrainFormalizationAnalysisMessages,
  BRAIN_AWARE_FORMALIZATION_RULES,
  validateFormalizationInvariants
} = module.exports;

function userDefinition(id, text) {
  return {
    id,
    text,
    sourceRefs: [
      {
        sourceKind: "user_edit",
        editId: `edit-${id}`,
        snapshot: text,
        actor: "user"
      }
    ]
  };
}

function concept(input) {
  return createConceptNode({
    createdAt: "2026-01-01T00:00:00.000Z",
    ...input
  });
}

const normalOperator = concept({
  id: "concept-normal-operator",
  title: "Normal Operator",
  aliases: ["正规算子"],
  userDefinition: userDefinition(
    "def-normal",
    "A bounded operator commuting with its adjoint."
  ),
  standardDefinitions: [
    {
      id: "std-normal",
      text: "An operator T with T*T = TT*.",
      sourceReferences: []
    }
  ]
});

const unrelated = concept({
  id: "concept-unrelated",
  title: "Unrelated Personal Note",
  aliases: []
});

const spaceA = concept({ id: "concept-space-a", title: "Space" });
const spaceB = concept({ id: "concept-space-b", title: "Space" });

function makeAnalysis(overrides = {}) {
  return {
    speechAct: "proof_sketch",
    canonicalStatement:
      "Every normal operator has an orthonormal eigenbasis.",
    quantifiers: "For every normal operator T",
    conclusion: "T has an orthonormal basis of eigenvectors.",
    conceptBindings: [
      { surfacePhrase: "normal operator" }
    ],
    objects: [
      { name: "T", domain: "operator", boundPhrase: "normal operator" }
    ],
    claims: [
      {
        kind: "theorem",
        statement: "Every normal operator has an orthonormal eigenbasis.",
        quantifiers: "For every normal operator T",
        sourceQuantifiers: "For every normal operator T",
        authority: "user_authoritative"
      }
    ],
    assumptions: [
      {
        text: "T acts on a finite-dimensional space.",
        kind: "implicit",
        addedByAI: true
      }
    ],
    relations: [],
    proofSteps: [
      {
        kind: "invoke_known_claim",
        description: "Invoke the spectral theorem.",
        referencedPhrases: ["normal operator"],
        assumptionIndexes: [0]
      }
    ],
    ambiguities: [],
    resolvedAmbiguities: [],
    missingConditions: [],
    removedAssumptions: [],
    semanticChanges: [
      {
        category: "added_assumption",
        description: "Assumed finite-dimensionality.",
        relatedAssumptionIndexes: [0]
      }
    ],
    ...overrides
  };
}

function mockAnalyzer(result) {
  return {
    analyze: async () => result
  };
}

function makeWorkflow({
  source = {
    messageId: "msg-1",
    snapshot: "Let T be a normal operator."
  },
  concepts = [normalOperator, unrelated],
  analysis = makeAnalysis()
} = {}) {
  return new BrainFormalizationWorkflow({
    source,
    conceptIndex: createConceptIndex(concepts),
    analyzer: mockAnalyzer(analysis),
    claimId: "claim-live-1"
  });
}

// ── T01: workflow start builds an AI-interpreted proposal ──────────────
const workflow = makeWorkflow();
await workflow.start();
const state = workflow.getState();
assert.equal(state.phase, "proposed");
assert.ok(state.ir);
assert.equal(state.ir.authority, "ai_interpreted");
assert.equal(state.ir.source.messageId, "msg-1");
assert.equal(state.ir.source.snapshot, "Let T be a normal operator.");
assert.equal(state.ir.conceptBindings[0].status, "resolved");
assert.equal(state.ir.conceptBindings[0].conceptId, "concept-normal-operator");
assert.ok(state.semanticDiff.some((entry) => entry.kind === "assumption_added"));
assert.equal(state.validationFailures.length, 0);
console.log("T01 PASS: workflow start");

// ── T02: discovery is local and bounded ────────────────────────────────
const discovered = discoverConceptCandidates(
  "Let T be a normal operator.",
  createConceptIndex([normalOperator, unrelated])
);
assert.deepEqual(
  Array.from(discovered.map((candidate) => candidate.surfacePhrase)),
  ["Normal Operator"]
);
assert.equal(
  Array.from(discovered[0].alternatives.map((alt) => alt.conceptId))[0],
  "concept-normal-operator"
);
console.log("T02 PASS: candidate discovery");

// ── T03: accept projects into FormalizationProtocol with linkage ───────
const acceptWorkflow = makeWorkflow();
await acceptWorkflow.start();
const accepted = await acceptWorkflow.accept();
assert.equal(accepted.ok, true);
assert.equal(accepted.record.reviewStatus, "pending");
assert.equal(accepted.record.verificationStatus, "not_checked");
assert.deepEqual(
  Array.from(validateFormalizationInvariants(accepted.record)),
  []
);
assert.equal(accepted.linkage.irId, acceptWorkflow.getState().ir.id);
assert.equal(accepted.linkage.recordId, accepted.record.id);
assert.equal(accepted.linkage.claimId, "claim-live-1");
const evaluation = buildBrainFormalizationEvaluation(acceptWorkflow.getState());
assert.equal(evaluation.formalizationCreated, true);
assert.equal(evaluation.addedImplicitAssumptionCount, 1);
assert.ok(evaluation.semanticDiffCategories.includes("assumption_added"));
console.log("T03 PASS: accept and FormalizationProtocol handoff");

// ── T04: reject creates no record ──────────────────────────────────────
const rejectWorkflow = makeWorkflow();
await rejectWorkflow.start();
await rejectWorkflow.reject("Not what I meant");
const rejectedState = rejectWorkflow.getState();
assert.equal(rejectedState.phase, "rejected");
assert.equal(rejectedState.record, undefined);
assert.equal(
  buildBrainFormalizationEvaluation(rejectedState).rejected,
  true
);
console.log("T04 PASS: reject");

// ── T05: edit is preserved as review provenance ────────────────────────
const editWorkflow = makeWorkflow();
await editWorkflow.start();
await editWorkflow.edit({
  canonicalStatement: "Every normal operator T has a basis of eigenvectors.",
  quantifiers: "For every normal operator T"
});
const editedState = editWorkflow.getState();
assert.equal(editedState.edited, true);
assert.equal(
  editedState.ir.canonicalStatement,
  "Every normal operator T has a basis of eigenvectors."
);
console.log("T05 PASS: edit");

// ── T06: ambiguous binding requires explicit selection ─────────────────
const ambiguousWorkflow = makeWorkflow({
  source: { messageId: "msg-space", snapshot: "Space is finite-dimensional." },
  concepts: [spaceA, spaceB],
  analysis: makeAnalysis({
    canonicalStatement: "Space is finite-dimensional.",
    conceptBindings: [{ surfacePhrase: "Space" }],
    objects: [{ name: "S", domain: "space", boundPhrase: "Space" }]
  })
});
await ambiguousWorkflow.start();
const ambiguousState = ambiguousWorkflow.getState();
const ambiguousBinding = ambiguousState.ir.conceptBindings[0];
assert.equal(ambiguousBinding.status, "ambiguous");

const blocked = await ambiguousWorkflow.accept();
assert.equal(blocked.ok, false);
assert.match(blocked.error, /ambiguous/);

await ambiguousWorkflow.selectConcept(ambiguousBinding.id, "concept-space-a");
const selected = await ambiguousWorkflow.accept();
assert.equal(selected.ok, true);
assert.equal(
  ambiguousWorkflow.getState().ir.conceptBindings[0].conceptId,
  "concept-space-a"
);
console.log("T06 PASS: ambiguous concept selection");

// ── T07: missing concept remains unresolved ────────────────────────────
const missingWorkflow = makeWorkflow({
  source: { messageId: "msg-missing", snapshot: "A frobnicator is self-adjoint." },
  analysis: makeAnalysis({
    canonicalStatement: "A frobnicator is self-adjoint.",
    conceptBindings: [{ surfacePhrase: "frobnicator" }],
    objects: [{ name: "F", boundPhrase: "frobnicator" }]
  })
});
await missingWorkflow.start();
assert.equal(
  missingWorkflow.getState().ir.conceptBindings[0].status,
  "unresolved"
);
console.log("T07 PASS: missing concept unresolved");

// ── T08: analysis failure is isolated, no Brain write ──────────────────
let capturedInput = undefined;
const failWorkflow = new BrainFormalizationWorkflow({
  source: { messageId: "msg-fail", snapshot: "Every A is P." },
  conceptIndex: createConceptIndex([normalOperator, unrelated]),
  analyzer: {
    analyze: async (input) => {
      capturedInput = input;
      return { error: "simulated transport failure" };
    }
  },
  claimId: "claim-fail"
});
await failWorkflow.start();
assert.equal(failWorkflow.getState().phase, "error");
assert.equal(failWorkflow.getState().ir, undefined);
assert.equal(failWorkflow.getState().error, "simulated transport failure");
console.log("T08 PASS: failure isolation");

// ── T09: invalid proof dependency fails safely ─────────────────────────
const invalidWorkflow = makeWorkflow({
  analysis: makeAnalysis({
    proofSteps: [
      {
        kind: "derive_claim",
        description: "Dependency out of range.",
        dependencies: [5]
      }
    ]
  })
});
await invalidWorkflow.start();
assert.equal(invalidWorkflow.getState().phase, "error");
assert.equal(invalidWorkflow.getState().ir, undefined);
console.log("T09 PASS: invalid proof dependency safe failure");

// ── T10: privacy payload is bounded ─────────────────────────────────────
const payloadInput = {
  sourceText: "Let T be a normal operator.",
  candidates: discoverConceptCandidates(
    "Let T be a normal operator.",
    createConceptIndex([normalOperator, unrelated])
  ),
  conceptContext: [
    {
      conceptId: "concept-normal-operator",
      title: "Normal Operator",
      revision: 1,
      aliases: ["正规算子"],
      personalDefinition: "A bounded operator commuting with its adjoint.",
      standardDefinition: "An operator T with T*T = TT*.",
      definitionConflict: true,
      relevantRelationships: []
    }
  ]
};
const messages = buildBrainFormalizationAnalysisMessages(payloadInput);
const payloadText = messages.map((message) => message.content).join("\n");
assert.match(payloadText, /concept-normal-operator/);
assert.match(payloadText, /personal definition differs/);
assert.doesNotMatch(payloadText, /Unrelated Personal Note/);
assert.doesNotMatch(payloadText, /sk-/);
assert.doesNotMatch(payloadText, /api[_-]?key/i);
assert.equal(BRAIN_AWARE_FORMALIZATION_RULES.length, 14);
console.log("T10 PASS: privacy payload");

// ── T11: analyzer parse covers core mathematical shapes ────────────────
const parsed = parsePersonalSemanticIRResponse({
  speechAct: "theorem_claim",
  canonicalStatement: "Every A is P.",
  quantifiers: "For every A",
  conclusion: "A has P.",
  conceptBindings: [{ surfacePhrase: "A" }],
  objects: [{ name: "A" }],
  claims: [
    {
      kind: "theorem",
      statement: "Every A is P.",
      quantifiers: "For every A",
      sourceQuantifiers: "For every A"
    }
  ],
  assumptions: [{ text: "A exists.", kind: "implicit", addedByAI: true }],
  relations: [],
  proofSteps: [],
  ambiguities: [],
  resolvedAmbiguities: [],
  missingConditions: [],
  removedAssumptions: [],
  semanticChanges: [
    {
      category: "added_assumption",
      description: "Assumed A exists.",
      relatedAssumptionIndexes: [0]
    }
  ]
});
assert.equal(parsed.speechAct, "theorem_claim");
assert.equal(parsed.canonicalStatement, "Every A is P.");
assert.equal(parsed.conceptBindings[0].surfacePhrase, "A");
assert.equal(parsed.assumptions[0].addedByAI, true);
console.log("T11 PASS: analyzer parse");

// ── T12: semantic safety traps are preserved verbatim ──────────────────
const implies = parsePersonalSemanticIRResponse({
  speechAct: "theorem_claim",
  canonicalStatement: "A implies B.",
  quantifiers: "",
  conclusion: "B follows from A.",
  conceptBindings: [],
  objects: [],
  claims: [{ kind: "theorem", statement: "A implies B." }],
  assumptions: [],
  relations: [],
  proofSteps: [],
  ambiguities: [],
  resolvedAmbiguities: [],
  missingConditions: [],
  removedAssumptions: [],
  semanticChanges: []
});
assert.equal(implies.canonicalStatement, "A implies B.");
assert.notEqual(implies.canonicalStatement, "A iff B.");

const analogy = parsePersonalSemanticIRResponse({
  speechAct: "intuition",
  canonicalStatement: "A is analogous to B.",
  quantifiers: "",
  conclusion: "A and B share structure but are not identical.",
  conceptBindings: [],
  objects: [],
  claims: [{ kind: "intuition", statement: "A is analogous to B." }],
  assumptions: [],
  relations: [],
  proofSteps: [],
  ambiguities: [],
  resolvedAmbiguities: [],
  missingConditions: [],
  removedAssumptions: [],
  semanticChanges: []
});
assert.equal(analogy.canonicalStatement, "A is analogous to B.");
assert.notEqual(analogy.canonicalStatement, "A = B.");
console.log("T12 PASS: semantic safety traps");

console.log("brain-formalization-workflow.test.mjs PASS");
