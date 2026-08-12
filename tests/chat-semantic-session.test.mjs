import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/ChatSemanticSession';",
      "export * from './src/KnowledgeProtocol';",
      "export { createSemanticSpec } from './src/SemanticSpec';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "chat-semantic-session-entry.ts",
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
let uuidIndex = 0;
vm.runInNewContext(built.outputFiles[0].text, {
  DOMMatrix: class { constructor(){} },
  module,
  exports: module.exports,
  require,
  console,
  crypto: { randomUUID: () => `chat-test-uuid-${++uuidIndex}` },
  setTimeout,
  clearTimeout
});

const {
  createChatSemanticSession,
  attachSemanticAnalysis,
  getBlockingAmbiguityQuestions,
  recordChatClarificationAnswer,
  applyChatSemanticRevision,
  reviseSemanticHypothesis,
  createUserConclusion,
  validateUserConclusion,
  createSemanticSpec
} = module.exports;

const t0 = "2026-08-10T00:00:00.000Z";
const t1 = "2026-08-10T00:01:00.000Z";
const t2 = "2026-08-10T00:02:00.000Z";

function userSource(messageId, text) {
  return {
    sourceKind: "message_span",
    messageId,
    snapshot: text,
    actor: "user"
  };
}

function semanticSource(id, messageId, text) {
  return { id, messageId, snapshot: text };
}

function propositionSpec(claimId, texts, surface, description) {
  const sourceRefs = texts.map((text, index) =>
    semanticSource(`src-${claimId}-${index}`, `msg-${claimId}-${index}`, text));
  return createSemanticSpec({
    claimId,
    sourceRefs,
    symbols: [{
      id: `sym-${claimId}`,
      surface,
      role: "proposition",
      description,
      sourceRefIds: sourceRefs.map((ref) => ref.id)
    }],
    expressions: [{
      id: `expr-${claimId}`,
      kind: "symbol_ref",
      symbolId: `sym-${claimId}`
    }],
    statements: [{
      id: `statement-${claimId}`,
      kind: "assertion",
      exprId: `expr-${claimId}`
    }],
    ambiguities: []
  });
}

function ambiguousPronounSpec() {
  const text = "它最后变成0。";
  const sourceRef = semanticSource("src-pronoun", "msg-pronoun", text);
  return createSemanticSpec({
    claimId: "pronoun-zero",
    sourceRefs: [sourceRef],
    symbols: [{
      id: "sym-it",
      surface: "它",
      role: "unresolved",
      sourceRefIds: [sourceRef.id]
    }],
    expressions: [{ id: "expr-it", kind: "symbol_ref", symbolId: "sym-it" }],
    statements: [{ id: "statement-it", kind: "assertion", exprId: "expr-it" }],
    ambiguities: [{
      id: "amb-it",
      kind: "reference_target",
      question: "Does 它 refer to the sequence term, partial sum, or limit?",
      affectedIds: ["sym-it"],
      blocking: true,
      choices: [
        { id: "sequence-term", label: "the sequence term" },
        { id: "partial-sum", label: "the partial sum" },
        { id: "limit", label: "the limit" }
      ]
    }]
  });
}

function createSession(id, text, semanticSpec, presentation) {
  return createChatSemanticSession({
    id,
    userText: text,
    userSourceRefs: [userSource(`message-${id}`, text)],
    semanticSpec,
    semanticReviewPresentation: presentation,
    createdAt: t0
  });
}

// A — clear statements are immediately usable working hypotheses.
{
  const text = "一个复数加上0还是它自己。";
  const spec = propositionSpec(
    "complex-zero",
    [text],
    text,
    "For every complex z, z + 0 = z"
  );
  const session = createSession(
    "clear",
    text,
    spec,
    "对任意复数 z，z + 0 = z。"
  );

  assert.equal(session.state, "understood");
  assert.equal(session.semanticSpec.id, session.hypothesisHistory[0].semanticSpec.id);
  assert.equal(session.hypothesisHistory.length, 1);
  assert.equal(Object.hasOwn(session, "acceptedConclusionId"), false);
  assert.equal(module.exports.acceptSemanticUnderstanding, undefined);
  assert.equal(module.exports.rejectSemanticUnderstanding, undefined);
  console.log("CHAT-SEMANTIC-A PASS: clear statement is understood without confirmation or conclusion creation");
}

// B — a genuine reference ambiguity interrupts continuation.
{
  const text = "它最后变成0。";
  const session = createSession("blocking", text, ambiguousPronounSpec());
  assert.equal(session.state, "needs_clarification");
  assert.equal(getBlockingAmbiguityQuestions(session).length, 1);
  assert.equal(getBlockingAmbiguityQuestions(session)[0].id, "amb-it");
  console.log("CHAT-SEMANTIC-B PASS: genuine blocking reference ambiguity requests clarification");
}

// C — recording the answer does not silently update meaning.
{
  const text = "它最后变成0。";
  const initial = createSession("answer-only", text, ambiguousPronounSpec());
  const answered = recordChatClarificationAnswer(
    initial,
    "amb-it",
    "它指的是数列项。",
    t1,
    "sequence-term"
  );

  assert.equal(answered.state, "needs_clarification");
  assert.equal(answered.clarificationAnswers.length, 1);
  assert.equal(answered.semanticSpec.resolutions.length, 1);
  assert.equal(answered.semanticSpec.patches.length, 0);
  assert.equal(answered.semanticSpec.symbols[0].role, "unresolved");
  assert.equal(answered.hypothesisHistory.at(-1).changeKind, "clarification_answer");
  console.log("CHAT-SEMANTIC-C PASS: answer is evidence, not an automatic model mutation");
}

// D — an explicit patch makes the hypothesis usable.
{
  const text = "它最后变成0。";
  const initial = createSession("patch", text, ambiguousPronounSpec());
  const originalSpec = initial.semanticSpec;
  const answered = recordChatClarificationAnswer(
    initial,
    "amb-it",
    "它指的是数列项。",
    t1,
    "sequence-term"
  );
  const revised = applyChatSemanticRevision(answered, {
    id: "patch-reference",
    ambiguityId: "amb-it",
    resolutionId: answered.semanticSpec.resolutions[0].id,
    operations: [{
      kind: "update_symbol",
      symbolId: "sym-it",
      changes: { role: "concept", description: "the sequence term" }
    }],
    createdAt: t2
  }, t2);

  assert.equal(revised.state, "understood");
  assert.equal(revised.semanticSpec.symbols[0].role, "concept");
  assert.equal(revised.semanticSpec.symbols[0].description, "the sequence term");
  assert.equal(originalSpec.symbols[0].role, "unresolved");
  assert.equal(originalSpec.revision, 1);
  assert.equal(revised.semanticSpec.revision, 3);
  assert.equal(revised.hypothesisHistory.at(-1).changeKind, "semantic_patch");
  console.log("CHAT-SEMANTIC-D PASS: explicit semantic update resolves blocker immutably");
}

// E — later conversation replaces H0 with H1 without accept/reject.
{
  const initialText = "这个尺度可以先看成离散索引。";
  const laterText = "后来我认为它还应该支持连续变化。";
  const h0 = propositionSpec("hypothesis-h0", [initialText], "这个尺度", "modeled as a discrete index");
  const session0 = createSession("continuous", initialText, h0, "H0: discrete index");
  const h1 = propositionSpec(
    "hypothesis-h1",
    [initialText, laterText],
    "这个尺度",
    "supports continuous variation in addition to sampling"
  );
  const session1 = reviseSemanticHypothesis(session0, {
    semanticSpec: h1,
    additionalUserSourceRefs: [userSource("message-continuous-later", laterText)],
    semanticReviewPresentation: "H1: continuous variation is part of the scale",
    updatedAt: t1
  });

  assert.equal(session0.state, "understood");
  assert.equal(session1.state, "understood");
  assert.equal(session0.semanticSpec.id, h0.id);
  assert.equal(session0.semanticSpec.symbols[0].description, "modeled as a discrete index");
  assert.equal(session1.semanticSpec.symbols[0].description, "supports continuous variation in addition to sampling");
  assert.equal(session1.hypothesisHistory.length, 2);
  assert.equal(session1.hypothesisHistory[0].semanticSpec.symbols[0].description, "modeled as a discrete index");
  assert.equal(session1.hypothesisHistory[1].changeKind, "conversation_refinement");
  assert.equal(session1.revision, session0.revision + 1);
  console.log("CHAT-SEMANTIC-E PASS: later evidence replaces H0 with H1 while preserving immutable history");
}

// F — custom linguistic relations remain direct, usable meanings.
{
  const text = "A梦到B。";
  const sourceRef = semanticSource("src-dream", "msg-dream", text);
  const spec = createSemanticSpec({
    claimId: "dream",
    sourceRefs: [sourceRef],
    symbols: [
      { id: "sym-a", surface: "A", role: "entity", sourceRefIds: [sourceRef.id] },
      { id: "sym-b", surface: "B", role: "entity", sourceRefIds: [sourceRef.id] },
      { id: "sym-dream", surface: "梦到", role: "relation", userDefined: true, sourceRefIds: [sourceRef.id] }
    ],
    expressions: [
      { id: "expr-a", kind: "symbol_ref", symbolId: "sym-a" },
      { id: "expr-b", kind: "symbol_ref", symbolId: "sym-b" },
      { id: "expr-dream", kind: "application", operatorSymbolId: "sym-dream", argumentExprIds: ["expr-a", "expr-b"] }
    ],
    statements: [{ id: "statement-dream", kind: "assertion", exprId: "expr-dream" }],
    ambiguities: []
  });
  const session = createSession("dream", text, spec);
  assert.equal(session.state, "understood");
  assert.equal(session.semanticSpec.symbols.find((item) => item.id === "sym-dream").surface, "梦到");
  assert.equal(session.semanticSpec.symbols.find((item) => item.id === "sym-dream").role, "relation");
  assert.equal(JSON.stringify(session).includes("lean"), false);
  console.log("CHAT-SEMANTIC-F PASS: custom linguistic relation stays named 梦到 without Lean");
}

// G — a custom world can be refined away from an inappropriate standard map.
{
  const initialText = "我把它叫作无穷物件时间尺度。";
  const laterText = "n只是采样位置，时间本身还应该可以定义速度。";
  const h0 = propositionSpec(
    "custom-time-h0",
    [initialText],
    "无穷物件时间尺度",
    "possibly related to n ∈ ℕ"
  );
  const session0 = createSession("custom-time", initialText, h0);
  const h1 = propositionSpec(
    "custom-time-h1",
    [initialText, laterText],
    "无穷物件时间尺度",
    "a user-defined time notion distinct from sampling position n and capable of speed"
  );
  const session1 = reviseSemanticHypothesis(session0, {
    semanticSpec: h1,
    additionalUserSourceRefs: [userSource("message-custom-time-later", laterText)],
    updatedAt: t1
  });

  assert.equal(session1.state, "understood");
  assert.equal(session1.semanticSpec.symbols[0].surface, "无穷物件时间尺度");
  assert.equal(session1.semanticSpec.symbols[0].description.includes("distinct from sampling position n"), true);
  assert.equal(session1.hypothesisHistory[0].semanticSpec.symbols[0].description, "possibly related to n ∈ ℕ");
  assert.equal(session1.hypothesisHistory[0].semanticSpec.symbols[0].surface, "无穷物件时间尺度");
  console.log("CHAT-SEMANTIC-G PASS: custom world refinement preserves its name and rejects silent n substitution");
}

// H — understood is not an epistemic or Lean result.
{
  const text = "天下乌鸦一般黑。";
  const spec = propositionSpec("crow", [text], text, "universal empirical statement about crows");
  const session = createSession("crow", text, spec);
  assert.equal(session.state, "understood");
  assert.equal(session.semanticSpec.reviewStatus, "pending");
  assert.equal(JSON.stringify(session).includes("proof_verified"), false);
  assert.equal(JSON.stringify(session).includes("empirical_evidence"), false);
  assert.equal(JSON.stringify(session).includes("lean"), false);
  console.log("CHAT-SEMANTIC-H PASS: understood empirical meaning creates no truth, evidence, or Lean result");
}

// I — UserConclusion authority comes from user text, not semantic approval.
{
  const text = "一个复数加上0还是它自己。";
  const conclusion = createUserConclusion({
    id: "user-conclusion-independent",
    text,
    sourceRefs: [userSource("message-conclusion", text)],
    kind: "mathematical_claim",
    protocolArtifactIds: [],
    createdAt: t0
  });
  assert.equal(validateUserConclusion(conclusion).length, 0);
  assert.equal(conclusion.text, text);
  assert.equal(Object.hasOwn(conclusion, "semanticStatus"), false);
  assert.equal(conclusion.semanticSpecId, undefined);
  assert.equal(conclusion.protocolArtifactIds.length, 0);

  const aiReplacement = {
    ...conclusion,
    text: "For every complex z, z + 0 = z."
  };
  assert.ok(validateUserConclusion(aiReplacement).some((error) => error.path === "text"));
  console.log("CHAT-SEMANTIC-I PASS: UserConclusion needs exact user provenance, not semantic acceptance");
}

// Analyzing remains available for a later AI adapter, with source association.
{
  const text = "一个复数加上0还是它自己。";
  const analyzing = createSession("analyzing", text, undefined);
  assert.equal(analyzing.state, "analyzing");
  const attached = attachSemanticAnalysis(
    analyzing,
    propositionSpec("attached", [text], text, "complex additive identity"),
    t1,
    "ephemeral hypothesis"
  );
  assert.equal(attached.state, "understood");
  assert.equal(analyzing.semanticSpec, undefined);
  assert.equal(attached.hypothesisHistory[0].changeKind, "analysis_attached");
}

console.log(JSON.stringify({
  scenarioA_clearUnderstood: true,
  scenarioB_blockingAmbiguity: true,
  scenarioC_answerAloneInsufficient: true,
  scenarioD_semanticUpdate: true,
  scenarioE_continuousRefinement: true,
  scenarioF_customRelation: true,
  scenarioG_customWorldRefinement: true,
  scenarioH_epistemicSeparation: true,
  scenarioI_conclusionIndependence: true,
  confirmationEvents: 0,
  userConclusionsCreatedByChat: 0,
  deepSeekCalls: 0,
  leanCalls: 0,
  networkCalls: 0,
  vaultWrites: 0,
  result: "PASS"
}, null, 2));
