import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { createPersonalSemanticIR } from './src/PersonalSemanticIR';",
      "export { createFormalizationRecord } from './src/FormalizationProtocol';",
      "export { createConceptNode } from './src/BrainGrowth';",
      "export { createConceptIndex } from './src/BrainGrowthIndex';",
      "export {",
      "  adaptPersonalSemanticIRToFormalization,",
      "  buildBrainAwareFormalizationContext,",
      "  renderBrainAwareFormalizationContext,",
      "  BRAIN_AWARE_INTERPRETATION_RULES",
      "} from './src/FormalizationAdapter';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "formalization-adapter-entry.ts",
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
  createPersonalSemanticIR,
  createFormalizationRecord,
  createConceptNode,
  createConceptIndex,
  adaptPersonalSemanticIRToFormalization,
  buildBrainAwareFormalizationContext,
  renderBrainAwareFormalizationContext,
  BRAIN_AWARE_INTERPRETATION_RULES
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

function makeIR(overrides = {}) {
  return createPersonalSemanticIR({
    source: {
      messageId: "msg-proof",
      snapshot: "Let T be a normal operator. By the spectral theorem, T has an orthonormal eigenbasis."
    },
    originalExpression:
      "Let T be a normal operator. By the spectral theorem, T has an orthonormal eigenbasis.",
    speechAct: "proof_sketch",
    authority: "ai_interpreted",
    canonicalStatement:
      "For every normal operator T on a finite-dimensional inner product space, " +
      "there exists an orthonormal basis of eigenvectors of T.",
    quantifiers: "For every normal operator T",
    conclusion: "T has an orthonormal basis of eigenvectors.",
    conceptBindings: [
      {
        id: "bind-normal",
        surfacePhrase: "normal operator",
        status: "resolved",
        conceptId: "concept-normal-operator",
        conceptRevision: 1,
        resolvedTitle: "Normal Operator",
        resolutionMethod: "exact_title"
      }
    ],
    objects: [
      { id: "obj-T", name: "T", domain: "operator", boundConceptId: "bind-normal" }
    ],
    claims: [
      {
        id: "claim-main",
        kind: "theorem",
        statement: "Every normal operator has an orthonormal eigenbasis.",
        quantifiers: "For every normal operator T",
        sourceQuantifiers: "For every normal operator T",
        authority: "user_authoritative"
      }
    ],
    assumptions: [
      {
        id: "asmp-finite",
        text: "T acts on a finite-dimensional space.",
        kind: "implicit",
        addedByAI: true
      }
    ],
    relations: [],
    proofSteps: [],
    unresolvedItems: [],
    ambiguities: [],
    resolvedAmbiguities: [],
    missingConditions: [],
    removedAssumptions: [],
    semanticChanges: [],
    originatingConceptRevisions: [
      {
        conceptId: "concept-normal-operator",
        revision: 1,
        title: "Normal Operator",
        matchedBy: "exact_title"
      }
    ],
    ...overrides
  });
}

// ── T01: deterministic projection into FormalizationProtocol ──────────
const ir = makeIR();
const adapted = adaptPersonalSemanticIRToFormalization(ir, "claim-test");
assert.equal(adapted.ok, true);
assert.equal(adapted.params.speechAct, "proof_sketch");
assert.equal(adapted.params.quantifiers, "For every normal operator T");
assert.equal(adapted.params.conclusion, "T has an orthonormal basis of eigenvectors.");
assert.equal(
  adapted.params.aiNormalizedStatement,
  "For every normal operator T on a finite-dimensional inner product space, " +
  "there exists an orthonormal basis of eigenvectors of T."
);
assert.equal(adapted.params.objects[0].name, "T");
assert.equal(adapted.params.sourceRefs[0].messageId, "msg-proof");
assert.equal(adapted.conceptBindings.length, 1);
assert.equal(adapted.originatingConceptRevisions.length, 1);

const record = createFormalizationRecord(adapted.params);
assert.equal(record.reviewStatus, "pending");
assert.equal(record.verificationStatus, "not_checked");
assert.equal(record.analysisStatus, "ready_for_review");
console.log("T01 PASS: adapter projects IR into FormalizationProtocol");

// ── T02: implicit assumptions are made explicit for the existing invariant
const noChanges = makeIR({ semanticChanges: [] });
const noChangesAdapted = adaptPersonalSemanticIRToFormalization(noChanges, "claim-test");
assert.equal(noChangesAdapted.ok, true);
const noChangesRecord = createFormalizationRecord(noChangesAdapted.params);
assert.equal(noChangesRecord.implicitAssumptions.length, 1);
assert.equal(noChangesRecord.semanticChanges.length, 1);
assert.equal(
  noChangesRecord.semanticChanges[0].relatedAssumptionIds[0],
  "asmp-finite"
);
console.log("T02 PASS: adapter guarantees existing implicit-assumption invariant");

// ── T03: Brain-aware context is bounded and privacy-preserving ─────────
const normal = createConceptNode({
  id: "concept-normal-operator",
  title: "Normal Operator",
  aliases: ["正规算子"],
  createdAt: "2026-01-01T00:00:00.000Z",
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
  ],
  relationships: [
    {
      id: "rel-adjoint",
      relation: "generalizes",
      targetConceptId: "concept-self-adjoint",
      targetLabel: "Self-adjoint Operator",
      sourceReferences: []
    }
  ]
});
const unrelated = createConceptNode({
  id: "concept-unrelated",
  title: "Unrelated Personal Note",
  createdAt: "2026-01-01T00:00:00.000Z"
});
const index = createConceptIndex([normal, unrelated]);

const context = buildBrainAwareFormalizationContext(ir, index);
assert.deepEqual(
  Array.from(context.conceptContext.map((item) => item.conceptId)),
  ["concept-normal-operator"]
);
assert.equal(context.conceptContext[0].definitionConflict, true);
assert.equal(
  context.conceptContext[0].personalDefinition,
  "A bounded operator commuting with its adjoint."
);
assert.equal(
  context.conceptContext[0].standardDefinition,
  "An operator T with T*T = TT*."
);

const contextText = renderBrainAwareFormalizationContext(context);
assert.match(contextText, /concept-normal-operator@1/);
assert.match(contextText, /WARNING: personal definition differs/);
assert.doesNotMatch(contextText, /Unrelated Personal Note/);
console.log("T03 PASS: Brain-aware bounded context and personal-definition warning");

// ── T04: DeepSeek is translator, not authority ─────────────────────────
assert.equal(BRAIN_AWARE_INTERPRETATION_RULES.length, 12);
assert.ok(
  BRAIN_AWARE_INTERPRETATION_RULES.some((rule) =>
    /Never claim Lean verification/.test(rule)
  )
);
assert.ok(
  BRAIN_AWARE_INTERPRETATION_RULES.some((rule) =>
    /Do not replace personal definitions/.test(rule)
  )
);
console.log("T04 PASS: DeepSeek boundary rules");

console.log("formalization-adapter.test.mjs PASS");
