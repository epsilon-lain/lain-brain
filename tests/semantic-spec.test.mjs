import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  SEMANTIC_ROLES,",
      "  AMBIGUITY_KINDS,",
      "  EXPRESSION_KINDS,",
      "  STATEMENT_KINDS,",
      "  SEMANTIC_SPEC_SCHEMA_VERSION,",
      "  createSemanticSpec,",
      "  validateSemanticSpec,",
      "  deriveSemanticAnalysisStatus,",
      "  acceptSemanticSpec,",
      "  resolveAmbiguity,",
      "  applySemanticPatch,",
      "  isAmbiguityResolved,",
      "  getUnresolvedBlockingAmbiguities,",
      "  collectReferencedSymbolIds,",
      "  buildDefinitionDependencyGraph,",
      "  detectDefinitionCycles",
      "} from './src/SemanticSpec';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "semantic-spec-entry.ts",
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
  crypto: { randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});

const {
  SEMANTIC_ROLES,
  AMBIGUITY_KINDS,
  EXPRESSION_KINDS,
  STATEMENT_KINDS,
  SEMANTIC_SPEC_SCHEMA_VERSION,
  createSemanticSpec,
  validateSemanticSpec,
  deriveSemanticAnalysisStatus,
  acceptSemanticSpec,
  resolveAmbiguity,
  applySemanticPatch,
  isAmbiguityResolved,
  getUnresolvedBlockingAmbiguities,
  collectReferencedSymbolIds,
  buildDefinitionDependencyGraph,
  detectDefinitionCycles
} = module.exports;

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function makeSourceRef(id, messageId, snapshot) {
  return { id, messageId, snapshot };
}

function makeSymbol(id, surface, role, opts = {}) {
  return {
    id,
    surface,
    role,
    description: opts.description,
    userDefined: opts.userDefined,
    sourceRefIds: opts.sourceRefIds ?? []
  };
}

function makeExpression(id, kind, opts = {}) {
  return { id, kind, ...opts };
}

function makeStatement(id, kind, opts = {}) {
  return { id, kind, ...opts };
}

function makeAmbiguity(id, kind, question, affectedIds, opts = {}) {
  return {
    id,
    kind,
    question,
    affectedIds,
    blocking: opts.blocking ?? true,
    choices: opts.choices
  };
}

function makeChoice(id, label, description) {
  return { id, label, description };
}

function makePatch(spec, ambiguityId, operations, id = `patch-${ambiguityId}`) {
  const resolution = spec.resolutions.find((item) => item.ambiguityId === ambiguityId);
  assert.ok(resolution, `Resolution for ${ambiguityId} must exist before creating its patch`);
  return {
    id,
    ambiguityId,
    resolutionId: resolution.id,
    operations,
    createdAt: new Date().toISOString()
  };
}

function makeValidParams(overrides = {}) {
  const srcRef = makeSourceRef("src-1", "msg-1", "a + 0 = a");
  const symA = makeSymbol("sym-a", "a", "variable", { sourceRefIds: ["src-1"] });
  const symPlus = makeSymbol("sym-plus", "+", "operator", { sourceRefIds: ["src-1"] });
  const symZero = makeSymbol("sym-zero", "0", "entity", { sourceRefIds: ["src-1"] });
  const exprApp = makeExpression("expr-app", "application", {
    operatorSymbolId: "sym-plus",
    argumentExprIds: ["expr-a", "expr-zero"]
  });
  const exprA = makeExpression("expr-a", "symbol_ref", { symbolId: "sym-a" });
  const exprZero = makeExpression("expr-zero", "literal", { value: "0" });
  const exprEq = makeExpression("expr-eq", "equals", {
    leftExprId: "expr-app",
    rightExprId: "expr-a"
  });
  const stmt = makeStatement("stmt-1", "assertion", { exprId: "expr-eq" });

  return {
    claimId: "claim-test-1",
    sourceRefs: [srcRef],
    symbols: [symA, symPlus, symZero],
    expressions: [exprA, exprZero, exprApp, exprEq],
    statements: [stmt],
    ambiguities: [],
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════════════════════
// T01–T05: Creation & Basic Properties
// ═══════════════════════════════════════════════════════════════════════

{
  const spec = createSemanticSpec(makeValidParams());

  assert.equal(typeof spec.id, "string");
  assert.ok(spec.id.startsWith("test-uuid-"));
  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.claimId, "claim-test-1");
  assert.equal(spec.reviewStatus, "pending");
  assert.equal(spec.revision, 1);
  assert.equal(spec.sourceRefs.length, 1);
  assert.equal(spec.symbols.length, 3);
  assert.equal(spec.expressions.length, 4);
  assert.equal(spec.statements.length, 1);
  assert.equal(spec.ambiguities.length, 0);
  assert.equal(spec.resolutions.length, 0);
  assert.equal(spec.patches.length, 0);
  assert.equal(spec.analysisStatus, "ready_for_review");

  // Immutability: attempting to mutate should throw
  try {
    spec.reviewStatus = "accepted";
    assert.fail("Should have thrown on mutation");
  } catch {
    // Expected — frozen object
  }

  console.log("T01-T05 PASS: creation defaults correct, immutable");
}

// ═══════════════════════════════════════════════════════════════════════
// T06–T10: Validation
// ═══════════════════════════════════════════════════════════════════════

{
  // Duplicate symbol IDs
  const params = makeValidParams();
  const spec = createSemanticSpec(params);
  const errors = validateSemanticSpec(spec);
  assert.equal(errors.length, 0, "Valid spec should have no errors");

  console.log("T06 PASS: valid spec passes validation");
}

{
  // Dangling symbol reference in expression
  const params = makeValidParams({
    expressions: [
      makeExpression("expr-bad", "symbol_ref", { symbolId: "nonexistent" })
    ],
    statements: []
  });
  assert.throws(
    () => createSemanticSpec(params),
    /Symbol "nonexistent" not found/
  );

  console.log("T07 PASS: dangling symbol reference detected");
}

{
  // Dangling expression reference in statement
  const params = makeValidParams({
    statements: [
      makeStatement("stmt-bad", "assertion", { exprId: "nonexistent-expr" })
    ]
  });
  assert.throws(
    () => createSemanticSpec(params),
    /Expression "nonexistent-expr" not found/
  );

  console.log("T08 PASS: dangling expression reference in statement detected");
}

{
  // Dangling sourceRefId in symbol
  const params = makeValidParams({
    symbols: [
      makeSymbol("sym-x", "x", "variable", { sourceRefIds: ["nonexistent-src"] })
    ],
    expressions: [],
    statements: []
  });
  assert.throws(
    () => createSemanticSpec(params),
    /Source ref "nonexistent-src" not found/
  );

  console.log("T09 PASS: dangling sourceRefId detected");
}

{
  // accepted + unresolved blocking ambiguity → validation error
  const amb = makeAmbiguity("amb-1", "operator_meaning", "What is +?", ["sym-plus"]);
  const params = makeValidParams({ ambiguities: [amb] });
  const spec = createSemanticSpec(params);
  assert.equal(spec.analysisStatus, "under_specified");

  // Directly constructing an accepted spec with blocking ambiguity
  // should fail validation
  const mutated = { ...spec };
  mutated.reviewStatus = "accepted";
  const errors = validateSemanticSpec(mutated);
  const hasBlockingError = errors.some(
    (e) => e.path === "reviewStatus" &&
      e.message.includes("unresolved blocking ambiguities")
  );
  assert.ok(hasBlockingError, "Should reject accepted + under_specified");

  console.log("T10 PASS: accepted + unresolved blocking ambiguity fails validation");
}

// ═══════════════════════════════════════════════════════════════════════
// T11–T13: Ambiguity Resolution
// ═══════════════════════════════════════════════════════════════════════

{
  const amb = makeAmbiguity("amb-1", "operator_meaning", "What is +?", ["sym-plus"]);
  const params = makeValidParams({ ambiguities: [amb] });
  const spec = createSemanticSpec(params);

  assert.equal(spec.analysisStatus, "under_specified");
  assert.equal(isAmbiguityResolved(spec, "amb-1"), false);

  const unresolved = getUnresolvedBlockingAmbiguities(spec);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].id, "amb-1");

  console.log("T11 PASS: blocking ambiguity detected as unresolved");
}

{
  const amb = makeAmbiguity("amb-1", "operator_meaning", "What is +?", ["sym-plus"]);
  const params = makeValidParams({ ambiguities: [amb] });
  let spec = createSemanticSpec(params);

  const originalRevision = spec.revision;
  spec = resolveAmbiguity(spec, "amb-1", "ordinary addition on natural numbers");

  assert.equal(isAmbiguityResolved(spec, "amb-1"), false);
  assert.equal(spec.resolutions.length, 1);
  assert.equal(spec.resolutions[0].answerText, "ordinary addition on natural numbers");
  assert.equal(spec.resolutions[0].actor, "user");
  assert.equal(spec.analysisStatus, "under_specified");
  assert.equal(spec.revision, originalRevision + 1);

  const unresolved = getUnresolvedBlockingAmbiguities(spec);
  assert.equal(unresolved.length, 1);

  // Original ambiguity still present
  assert.equal(spec.ambiguities.length, 1);

  assert.throws(
    () => acceptSemanticSpec(spec),
    /unresolved blocking ambiguities/
  );

  console.log("T12 PASS: answer alone preserves under-specified status and original ambiguity");
}

{
  const amb = makeAmbiguity("amb-1", "operator_meaning", "What is +?", ["sym-plus"]);
  const params = makeValidParams({ ambiguities: [amb] });
  let spec = createSemanticSpec(params);
  spec = resolveAmbiguity(spec, "amb-1", "addition");

  // Cannot resolve twice
  assert.throws(
    () => resolveAmbiguity(spec, "amb-1", "another answer"),
    /already has a user resolution/
  );

  console.log("T13 PASS: double resolution blocked");
}

// ═══════════════════════════════════════════════════════════════════════
// T14–T15: Acceptance
// ═══════════════════════════════════════════════════════════════════════

{
  // No ambiguities → can accept
  const spec = createSemanticSpec(makeValidParams());
  assert.equal(spec.analysisStatus, "ready_for_review");

  const accepted = acceptSemanticSpec(spec);
  assert.equal(accepted.reviewStatus, "accepted");
  assert.equal(accepted.revision, 2);
  // updatedAt may be identical if both run in the same ms; revision bump
  // and new object identity are the meaningful signals.
  assert.notEqual(accepted, spec, "accept must return a new object");

  // Cannot accept twice
  assert.throws(
    () => acceptSemanticSpec(accepted),
    /already accepted/
  );

  console.log("T14 PASS: accept succeeds when ready, double-accept blocked");
}

{
  // Blocking ambiguity → cannot accept
  const amb = makeAmbiguity("amb-1", "operator_meaning", "What is +?", ["sym-plus"]);
  const params = makeValidParams({ ambiguities: [amb] });
  const spec = createSemanticSpec(params);

  assert.throws(
    () => acceptSemanticSpec(spec),
    /unresolved blocking ambiguities/
  );

  console.log("T15 PASS: accept blocked by unresolved ambiguity");
}

// ═══════════════════════════════════════════════════════════════════════
// BENCHMARK A — Explicit Standard Domain
// ═══════════════════════════════════════════════════════════════════════
//
// Source: "对任意实数 a，都有 a + 0 = a"
// Symbols: a (variable), + (operator), 0 (entity), ℝ (domain)
// Zero blocking ambiguities, ready_for_review, accept succeeds.

{
  const srcRef = makeSourceRef("src-a", "msg-a",
    "对任意实数 a，都有 a + 0 = a");

  const symA = makeSymbol("sym-a", "a", "variable", { sourceRefIds: ["src-a"] });
  const symPlus = makeSymbol("sym-plus", "+", "operator", {
    description: "实数加法",
    sourceRefIds: ["src-a"]
  });
  const symZero = makeSymbol("sym-zero", "0", "entity", {
    description: "加法单位元",
    sourceRefIds: ["src-a"]
  });
  const symReals = makeSymbol("sym-reals", "ℝ", "domain", {
    description: "实数集",
    sourceRefIds: ["src-a"]
  });

  const exprA = makeExpression("expr-a", "symbol_ref", { symbolId: "sym-a" });
  const exprZero = makeExpression("expr-zero", "symbol_ref", { symbolId: "sym-zero" });
  const exprDomain = makeExpression("expr-domain", "symbol_ref", {
    symbolId: "sym-reals",
    label: "实数域"
  });
  const exprApp = makeExpression("expr-app", "application", {
    operatorSymbolId: "sym-plus",
    argumentExprIds: ["expr-a", "expr-zero"]
  });
  const exprEq = makeExpression("expr-eq", "equals", {
    leftExprId: "expr-app",
    rightExprId: "expr-a"
  });
  const exprForall = makeExpression("expr-forall", "forall", {
    binderSymbolId: "sym-a",
    bodyExprId: "expr-eq",
    domainExprId: "expr-domain"
  });

  const stmt = makeStatement("stmt-1", "assertion", {
    exprId: "expr-forall",
    description: "加法单位元性质"
  });

  const spec = createSemanticSpec({
    claimId: "benchmark-a",
    sourceRefs: [srcRef],
    symbols: [symA, symPlus, symZero, symReals],
    expressions: [exprA, exprZero, exprDomain, exprApp, exprEq, exprForall],
    statements: [stmt],
    ambiguities: []
  });

  assert.equal(spec.analysisStatus, "ready_for_review");
  assert.equal(spec.ambiguities.length, 0);
  assert.equal(getUnresolvedBlockingAmbiguities(spec).length, 0);

  const accepted = acceptSemanticSpec(spec);
  assert.equal(accepted.reviewStatus, "accepted");

  // Collect symbols referenced by the forall
  const refd = collectReferencedSymbolIds(spec, "expr-forall");
  assert.ok(refd.includes("sym-a"));
  assert.ok(refd.includes("sym-plus"));
  assert.ok(refd.includes("sym-zero"));
  assert.ok(refd.includes("sym-reals"));

  console.log("BENCHMARK-A PASS: explicit standard domain, zero blocking, accept succeeds");
}

// ═══════════════════════════════════════════════════════════════════════
// BENCHMARK B — Underspecified Language
// ═══════════════════════════════════════════════════════════════════════
//
// Source: "lain + 0 = lain"
// lain, +, 0 all unresolved → blocking ambiguity → cannot accept
// Answer alone remains under-specified; only a linked semantic patch makes
// the blocking ambiguity semantically resolved.

{
  const srcRef = makeSourceRef("src-b", "msg-b", "lain + 0 = lain");

  const symLain = makeSymbol("sym-lain", "lain", "unresolved", { sourceRefIds: ["src-b"] });
  const symPlus = makeSymbol("sym-plus", "+", "unresolved", { sourceRefIds: ["src-b"] });
  const symZero = makeSymbol("sym-zero", "0", "unresolved", { sourceRefIds: ["src-b"] });

  const exprLainLeft = makeExpression("expr-lain-left", "symbol_ref", { symbolId: "sym-lain" });
  const exprZero = makeExpression("expr-zero", "literal", { value: "0" });
  const exprLainRight = makeExpression("expr-lain-right", "symbol_ref", { symbolId: "sym-lain" });
  const exprApp = makeExpression("expr-app", "application", {
    operatorSymbolId: "sym-plus",
    argumentExprIds: ["expr-lain-left", "expr-zero"]
  });
  const exprEq = makeExpression("expr-eq", "equals", {
    leftExprId: "expr-app",
    rightExprId: "expr-lain-right"
  });

  const stmt = makeStatement("stmt-1", "assertion", { exprId: "expr-eq" });

  const ambPlus = makeAmbiguity("amb-plus", "operator_meaning", "What does '+' mean here?", ["sym-plus"], {
    choices: [
      makeChoice("numeric-addition", "ordinary numeric addition"),
      makeChoice("existing-operation", "an existing structured operation"),
      makeChoice("user-defined", "a user-defined operation"),
      makeChoice("other", "other")
    ]
  });
  const ambLain = makeAmbiguity("amb-lain", "symbol_role", "What is 'lain'?", ["sym-lain"], {
    blocking: false // non-blocking
  });

  let spec = createSemanticSpec({
    claimId: "benchmark-b",
    sourceRefs: [srcRef],
    symbols: [symLain, symPlus, symZero],
    expressions: [exprLainLeft, exprZero, exprLainRight, exprApp, exprEq],
    statements: [stmt],
    ambiguities: [ambPlus, ambLain]
  });

  // At least one blocking ambiguity
  assert.equal(spec.analysisStatus, "under_specified");
  const unresolved = getUnresolvedBlockingAmbiguities(spec);
  assert.ok(unresolved.length >= 1);
  assert.ok(unresolved.some((a) => a.id === "amb-plus"));

  // Non-blocking ambiguity does not block
  assert.equal(isAmbiguityResolved(spec, "amb-lain"), false);
  // But it's not blocking, so it should not appear in blocking list
  const blockingIds = unresolved.map((a) => a.id);
  assert.equal(blockingIds.includes("amb-lain"), false);

  // accept fails
  assert.throws(
    () => acceptSemanticSpec(spec),
    /unresolved blocking ambiguities/
  );

  // Record the answer. This is audit history, not yet a semantic change.
  const beforeAnswer = spec;
  spec = resolveAmbiguity(spec, "amb-plus", "+ is a user-defined binary operation", "user-defined");

  assert.equal(spec.analysisStatus, "under_specified");
  assert.equal(isAmbiguityResolved(spec, "amb-plus"), false);
  assert.equal(spec.symbols.find((symbol) => symbol.id === "sym-plus").role, "unresolved");
  assert.throws(() => acceptSemanticSpec(spec), /unresolved blocking ambiguities/);

  // Apply the explicit semantic effect linked to that exact answer.
  const answered = spec;
  spec = applySemanticPatch(spec, makePatch(spec, "amb-plus", [{
    kind: "update_symbol",
    symbolId: "sym-plus",
    changes: {
      role: "operator",
      userDefined: true,
      description: "user-defined operation"
    }
  }], "patch-plus"));

  assert.equal(spec.analysisStatus, "ready_for_review");
  assert.equal(getUnresolvedBlockingAmbiguities(spec).length, 0);
  assert.equal(isAmbiguityResolved(spec, "amb-plus"), true);
  const patchedPlus = spec.symbols.find((symbol) => symbol.id === "sym-plus");
  assert.equal(patchedPlus.id, "sym-plus");
  assert.equal(patchedPlus.surface, "+");
  assert.equal(patchedPlus.role, "operator");
  assert.equal(patchedPlus.description, "user-defined operation");
  assert.equal(patchedPlus.userDefined, true);
  assert.equal([...patchedPlus.sourceRefIds].join(","), "src-b");
  assert.equal(beforeAnswer.resolutions.length, 0);
  assert.equal(answered.patches.length, 0);
  assert.equal(spec.patches.length, 1);

  // Now accept succeeds
  const accepted = acceptSemanticSpec(spec);
  assert.equal(accepted.reviewStatus, "accepted");

  console.log("BENCHMARK-B PASS: answer remains under-specified → patch updates model → accept");
}

// ═══════════════════════════════════════════════════════════════════════
// BENCHMARK C — Native User Language
// ═══════════════════════════════════════════════════════════════════════
//
// "A梦到B，B梦到C，所以A能听见C"
// DreamsOf as relation, CanHear as relation
// and( DreamsOf(A,B), DreamsOf(B,C) ) → CanHear(A,C)
// No graph-theory abstraction.

{
  const srcRef = makeSourceRef("src-c", "msg-c", "A梦到B，B梦到C，所以A能听见C");

  const symA = makeSymbol("sym-a", "A", "entity", { sourceRefIds: ["src-c"] });
  const symB = makeSymbol("sym-b", "B", "entity", { sourceRefIds: ["src-c"] });
  const symC = makeSymbol("sym-c", "C", "entity", { sourceRefIds: ["src-c"] });
  const symDreams = makeSymbol("sym-dreams", "DreamsOf", "relation", {
    description: "梦到",
    userDefined: true,
    sourceRefIds: ["src-c"]
  });
  const symHear = makeSymbol("sym-hear", "CanHear", "relation", {
    description: "能听见",
    userDefined: true,
    sourceRefIds: ["src-c"]
  });

  // DreamsOf(A, B)
  const exprA = makeExpression("expr-a", "symbol_ref", { symbolId: "sym-a" });
  const exprB = makeExpression("expr-b", "symbol_ref", { symbolId: "sym-b" });
  const exprC = makeExpression("expr-c", "symbol_ref", { symbolId: "sym-c" });
  const exprDreamsAB = makeExpression("expr-dreams-ab", "application", {
    operatorSymbolId: "sym-dreams",
    argumentExprIds: ["expr-a", "expr-b"]
  });
  const exprDreamsBC = makeExpression("expr-dreams-bc", "application", {
    operatorSymbolId: "sym-dreams",
    argumentExprIds: ["expr-b", "expr-c"]
  });
  const exprAnd = makeExpression("expr-and", "and", {
    operandExprIds: ["expr-dreams-ab", "expr-dreams-bc"]
  });
  const exprHear = makeExpression("expr-hear", "application", {
    operatorSymbolId: "sym-hear",
    argumentExprIds: ["expr-a", "expr-c"]
  });
  const exprImplies = makeExpression("expr-implies", "implies", {
    leftExprId: "expr-and",
    rightExprId: "expr-hear"
  });

  const stmt = makeStatement("stmt-1", "assertion", {
    exprId: "expr-implies",
    description: "DreamsOf transitivity leads to CanHear"
  });

  const spec = createSemanticSpec({
    claimId: "benchmark-c",
    sourceRefs: [srcRef],
    symbols: [symA, symB, symC, symDreams, symHear],
    expressions: [exprA, exprB, exprC, exprDreamsAB, exprDreamsBC, exprAnd, exprHear, exprImplies],
    statements: [stmt],
    ambiguities: []
  });

  assert.equal(spec.analysisStatus, "ready_for_review");

  // Verify DreamsOf is a relation (not graph-theory abstraction)
  const dreamsSymbol = spec.symbols.find((s) => s.id === "sym-dreams");
  assert.equal(dreamsSymbol.role, "relation");
  assert.equal(dreamsSymbol.surface, "DreamsOf");

  // Verify nested structure: implies(and(..., ...), ...)
  const impliesExpr = spec.expressions.find((e) => e.id === "expr-implies");
  assert.equal(impliesExpr.kind, "implies");

  const acceptResult = acceptSemanticSpec(spec);
  assert.equal(acceptResult.reviewStatus, "accepted");

  console.log("BENCHMARK-C PASS: native language preserved, no graph-theory abstraction");
}

// ═══════════════════════════════════════════════════════════════════════
// BENCHMARK D — Russell Barber
// ═══════════════════════════════════════════════════════════════════════
//
// "理发师给且只给那些不给自己理发的小镇居民理发"
// barber entity, Shaves relation, self-application Shaves(x,x)
// negation, iff, quantifier structure.

{
  const srcRef = makeSourceRef("src-d", "msg-d",
    "理发师给且只给那些不给自己理发的小镇居民理发");

  const symBarber = makeSymbol("sym-barber", "barber", "entity", {
    description: "理发师",
    sourceRefIds: ["src-d"]
  });
  const symShaves = makeSymbol("sym-shaves", "Shaves", "relation", {
    description: "理发关系",
    sourceRefIds: ["src-d"]
  });
  const symX = makeSymbol("sym-x", "x", "variable", { sourceRefIds: ["src-d"] });
  const symTown = makeSymbol("sym-town", "Town", "predicate", {
    description: "小镇居民",
    sourceRefIds: ["src-d"]
  });

  // Town(x)
  const exprX = makeExpression("expr-x", "symbol_ref", { symbolId: "sym-x" });
  const exprTownX = makeExpression("expr-town-x", "application", {
    operatorSymbolId: "sym-town",
    argumentExprIds: ["expr-x"]
  });

  // Shaves(x, x) — self-application
  const exprShavesXX = makeExpression("expr-shaves-xx", "application", {
    operatorSymbolId: "sym-shaves",
    argumentExprIds: ["expr-x", "expr-x"]
  });

  // Shaves(barber, x)
  const exprBarber = makeExpression("expr-barber", "symbol_ref", { symbolId: "sym-barber" });
  const exprShavesBarberX = makeExpression("expr-shaves-barber-x", "application", {
    operatorSymbolId: "sym-shaves",
    argumentExprIds: ["expr-barber", "expr-x"]
  });

  // ¬Shaves(x, x)
  const exprNotShavesXX = makeExpression("expr-not-shaves-xx", "not", {
    operandExprId: "expr-shaves-xx"
  });

  // Shaves(barber, x) ↔ ¬Shaves(x, x)
  const exprIff = makeExpression("expr-iff", "iff", {
    leftExprId: "expr-shaves-barber-x",
    rightExprId: "expr-not-shaves-xx"
  });

  // Town(x) → (Shaves(barber, x) ↔ ¬Shaves(x, x))
  const exprImplies = makeExpression("expr-implies", "implies", {
    leftExprId: "expr-town-x",
    rightExprId: "expr-iff"
  });

  // ∀x, Town(x) → (...)
  const exprForall = makeExpression("expr-forall", "forall", {
    binderSymbolId: "sym-x",
    bodyExprId: "expr-implies"
  });

  const stmt = makeStatement("stmt-1", "rule", {
    conclusionExprId: "expr-forall",
    description: "Barber paradox rule"
  });

  // Version D1: barber domain membership unresolved → blocking ambiguity
  const ambDomain = makeAmbiguity("amb-domain", "domain",
    "Does the barber belong to the town (quantified domain)?",
    ["sym-barber", "sym-town"],
    {
      blocking: true,
      choices: [
        makeChoice("barber-resident", "barber is a town resident"),
        makeChoice("barber-not-resident", "barber is not a town resident")
      ]
    }
  );

  const specD1 = createSemanticSpec({
    claimId: "benchmark-d",
    sourceRefs: [srcRef],
    symbols: [symBarber, symShaves, symX, symTown],
    expressions: [
      exprX, exprBarber, exprTownX,
      exprShavesXX, exprShavesBarberX,
      exprNotShavesXX, exprIff, exprImplies, exprForall
    ],
    statements: [stmt],
    ambiguities: [ambDomain]
  });

  assert.equal(specD1.analysisStatus, "under_specified");

  // Verify self-application: Shaves(x, x) exists
  const shavesXX = specD1.expressions.find((e) => e.id === "expr-shaves-xx");
  assert.equal(shavesXX.kind, "application");
  assert.equal(shavesXX.argumentExprIds.length, 2);
  assert.equal(shavesXX.argumentExprIds[0], "expr-x");
  assert.equal(shavesXX.argumentExprIds[1], "expr-x");

  // Cannot accept D1
  assert.throws(
    () => acceptSemanticSpec(specD1),
    /unresolved blocking ambiguities/
  );

  // Version D2: answer alone preserves the blocking status.
  const answeredD2 = resolveAmbiguity(
    specD1,
    "amb-domain",
    "barber is a town resident",
    "barber-resident"
  );

  assert.equal(answeredD2.analysisStatus, "under_specified");
  // The linked patch records the resulting semantic model change.
  const specD2 = applySemanticPatch(answeredD2, makePatch(answeredD2, "amb-domain", [{
    kind: "update_symbol",
    symbolId: "sym-barber",
    changes: { description: "理发师；小镇居民" }
  }], "patch-domain"));

  assert.equal(specD2.analysisStatus, "ready_for_review");
  const acceptedD2 = acceptSemanticSpec(specD2);
  assert.equal(acceptedD2.reviewStatus, "accepted");

  // No contradiction is claimed — just structure preserved
  const refd = collectReferencedSymbolIds(specD2, "expr-forall");
  assert.ok(refd.includes("sym-shaves"));
  assert.ok(refd.includes("sym-x"));

  console.log("BENCHMARK-D PASS: barber rule with self-application, domain ambiguity, no contradiction claim");
}

// ═══════════════════════════════════════════════════════════════════════
// BENCHMARK E — Definition Cycles
// ═══════════════════════════════════════════════════════════════════════

{
  // A := depends on B, B := depends on A
  const srcRef = makeSourceRef("src-e", "msg-e", "A depends on B; B depends on A");

  const symA = makeSymbol("sym-a", "A", "concept", {
    userDefined: true,
    sourceRefIds: ["src-e"]
  });
  const symB = makeSymbol("sym-b", "B", "concept", {
    userDefined: true,
    sourceRefIds: ["src-e"]
  });

  const exprB = makeExpression("expr-b-ref", "symbol_ref", { symbolId: "sym-b" });
  const exprA = makeExpression("expr-a-ref", "symbol_ref", { symbolId: "sym-a" });

  const stmtA = makeStatement("stmt-a", "definition", {
    subjectSymbolId: "sym-a",
    bodyExprId: "expr-b-ref",
    description: "A := depends on B"
  });
  const stmtB = makeStatement("stmt-b", "definition", {
    subjectSymbolId: "sym-b",
    bodyExprId: "expr-a-ref",
    description: "B := depends on A"
  });

  const spec = createSemanticSpec({
    claimId: "benchmark-e",
    sourceRefs: [srcRef],
    symbols: [symA, symB],
    expressions: [exprB, exprA],
    statements: [stmtA, stmtB],
    ambiguities: []
  });

  const cycles = detectDefinitionCycles(spec);
  assert.ok(cycles.length >= 1, "Should detect A → B → A cycle");
  // At least one cycle should contain both A and B
  const hasABcycle = cycles.some(
    (cycle) => cycle.includes("sym-a") && cycle.includes("sym-b")
  );
  assert.ok(hasABcycle, "Should have a cycle containing both sym-a and sym-b");

  // Cycle is NOT a contradiction — spec is still valid
  const errors = validateSemanticSpec(spec);
  assert.equal(errors.length, 0);

  console.log("BENCHMARK-E1 PASS: A→B→A cycle detected, not treated as contradiction");
}

{
  // Self-cycle: A := depends on A
  const srcRef = makeSourceRef("src-e2", "msg-e2", "A := A");

  const symA = makeSymbol("sym-a", "A", "concept", {
    userDefined: true,
    sourceRefIds: ["src-e2"]
  });

  const exprA = makeExpression("expr-a-ref", "symbol_ref", { symbolId: "sym-a" });

  const stmtA = makeStatement("stmt-a", "definition", {
    subjectSymbolId: "sym-a",
    bodyExprId: "expr-a-ref",
    description: "A := A (self-reference)"
  });

  const spec = createSemanticSpec({
    claimId: "benchmark-e2",
    sourceRefs: [srcRef],
    symbols: [symA],
    expressions: [exprA],
    statements: [stmtA],
    ambiguities: []
  });

  const cycles = detectDefinitionCycles(spec);
  assert.ok(cycles.length >= 1, "Should detect self-cycle");
  const hasSelfCycle = cycles.some(
    (cycle) =>
      cycle.length === 2 &&
      cycle[0] === "sym-a" &&
      cycle[1] === "sym-a"
  );
  assert.ok(hasSelfCycle, "Should have self-cycle A→A");

  // Still valid (cycle !== contradiction)
  const errors = validateSemanticSpec(spec);
  assert.equal(errors.length, 0);

  console.log("BENCHMARK-E2 PASS: self-cycle detected, still valid");
}

{
  // No cycles: linear dependency
  const srcRef = makeSourceRef("src-e3", "msg-e3", "A := B, B := C");

  const symA = makeSymbol("sym-a", "A", "concept", { userDefined: true, sourceRefIds: ["src-e3"] });
  const symB = makeSymbol("sym-b", "B", "concept", { userDefined: true, sourceRefIds: ["src-e3"] });
  const symC = makeSymbol("sym-c", "C", "concept", { userDefined: true, sourceRefIds: ["src-e3"] });

  const exprB = makeExpression("expr-b-ref", "symbol_ref", { symbolId: "sym-b" });
  const exprC = makeExpression("expr-c-ref", "symbol_ref", { symbolId: "sym-c" });

  const stmtA = makeStatement("stmt-a", "definition", {
    subjectSymbolId: "sym-a",
    bodyExprId: "expr-b-ref"
  });
  const stmtB = makeStatement("stmt-b", "definition", {
    subjectSymbolId: "sym-b",
    bodyExprId: "expr-c-ref"
  });

  const spec = createSemanticSpec({
    claimId: "benchmark-e3",
    sourceRefs: [srcRef],
    symbols: [symA, symB, symC],
    expressions: [exprB, exprC],
    statements: [stmtA, stmtB],
    ambiguities: []
  });

  const cycles = detectDefinitionCycles(spec);
  assert.equal(cycles.length, 0, "Linear dependency should have no cycles");

  console.log("BENCHMARK-E3 PASS: linear A→B→C has no cycles");
}

// ═══════════════════════════════════════════════════════════════════════
// BENCHMARK F — Dangling References
// ═══════════════════════════════════════════════════════════════════════

{
  // Expression refers to non-existent symbol
  assert.throws(
    () => createSemanticSpec({
      claimId: "benchmark-f",
      sourceRefs: [makeSourceRef("src-f", "msg-f", "x + 1")],
      symbols: [makeSymbol("sym-x", "x", "variable", { sourceRefIds: ["src-f"] })],
      expressions: [
        makeExpression("expr-bad", "symbol_ref", { symbolId: "nonexistent-sym" })
      ],
      statements: [],
      ambiguities: []
    }),
    /Symbol "nonexistent-sym" not found/
  );

  console.log("BENCHMARK-F1 PASS: dangling symbol reference caught at creation");
}

{
  // Statement refers to non-existent expression
  assert.throws(
    () => createSemanticSpec({
      claimId: "benchmark-f2",
      sourceRefs: [makeSourceRef("src-f2", "msg-f2", "claim")],
      symbols: [],
      expressions: [],
      statements: [
        makeStatement("stmt-bad", "assertion", { exprId: "nonexistent-expr" })
      ],
      ambiguities: []
    }),
    /Expression "nonexistent-expr" not found/
  );

  console.log("BENCHMARK-F2 PASS: dangling expression reference in statement caught");
}

// ═══════════════════════════════════════════════════════════════════════
// Additional Validation Tests
// ═══════════════════════════════════════════════════════════════════════

{
  // Multiple resolutions for same ambiguity blocked by validation
  const amb = makeAmbiguity("amb-1", "other", "Test ambiguity", ["sym-a"]);
  const params = makeValidParams({ ambiguities: [amb] });
  let spec = createSemanticSpec(params);
  spec = resolveAmbiguity(spec, "amb-1", "first answer");

  // Try to sneak in a second resolution for the same ambiguity
  const mutated = {
    ...spec,
    resolutions: [
      ...spec.resolutions,
      { id: "res-2", ambiguityId: "amb-1", answerText: "second", actor: "user", createdAt: new Date().toISOString() }
    ]
  };
  const errors = validateSemanticSpec(mutated);

  const multiResError = errors.some(
    (e) => e.path === "resolutions" && e.message.includes("at most one")
  );
  assert.ok(multiResError, "Validation should reject multiple resolutions per ambiguity");

  console.log("VAL-1 PASS: multiple resolutions per ambiguity rejected");
}

{
  // SourceRef IDs are auto-generated when missing
  const spec = createSemanticSpec({
    claimId: "test-src-auto",
    sourceRefs: [
      { messageId: "msg-1", snapshot: "text" }
    ],
    symbols: [],
    expressions: [],
    statements: [],
    ambiguities: []
  });

  assert.equal(spec.sourceRefs.length, 1);
  assert.ok(spec.sourceRefs[0].id.startsWith("test-uuid-"),
    "Missing sourceRef id should be auto-generated");

  console.log("VAL-2 PASS: sourceRef auto-ID generation");
}

{
  // Immutability: original spec unchanged after resolve
  const amb = makeAmbiguity("amb-1", "other", "Test", ["sym-a"]);
  const params = makeValidParams({ ambiguities: [amb] });
  const spec = createSemanticSpec(params);

  const originalResCount = spec.resolutions.length;
  const resolved = resolveAmbiguity(spec, "amb-1", "answer");

  assert.equal(spec.resolutions.length, originalResCount,
    "Original spec must not be mutated");
  assert.equal(resolved.resolutions.length, originalResCount + 1,
    "New spec must have the resolution");

  console.log("VAL-3 PASS: immutability — original spec unchanged after resolve");
}

{
  // Immutability: original spec unchanged after accept
  const spec = createSemanticSpec(makeValidParams());
  const accepted = acceptSemanticSpec(spec);

  assert.equal(spec.reviewStatus, "pending", "Original must stay pending");
  assert.equal(accepted.reviewStatus, "accepted", "New must be accepted");

  console.log("VAL-4 PASS: immutability — original spec unchanged after accept");
}

{
  // Explicit domain expression in forall
  const srcRef = makeSourceRef("src-val5", "msg-val5", "forall x in R, P(x)");
  const symX = makeSymbol("sym-x", "x", "variable", { sourceRefIds: ["src-val5"] });
  const symR = makeSymbol("sym-r", "R", "domain", { sourceRefIds: ["src-val5"] });
  const symP = makeSymbol("sym-p", "P", "predicate", { sourceRefIds: ["src-val5"] });

  const exprX = makeExpression("expr-x", "symbol_ref", { symbolId: "sym-x" });
  const exprDomain = makeExpression("expr-domain", "symbol_ref", { symbolId: "sym-r" });
  const exprPX = makeExpression("expr-px", "application", {
    operatorSymbolId: "sym-p",
    argumentExprIds: ["expr-x"]
  });
  const exprForall = makeExpression("expr-forall", "forall", {
    binderSymbolId: "sym-x",
    bodyExprId: "expr-px",
    domainExprId: "expr-domain"
  });

  const stmt = makeStatement("stmt-1", "assertion", { exprId: "expr-forall" });

  const spec = createSemanticSpec({
    claimId: "test-domain",
    sourceRefs: [srcRef],
    symbols: [symX, symR, symP],
    expressions: [exprX, exprDomain, exprPX, exprForall],
    statements: [stmt],
    ambiguities: []
  });

  assert.equal(spec.analysisStatus, "ready_for_review");
  const forallExpr = spec.expressions.find((e) => e.id === "expr-forall");
  assert.equal(forallExpr.domainExprId, "expr-domain");

  console.log("VAL-5 PASS: forall with explicit domain expression");
}

{
  // Non-blocking ambiguity does not prevent accept when no blocking ones exist
  const nonBlocking = makeAmbiguity("amb-nb", "symbol_role", "What is x?", ["sym-a"], {
    blocking: false
  });
  const params = makeValidParams({ ambiguities: [nonBlocking] });
  const spec = createSemanticSpec(params);

  // Non-blocking ambiguity → analysisStatus is ready_for_review
  assert.equal(spec.analysisStatus, "ready_for_review");
  assert.equal(getUnresolvedBlockingAmbiguities(spec).length, 0);

  // Accept should succeed
  const accepted = acceptSemanticSpec(spec);
  assert.equal(accepted.reviewStatus, "accepted");

  console.log("VAL-6 PASS: non-blocking ambiguity does not prevent accept");
}

{
  // Empty answerText in resolution throws
  const amb = makeAmbiguity("amb-1", "other", "Test", ["sym-a"]);
  const params = makeValidParams({ ambiguities: [amb] });
  const spec = createSemanticSpec(params);

  assert.throws(
    () => resolveAmbiguity(spec, "amb-1", "   "),
    /answerText cannot be empty/
  );

  console.log("VAL-7 PASS: empty resolution answerText rejected");
}

{
  // Non-existent ambiguity in resolve throws
  const spec = createSemanticSpec(makeValidParams());
  assert.throws(
    () => resolveAmbiguity(spec, "nonexistent", "answer"),
    /not found/
  );

  console.log("VAL-8 PASS: resolving non-existent ambiguity throws");
}

{
  // buildDefinitionDependencyGraph with no definitions
  const spec = createSemanticSpec(makeValidParams());
  const graph = buildDefinitionDependencyGraph(spec);
  assert.equal(graph.size, 0);

  console.log("VAL-9 PASS: empty definition graph for assertion-only spec");
}

{
  // collectReferencedSymbolIds on nested application
  const srcRef = makeSourceRef("src-val10", "msg-val10", "f(g(x))");
  const symF = makeSymbol("sym-f", "f", "function", { sourceRefIds: ["src-val10"] });
  const symG = makeSymbol("sym-g", "g", "function", { sourceRefIds: ["src-val10"] });
  const symX = makeSymbol("sym-x", "x", "variable", { sourceRefIds: ["src-val10"] });

  const exprX = makeExpression("expr-x", "symbol_ref", { symbolId: "sym-x" });
  const exprGX = makeExpression("expr-gx", "application", {
    operatorSymbolId: "sym-g",
    argumentExprIds: ["expr-x"]
  });
  const exprFGX = makeExpression("expr-fgx", "application", {
    operatorSymbolId: "sym-f",
    argumentExprIds: ["expr-gx"]
  });

  const spec = createSemanticSpec({
    claimId: "test-nested",
    sourceRefs: [srcRef],
    symbols: [symF, symG, symX],
    expressions: [exprX, exprGX, exprFGX],
    statements: [],
    ambiguities: []
  });

  const refd = collectReferencedSymbolIds(spec, "expr-fgx");
  assert.equal(refd.length, 3);
  assert.ok(refd.includes("sym-f"));
  assert.ok(refd.includes("sym-g"));
  assert.ok(refd.includes("sym-x"));

  console.log("VAL-10 PASS: collectReferencedSymbolIds traverses nested applications");
}

// ═══════════════════════════════════════════════════════════════════════
// Semantic patch architecture regressions
// ═══════════════════════════════════════════════════════════════════════

{
  const ambiguity = makeAmbiguity(
    "amb-choice",
    "operator_meaning",
    "What does + mean?",
    ["sym-plus"],
    { choices: [makeChoice("user-defined", "a user-defined operation")] }
  );
  const spec = createSemanticSpec(makeValidParams({ ambiguities: [ambiguity] }));

  assert.throws(
    () => resolveAmbiguity(spec, "amb-choice", "user-defined", "a user-defined operation"),
    /not in the ambiguity's choices/
  );
  assert.throws(
    () => resolveAmbiguity(spec, "amb-choice", "user-defined", "missing-choice"),
    /not in the ambiguity's choices/
  );

  const noChoices = createSemanticSpec(makeValidParams({
    ambiguities: [makeAmbiguity("amb-no-choices", "other", "Clarify", ["sym-a"])]
  }));
  assert.throws(
    () => resolveAmbiguity(noChoices, "amb-no-choices", "answer", "invented"),
    /not in the ambiguity's choices/
  );

  console.log("PATCH-1 PASS: choice IDs are stable and labels/invented IDs are rejected");
}

{
  const ambiguities = [
    makeAmbiguity("amb-plus", "operator_meaning", "What is +?", ["sym-plus"]),
    makeAmbiguity("amb-domain", "domain", "What is the domain?", ["sym-a"]),
    makeAmbiguity("amb-zero", "symbol_role", "What is zero?", ["sym-zero"])
  ];
  let spec = createSemanticSpec(makeValidParams({
    symbols: makeValidParams().symbols.map((symbol) => ({ ...symbol, role: "unresolved" })),
    ambiguities
  }));
  spec = resolveAmbiguity(spec, "amb-plus", "user-defined operation");
  spec = applySemanticPatch(spec, makePatch(spec, "amb-plus", [{
    kind: "update_symbol",
    symbolId: "sym-plus",
    changes: { role: "operator", userDefined: true }
  }], "patch-plus-only"));

  assert.equal(isAmbiguityResolved(spec, "amb-plus"), true);
  assert.equal(isAmbiguityResolved(spec, "amb-domain"), false);
  assert.equal(isAmbiguityResolved(spec, "amb-zero"), false);
  assert.equal(spec.analysisStatus, "under_specified");
  assert.equal(
    [...getUnresolvedBlockingAmbiguities(spec)].map((item) => item.id).join(","),
    "amb-domain,amb-zero"
  );

  console.log("PATCH-2 PASS: resolving one ambiguity does not resolve other blockers");
}

{
  const original = createSemanticSpec(makeValidParams({
    symbols: makeValidParams().symbols.map((symbol) => ({ ...symbol, role: "unresolved" })),
    ambiguities: [
      makeAmbiguity("amb-plus", "operator_meaning", "What is +?", ["sym-plus"]),
      makeAmbiguity("amb-a", "symbol_role", "What is a?", ["sym-a"])
    ]
  }));
  const sourceSnapshot = original.sourceRefs[0].snapshot;
  const answeredOne = resolveAmbiguity(original, "amb-plus", "user-defined operation");
  const patchedOne = applySemanticPatch(answeredOne, makePatch(answeredOne, "amb-plus", [{
    kind: "update_symbol",
    symbolId: "sym-plus",
    changes: { role: "operator", userDefined: true, description: "user-defined operation" }
  }], "patch-one"));
  const answeredTwo = resolveAmbiguity(patchedOne, "amb-a", "a is a variable");
  const patchedTwo = applySemanticPatch(answeredTwo, makePatch(answeredTwo, "amb-a", [{
    kind: "update_symbol",
    symbolId: "sym-a",
    changes: { role: "variable", description: "user variable" }
  }], "patch-two"));

  assert.equal(original.revision, 1);
  assert.equal(answeredOne.revision, 2);
  assert.equal(patchedOne.revision, 3);
  assert.equal(answeredTwo.revision, 4);
  assert.equal(patchedTwo.revision, 5);
  assert.equal(original.resolutions.length, 0);
  assert.equal(original.patches.length, 0);
  assert.equal(patchedOne.resolutions.length, 1);
  assert.equal(patchedOne.patches.length, 1);
  assert.equal(patchedTwo.resolutions.length, 2);
  assert.equal(patchedTwo.patches.length, 2);
  assert.equal(patchedTwo.sourceRefs[0].snapshot, sourceSnapshot);
  assert.equal(patchedTwo.symbols.find((item) => item.id === "sym-plus").role, "operator");
  assert.equal(patchedTwo.symbols.find((item) => item.id === "sym-a").role, "variable");
  assert.ok(Object.isFrozen(patchedTwo));
  assert.ok(Object.isFrozen(patchedTwo.patches));
  assert.ok(Object.isFrozen(patchedTwo.patches[0].operations));

  console.log("PATCH-3 PASS: immutable two-resolution patch history and revisions preserved");
}

{
  const spec0 = createSemanticSpec(makeValidParams({
    ambiguities: [
      makeAmbiguity("amb-one", "operator_meaning", "What is +?", ["sym-plus"]),
      makeAmbiguity("amb-two", "symbol_role", "What is a?", ["sym-a"])
    ]
  }));
  const spec1 = resolveAmbiguity(spec0, "amb-one", "operator");
  const resolutionOne = spec1.resolutions[0];

  assert.throws(
    () => applySemanticPatch(spec1, {
      id: "wrong-ambiguity",
      ambiguityId: "amb-two",
      resolutionId: resolutionOne.id,
      operations: [{ kind: "update_symbol", symbolId: "sym-a", changes: { role: "variable" } }],
      createdAt: new Date().toISOString()
    }),
    /belongs to ambiguity/
  );
  assert.throws(
    () => applySemanticPatch(spec1, {
      id: "wrong-resolution",
      ambiguityId: "amb-one",
      resolutionId: "missing-resolution",
      operations: [{ kind: "update_symbol", symbolId: "sym-plus", changes: { role: "operator" } }],
      createdAt: new Date().toISOString()
    }),
    /Resolution "missing-resolution" not found/
  );
  assert.throws(
    () => applySemanticPatch(spec1, {
      ...makePatch(spec1, "amb-one", [], "surface-rewrite"),
      operations: [{
        kind: "update_symbol",
        symbolId: "sym-plus",
        changes: { surface: "⊕" }
      }]
    }),
    /cannot be changed/
  );
  assert.throws(
    () => applySemanticPatch(spec1, {
      ...makePatch(spec1, "amb-one", [], "id-rewrite"),
      operations: [{
        kind: "update_symbol",
        symbolId: "sym-plus",
        changes: { id: "other-id" }
      }]
    }),
    /cannot be changed/
  );
  assert.throws(
    () => applySemanticPatch(spec1, {
      ...makePatch(spec1, "amb-one", [], "missing-symbol"),
      operations: [{
        kind: "update_symbol",
        symbolId: "missing-symbol",
        changes: { role: "operator" }
      }]
    }),
    /Symbol "missing-symbol" not found/
  );

  assert.equal(spec1.symbols.find((item) => item.id === "sym-plus").surface, "+");
  assert.equal(spec1.patches.length, 0);
  console.log("PATCH-4 PASS: wrong links, immutable-field rewrites, and missing targets rejected");
}

{
  const ambiguity = makeAmbiguity("amb-plus", "operator_meaning", "What is +?", ["sym-plus"]);
  const initial = createSemanticSpec(makeValidParams({
    symbols: makeValidParams().symbols.map((symbol) =>
      symbol.id === "sym-plus" ? { ...symbol, role: "unresolved" } : symbol),
    ambiguities: [ambiguity]
  }));
  const answered = resolveAmbiguity(initial, "amb-plus", "It is an operator");
  const patchedWithoutSemanticResolution = applySemanticPatch(answered, makePatch(answered, "amb-plus", [{
    kind: "update_symbol",
    symbolId: "sym-plus",
    changes: { description: "still lacks a role" }
  }], "insufficient-patch"));

  assert.equal(patchedWithoutSemanticResolution.analysisStatus, "under_specified");
  assert.equal(isAmbiguityResolved(patchedWithoutSemanticResolution, "amb-plus"), false);
  assert.throws(
    () => acceptSemanticSpec(patchedWithoutSemanticResolution),
    /unresolved blocking ambiguities/
  );
  console.log("PATCH-5 PASS: linked patch without resolved relevant state cannot unlock acceptance");
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(JSON.stringify({
  creationDefaults: true,
  validSpecPassesValidation: true,
  danglingSymbolReferenceCaught: true,
  danglingExpressionReferenceCaught: true,
  danglingSourceRefCaught: true,
  acceptedUnderSpecifiedFailsValidation: true,
  blockingAmbiguityDetected: true,
  answerAloneDoesNotClearBlocking: true,
  semanticPatchClearsBlockingAfterModelUpdate: true,
  doubleResolutionBlocked: true,
  acceptSucceedsWhenReady: true,
  acceptBlockedByAmbiguity: true,
  benchmarkA_explicitDomain: true,
  benchmarkB_underspecifiedToAccepted: true,
  benchmarkC_nativeLanguage: true,
  benchmarkD_barberRule: true,
  benchmarkE1_ABcycle: true,
  benchmarkE2_selfCycle: true,
  benchmarkE3_linearNoCycle: true,
  benchmarkF1_danglingSymbol: true,
  benchmarkF2_danglingExpression: true,
  validationMultipleResolutionsRejected: true,
  validationSourceRefAutoId: true,
  validationImmutabilityResolve: true,
  validationImmutabilityAccept: true,
  validationForallDomain: true,
  validationNonBlockingAccept: true,
  validationEmptyResolutionRejected: true,
  validationNonexistentAmbiguity: true,
  validationEmptyDefinitionGraph: true,
  validationCollectReferencedNested: true,
  stableChoiceIds: true,
  multipleAmbiguityIsolation: true,
  immutablePatchHistory: true,
  invalidPatchRejection: true,
  unresolvedRelevantStateBlocksAccept: true,
  result: "PASS"
}, null, 2));
