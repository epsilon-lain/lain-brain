import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/KnowledgeProtocol';",
      "export { createSemanticSpec } from './src/SemanticSpec';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "knowledge-protocol-entry.ts",
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
  DOMMatrix: class { constructor(){} },
  module,
  exports: module.exports,
  require,
  console,
  crypto: { randomUUID: () => "knowledge-test-id" },
  setTimeout,
  clearTimeout
});

const {
  validateUserConclusion,
  createUserConclusion,
  validateProtocolArtifact,
  validateKnowledgeProtocolGraph,
  deriveMirroredProtocolEdges,
  reviewUserKnowledgeEdge,
  createSemanticSpec
} = module.exports;

const now = "2026-08-10T00:00:00.000Z";

function messageSpan(messageId, snapshot, overrides = {}) {
  return {
    sourceKind: "message_span",
    messageId,
    snapshot,
    actor: "user",
    ...overrides
  };
}

function conclusion(id, text, overrides = {}) {
  return createUserConclusion({
    id,
    text,
    sourceRefs: [messageSpan(`message-${id}`, text)],
    kind: "other",
    protocolArtifactIds: [],
    createdAt: now,
    ...overrides
  });
}

function graph(conclusions, artifacts = [], protocolLinks = [], userEdges = []) {
  return { conclusions, artifacts, protocolLinks, userEdges };
}

// A — exact natural-language ownership
{
  const text = "一个复数加上0还是它自己。";
  const userConclusion = conclusion("complex-zero", text, {
    kind: "mathematical_claim"
  });

  assert.equal(validateUserConclusion(userConclusion).length, 0);
  assert.equal(userConclusion.text, text);
  assert.equal(userConclusion.sourceRefs[0].snapshot, text);
  assert.equal(userConclusion.sourceRefs[0].actor, "user");
  assert.equal(userConclusion.sourceRefs.length, 1);
  assert.ok(Object.isFrozen(userConclusion));
  assert.ok(Object.isFrozen(userConclusion.sourceRefs));
  assert.ok(Object.isFrozen(userConclusion.sourceRefs[0]));
  console.log("KNOWLEDGE-A PASS: exact user language is authoritative with user provenance");
}

// B — Lean is an optional backend
{
  const text = "一个复数加上0还是它自己。";
  const lean = {
    id: "lean-complex-zero",
    userConclusionId: "complex-zero",
    kind: "lean",
    formalStatement: "∀ z : ℂ, z + 0 = z",
    createdAt: now
  };
  const withLean = conclusion("complex-zero", text, {
    kind: "mathematical_claim",
    protocolArtifactIds: [lean.id]
  });
  const formalizes = {
    id: "link-complex-zero-lean",
    userConclusionId: withLean.id,
    protocolArtifactId: lean.id,
    relation: "formalizes",
    createdAt: now
  };

  assert.equal(validateKnowledgeProtocolGraph(graph([withLean], [lean], [formalizes])).length, 0);
  assert.equal(lean.userConclusionId, withLean.id);
  assert.equal(withLean.text, text);

  const withoutLean = { ...withLean, protocolArtifactIds: [] };
  assert.equal(validateUserConclusion(withoutLean).length, 0);
  assert.equal(validateKnowledgeProtocolGraph(graph([withoutLean])).length, 0);
  console.log("KNOWLEDGE-B PASS: Lean points back to, but is not required by, UserConclusion");
}

// C — linguistic relations remain backend-neutral SemanticSpec content
{
  const text = "A梦到B";
  const sourceRef = { id: "src-dream", messageId: "message-dream", snapshot: text };
  const semanticSpec = createSemanticSpec({
    claimId: "dream-conclusion",
    sourceRefs: [sourceRef],
    symbols: [
      { id: "sym-a", surface: "A", role: "entity", sourceRefIds: [sourceRef.id] },
      { id: "sym-b", surface: "B", role: "entity", sourceRefIds: [sourceRef.id] },
      {
        id: "sym-dreams",
        surface: "梦到",
        role: "relation",
        userDefined: true,
        sourceRefIds: [sourceRef.id]
      }
    ],
    expressions: [
      { id: "expr-a", kind: "symbol_ref", symbolId: "sym-a" },
      { id: "expr-b", kind: "symbol_ref", symbolId: "sym-b" },
      {
        id: "expr-dreams",
        kind: "application",
        operatorSymbolId: "sym-dreams",
        argumentExprIds: ["expr-a", "expr-b"]
      }
    ],
    statements: [{ id: "statement-dream", kind: "assertion", exprId: "expr-dreams" }],
    ambiguities: []
  });
  const userConclusion = conclusion("dream-conclusion", text, {
    semanticSpecId: semanticSpec.id,
    kind: "custom_world_rule"
  });

  assert.equal(semanticSpec.reviewStatus, "pending");
  assert.equal(semanticSpec.analysisStatus, "ready_for_review");
  assert.equal(semanticSpec.symbols.find((item) => item.id === "sym-dreams").surface, "梦到");
  assert.equal(semanticSpec.symbols.find((item) => item.id === "sym-dreams").role, "relation");
  assert.equal(userConclusion.protocolArtifactIds.length, 0);
  assert.equal(validateUserConclusion(userConclusion).length, 0);
  console.log("KNOWLEDGE-C PASS: linguistic relation is valid without Lean or graph substitution");
}

// D — semantic understanding and empirical validation are separate
{
  const text = "天下乌鸦一般黑";
  const counterexample = {
    id: "counterexample-white-crow",
    userConclusionId: "crow-claim",
    kind: "counterexample",
    description: "A counterexample supplied for empirical review.",
    sourceReferences: ["user-provided-reference"],
    createdAt: now
  };
  const userConclusion = conclusion("crow-claim", text, {
    kind: "empirical_claim",
    protocolArtifactIds: [counterexample.id]
  });
  const refutes = {
    id: "link-crow-counterexample",
    userConclusionId: userConclusion.id,
    protocolArtifactId: counterexample.id,
    relation: "refutes",
    createdAt: now
  };

  assert.equal(validateKnowledgeProtocolGraph(graph([userConclusion], [counterexample], [refutes])).length, 0);
  assert.equal(refutes.relation, "refutes");
  assert.equal(counterexample.kind, "counterexample");
  assert.equal(userConclusion.protocolArtifactIds.some((id) => id.startsWith("lean")), false);
  console.log("KNOWLEDGE-D PASS: accepted meaning can be empirically refuted without Lean failure");
}

// E — user-defined worlds are legitimate and need no Mathlib identity
{
  const text = "定义一个无穷物件时间尺度。";
  const customWorld = {
    id: "custom-world-time-scale",
    userConclusionId: "infinite-time-scale",
    kind: "custom_world",
    conceptName: "无穷物件时间尺度",
    status: "defined",
    semanticSpecId: "semantic-infinite-time-scale",
    createdAt: now
  };
  const userConclusion = conclusion("infinite-time-scale", text, {
    semanticSpecId: "semantic-infinite-time-scale",
    kind: "definition",
    protocolArtifactIds: [customWorld.id]
  });
  const defines = {
    id: "link-custom-world-definition",
    userConclusionId: userConclusion.id,
    protocolArtifactId: customWorld.id,
    relation: "defines",
    createdAt: now
  };

  assert.equal(validateProtocolArtifact(customWorld).length, 0);
  assert.equal(validateKnowledgeProtocolGraph(graph([userConclusion], [customWorld], [defines])).length, 0);
  assert.equal(customWorld.conceptName, "无穷物件时间尺度");
  assert.equal(customWorld.status, "defined");
  assert.equal(userConclusion.protocolArtifactIds.length, 1);
  console.log("KNOWLEDGE-E PASS: custom world retains its own name and requires no Lean artifact");
}

// F — human graph is authoritative; protocol edges are disposable mirrors
{
  const conclusionA = conclusion("human-a", "结论A", {
    protocolArtifactIds: ["lean-a"]
  });
  const conclusionB = conclusion("human-b", "结论B", {
    protocolArtifactIds: ["lean-b"]
  });
  const leanA = {
    id: "lean-a",
    userConclusionId: conclusionA.id,
    kind: "lean",
    formalStatement: "A",
    createdAt: now
  };
  const leanB = {
    id: "lean-b",
    userConclusionId: conclusionB.id,
    kind: "lean",
    formalStatement: "B",
    createdAt: now
  };
  const userEdge = {
    id: "edge-a-b",
    fromUserConclusionId: conclusionA.id,
    toUserConclusionId: conclusionB.id,
    relation: "supports",
    proposedBy: "ai",
    reviewStatus: "pending",
    createdAt: now
  };

  assert.equal(deriveMirroredProtocolEdges([userEdge], [leanA, leanB]).length, 0);
  const acceptedUserEdge = reviewUserKnowledgeEdge(
    userEdge,
    "accepted",
    "2026-08-10T00:01:00.000Z"
  );
  const mirrors = deriveMirroredProtocolEdges([acceptedUserEdge], [leanA, leanB]);
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0].fromProtocolArtifactId, leanA.id);
  assert.equal(mirrors[0].toProtocolArtifactId, leanB.id);
  assert.equal(mirrors[0].origin, "mirrored_user_edge");
  assert.equal(mirrors[0].userKnowledgeEdgeId, acceptedUserEdge.id);
  assert.ok(Object.isFrozen(mirrors));
  assert.ok(Object.isFrozen(mirrors[0]));

  const withoutLeanB = deriveMirroredProtocolEdges([acceptedUserEdge], [leanA]);
  assert.equal(withoutLeanB.length, 0);
  assert.equal(userEdge.fromUserConclusionId, conclusionA.id);
  assert.equal(userEdge.toUserConclusionId, conclusionB.id);
  assert.equal(validateKnowledgeProtocolGraph(graph(
    [{ ...conclusionA, protocolArtifactIds: [leanA.id] }, { ...conclusionB, protocolArtifactIds: [] }],
    [leanA],
    [],
    [acceptedUserEdge]
  )).length, 0);
  console.log("KNOWLEDGE-F PASS: protocol mirror disappears without changing authoritative human edge");
}

// G — AI prose cannot masquerade as user-authored primary text
{
  const invalid = {
    ...conclusion("ai-prose-template", "AI rewritten explanation"),
    id: "ai-prose",
    sourceRefs: [{
      sourceKind: "message_span",
      messageId: "assistant-message",
      snapshot: "AI rewritten explanation",
      actor: "assistant"
    }]
  };
  const errors = validateUserConclusion(invalid);
  assert.ok(errors.some((error) => error.path === "sourceRefs.0.actor"));

  const rewritten = {
    ...conclusion("rewritten-template", "AI rewritten explanation"),
    id: "rewritten",
    sourceRefs: [messageSpan("user-message", "original user words")]
  };
  const mismatchErrors = validateUserConclusion(rewritten);
  assert.ok(mismatchErrors.some((error) => error.path === "text"));

  const userEdit = conclusion("user-edit", "用户明确编辑后的文字", {
    sourceRefs: [{
      sourceKind: "user_edit",
      editId: "edit-1",
      snapshot: "用户明确编辑后的文字",
      actor: "user"
    }]
  });
  assert.equal(validateUserConclusion(userEdit).length, 0);
  console.log("KNOWLEDGE-G PASS: AI provenance and rewritten mismatches rejected; explicit user edit accepted");
}

console.log(JSON.stringify({
  scenarioA_exactUserLanguage: true,
  scenarioB_optionalLean: true,
  scenarioC_linguisticRelation: true,
  scenarioD_empiricalSeparation: true,
  scenarioE_customWorld: true,
  scenarioF_authoritativeHumanGraph: true,
  scenarioG_aiCannotMasquerade: true,
  networkRequests: 0,
  result: "PASS"
}, null, 2));
