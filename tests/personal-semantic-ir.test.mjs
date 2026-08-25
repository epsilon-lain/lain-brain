import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  PERSONAL_SEMANTIC_IR_SCHEMA_VERSION,",
      "  createPersonalSemanticIR,",
      "  validatePersonalSemanticIR,",
      "  serializePersonalSemanticIR,",
      "  deserializePersonalSemanticIR,",
      "  renderPersonalSemanticIR,",
      "  computeSemanticDiff,",
      "  renderSemanticDiff",
      "} from './src/PersonalSemanticIR';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "personal-semantic-ir-entry.ts",
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
  PERSONAL_SEMANTIC_IR_SCHEMA_VERSION,
  createPersonalSemanticIR,
  validatePersonalSemanticIR,
  serializePersonalSemanticIR,
  deserializePersonalSemanticIR,
  renderPersonalSemanticIR,
  computeSemanticDiff,
  renderSemanticDiff
} = module.exports;

function makeIR(overrides = {}) {
  return createPersonalSemanticIR({
    source: {
      messageId: "msg-1",
      snapshot: "Let T be a normal operator. There is an orthonormal basis."
    },
    originalExpression: "Let T be a normal operator. There is an orthonormal basis.",
    speechAct: "proof_sketch",
    authority: "ai_interpreted",
    canonicalStatement:
      "For every normal operator T on a finite-dimensional inner product space, " +
      "there exists an orthonormal basis consisting of eigenvectors of T.",
    quantifiers: "For every normal operator T",
    conclusion: "There exists an orthonormal basis of eigenvectors.",
    conceptBindings: [
      {
        id: "bind-normal",
        surfacePhrase: "normal operator",
        status: "resolved",
        conceptId: "concept-normal-operator",
        conceptRevision: 3,
        resolvedTitle: "Normal Operator",
        resolutionMethod: "exact_title",
        personalDefinition: "A bounded operator commuting with its adjoint.",
        standardDefinition: "An operator T with T*T = TT*."
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
        authority: "user_authoritative",
        boundConceptIds: ["bind-normal"]
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
    proofSteps: [
      {
        id: "step-1",
        kind: "invoke_known_claim",
        description: "Invoke the spectral theorem for normal operators.",
        outputClaimIds: ["claim-main"],
        referencedConceptIds: ["concept-normal-operator"],
        authority: "ai_interpreted"
      }
    ],
    unresolvedItems: [],
    ambiguities: [],
    resolvedAmbiguities: [],
    missingConditions: ["finite-dimensionality not stated"],
    removedAssumptions: [],
    semanticChanges: [
      {
        category: "added_assumption",
        description: "Assumed finite-dimensionality.",
        relatedAssumptionIds: ["asmp-finite"]
      }
    ],
    originatingConceptRevisions: [
      {
        conceptId: "concept-normal-operator",
        revision: 3,
        title: "Normal Operator",
        matchedBy: "exact_title"
      }
    ],
    ...overrides
  });
}

// ── T01: creation and source evidence ─────────────────────────────────
const ir = makeIR();
assert.equal(ir.schemaVersion, PERSONAL_SEMANTIC_IR_SCHEMA_VERSION);
assert.equal(ir.source.messageId, "msg-1");
assert.ok(ir.source.snapshot.length > 0);
assert.equal(ir.objects[0].name, "T");
assert.equal(ir.claims[0].authority, "user_authoritative");
assert.equal(ir.proofSteps.length, 1);
assert.equal(ir.assumptions[0].addedByAI, true);
assert.equal("leanStatement" in ir, false);
assert.equal("leanCode" in ir, false);
console.log("T01 PASS: IR creation, source evidence, and target independence");

// ── T02: deterministic serialization and round-trip ───────────────────
const first = JSON.stringify(serializePersonalSemanticIR(ir));
const second = JSON.stringify(serializePersonalSemanticIR(ir));
assert.equal(first, second);

const deserialized = deserializePersonalSemanticIR(JSON.parse(first));
assert.equal(deserialized.ok, true);
assert.equal(deserialized.ir.id, ir.id);
assert.equal(deserialized.ir.canonicalStatement, ir.canonicalStatement);
assert.deepEqual(
  Array.from(deserialized.ir.conceptBindings.map((b) => b.conceptId)),
  Array.from(ir.conceptBindings.map((b) => b.conceptId))
);
console.log("T02 PASS: deterministic serialization and round-trip");

// ── T03: unsupported schema fails safely ───────────────────────────────
const badSchema = deserializePersonalSemanticIR({ schemaVersion: 999 });
assert.equal(badSchema.ok, false);
assert.match(badSchema.error, /Unsupported/);
console.log("T03 PASS: unsupported schema safe failure");

// ── T04: structural validation failures ───────────────────────────────
// Build invalid shapes directly and feed them to the validator, since the
// factory intentionally rejects them.
const validPlain = JSON.parse(JSON.stringify(serializePersonalSemanticIR(ir)));

const missingRevision = JSON.parse(JSON.stringify(validPlain));
delete missingRevision.conceptBindings[0].conceptRevision;
assert.ok(
  validatePersonalSemanticIR(missingRevision).some(
    (f) => f.code === "resolved_binding_missing_concept"
  )
);

const nonImplicitAdded = JSON.parse(JSON.stringify(validPlain));
nonImplicitAdded.assumptions = [
  {
    id: "asmp-bad",
    text: "bad",
    kind: "explicit",
    addedByAI: true
  }
];
assert.ok(
  validatePersonalSemanticIR(nonImplicitAdded).some(
    (f) => f.code === "added_assumption_must_be_implicit"
  )
);

const badDependency = JSON.parse(JSON.stringify(validPlain));
badDependency.proofSteps = [
  {
    id: "step-2",
    kind: "derive_claim",
    description: "Derive a later claim.",
    dependencies: ["step-99"],
    authority: "ai_interpreted"
  }
];
assert.ok(
  validatePersonalSemanticIR(badDependency).some(
    (f) => f.code === "step_dependency_not_earlier"
  )
);
console.log("T04 PASS: structural validation failures");

// ── T05: proof steps are ordered and dependencies constrained ──────────
const ordered = makeIR({
  claims: [
    {
      id: "claim-a",
      kind: "proposition",
      statement: "A",
      authority: "ai_interpreted"
    },
    {
      id: "claim-b",
      kind: "proposition",
      statement: "B",
      authority: "ai_interpreted"
    }
  ],
  proofSteps: [
    {
      id: "step-1",
      kind: "assume_proposition",
      description: "Assume A.",
      outputClaimIds: ["claim-a"],
      authority: "ai_interpreted"
    },
    {
      id: "step-2",
      kind: "derive_claim",
      description: "Derive B from A.",
      inputClaimIds: ["claim-a"],
      outputClaimIds: ["claim-b"],
      dependencies: ["step-1"],
      authority: "ai_interpreted"
    }
  ]
});
assert.deepEqual(
  Array.from(validatePersonalSemanticIR(ordered)),
  []
);
assert.deepEqual(
  Array.from(ordered.proofSteps.map((s) => s.id)),
  ["step-1", "step-2"]
);
console.log("T05 PASS: ordered proof steps");

// ── T06: canonical renderer exposes concept bindings ───────────────────
const rendered = renderPersonalSemanticIR(ir);
assert.match(rendered, /Concept bindings:/);
assert.match(rendered, /normal operator/);
assert.match(rendered, /concept-normal-operator@3/);
assert.match(rendered, /personal:/);
assert.match(rendered, /standard:/);
console.log("T06 PASS: canonical renderer");

// ── T07: semantic diff flags meaningful changes ───────────────────────
const diff = computeSemanticDiff(
  makeIR({
    objects: [
      {
        id: "obj-T",
        name: "T",
        domain: "bounded linear operator",
        sourceDomain: "operator",
        boundConceptId: "bind-normal"
      }
    ],
    claims: [
      {
        id: "claim-main",
        kind: "theorem",
        statement: "Every normal operator has an orthonormal eigenbasis.",
        quantifiers: "For every normal operator T",
        sourceQuantifiers: "For some normal operator T",
        authority: "user_authoritative",
        semanticChangeKind: "strengthened"
      }
    ],
    resolvedAmbiguities: ["whether T is bounded"],
    proofSteps: [
      {
        id: "step-1",
        kind: "unresolved_inference",
        description: "A missing justification.",
        unresolvedAssumptionIds: ["asmp-finite"],
        authority: "ai_interpreted"
      }
    ]
  })
);

const kinds = diff.map((entry) => entry.kind);
assert.ok(kinds.includes("assumption_added"));
assert.ok(kinds.includes("quantifier_changed"));
assert.ok(kinds.includes("domain_changed"));
assert.ok(kinds.includes("claim_strengthened"));
assert.ok(kinds.includes("concept_resolved"));
assert.ok(kinds.includes("ambiguity_resolved"));
assert.ok(kinds.includes("inference_gap"));

const diffText = renderSemanticDiff(diff);
assert.match(diffText, /assumption_added/);
assert.match(diffText, /quantifier_changed/);
console.log("T07 PASS: semantic diff");

// ── T08: meaning-preservation traps are representable ─────────────────
function trapIR(statement, kind = "proposition", extra = {}) {
  return createPersonalSemanticIR({
    source: { messageId: "msg-trap", snapshot: statement },
    originalExpression: statement,
    speechAct: "theorem_claim",
    authority: "ai_interpreted",
    canonicalStatement: statement,
    quantifiers: "",
    conclusion: statement,
    claims: [
      {
        id: "claim-trap",
        kind,
        statement,
        authority: "user_authoritative",
        ...extra
      }
    ],
    ...extra
  });
}

const every = trapIR("Every A has property P.");
assert.match(every.canonicalStatement, /Every A has property P/);
assert.doesNotMatch(every.canonicalStatement, /Some A has property P/);

const implies = trapIR("A implies B.");
assert.match(implies.canonicalStatement, /A implies B/);
assert.doesNotMatch(implies.canonicalStatement, /A iff B/);

const subset = trapIR("A is contained in B.");
assert.match(subset.canonicalStatement, /contained in/);
assert.doesNotMatch(subset.canonicalStatement, /A = B/);

const analogy = trapIR("A is analogous to B.", "intuition");
assert.match(analogy.canonicalStatement, /analogous to/);
assert.doesNotMatch(analogy.canonicalStatement, /A and B are the same/);
console.log("T08 PASS: meaning-preservation traps");

console.log("personal-semantic-ir.test.mjs PASS");
