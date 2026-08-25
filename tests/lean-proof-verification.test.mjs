import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  createLeanProofCandidate,",
      "  hashLeanStatement,",
      "  deriveSafeTheoremName,",
      "  extractLeanPropositionFromCheckSource,",
      "  buildLeanProofVerificationSource,",
      "  validateLeanProofCandidate,",
      "  verifyLeanProofWithRunner",
      "} from './src/LeanProofVerification';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "lean-proof-verification-entry.ts",
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
  createLeanProofCandidate,
  hashLeanStatement,
  deriveSafeTheoremName,
  extractLeanPropositionFromCheckSource,
  buildLeanProofVerificationSource,
  validateLeanProofCandidate,
  verifyLeanProofWithRunner
} = module.exports;

function candidate(overrides = {}) {
  return createLeanProofCandidate({
    formalizationId: "formalization-1",
    theoremStatement: "1 + 1 = 2",
    proofBody: "norm_num",
    imports: ["Mathlib.Data.Nat.Basic"],
    provenance: "user_authored",
    ...overrides
  });
}

// ── T01: deterministic candidate and hash ──────────────────────────────
const c = candidate();
assert.equal(c.theoremStatement, "1 + 1 = 2");
assert.equal(c.theoremStatementHash, hashLeanStatement("1 + 1 = 2", ["Mathlib.Data.Nat.Basic"]));
assert.equal(
  createLeanProofCandidate({
    formalizationId: "formalization-1",
    theoremStatement: "1 + 1 = 2",
    proofBody: "norm_num",
    imports: ["Mathlib.Data.Nat.Basic"]
  }).theoremStatementHash,
  c.theoremStatementHash
);
console.log("T01 PASS: deterministic candidate and hash");

// ── T02: trusted wrapper owns theorem proposition ──────────────────────
const source = buildLeanProofVerificationSource(c);
assert.match(source, /import Mathlib\.Data\.Nat\.Basic/);
assert.match(source, /theorem lain_target_[0-9a-f]{8} : 1 \+ 1 = 2 := by/);
assert.match(source, /\n  norm_num/);
assert.doesNotMatch(source, /theorem .* : True/);
console.log("T02 PASS: trusted wrapper");

// ── T03: sorry / admit rejected ────────────────────────────────────────
assert.ok(
  validateLeanProofCandidate(candidate({ proofBody: "sorry" }))
    .some((issue) => issue.code === "placeholder")
);
assert.ok(
  validateLeanProofCandidate(candidate({ proofBody: "admit" }))
    .some((issue) => issue.code === "placeholder")
);
console.log("T03 PASS: sorry/admit rejected");

// ── T04: fresh axiom / top-level declaration rejected ──────────────────
assert.ok(
  validateLeanProofCandidate(
    candidate({ proofBody: "axiom magic : False\nexact magic" })
  ).some((issue) => issue.code === "fresh_declaration")
);
assert.ok(
  validateLeanProofCandidate(
    candidate({ proofBody: "theorem cheat : True := trivial\nexact cheat" })
  ).some((issue) => issue.code === "fresh_declaration")
);
console.log("T04 PASS: fresh declaration injection rejected");

// ── T05: statement substitution cannot change target ───────────────────
const falseCandidate = candidate({
  theoremStatement: "False",
  proofBody: "exact True.intro"
});
const falseSource = buildLeanProofVerificationSource(falseCandidate);
assert.match(falseSource, /: False := by/);
assert.doesNotMatch(falseSource, /: True := by/);
console.log("T05 PASS: statement substitution resisted");

// ── T06: runner success is proof_verified signal only for wrapper ──────
const success = await verifyLeanProofWithRunner(c, {
  check: async () => ({
    status: "statement_typechecked",
    diagnostics: [],
    exitCode: 0,
    stdout: "1 + 1 = 2 : Prop",
    stderr: ""
  })
});
assert.equal(success.ok, true);
assert.equal(success.verified, true);
assert.match(success.source, /theorem lain_target_/);
console.log("T06 PASS: runner success through wrapper");

// ── T07: runner failure is not proof_verified ──────────────────────────
const failure = await verifyLeanProofWithRunner(c, {
  check: async () => ({
    status: "error",
    diagnostics: [{ severity: "error", message: "unknown identifier" }],
    exitCode: 1,
    stdout: "",
    stderr: "unknown identifier"
  })
});
assert.equal(failure.ok, false);
assert.equal(failure.verified, false);
assert.equal(failure.failure, "lean_error");
console.log("T07 PASS: runner failure not verified");

// ── T08: statement extraction from generated check source ──────────────
const statement = extractLeanPropositionFromCheckSource(
  "import Mathlib.Data.Real.Basic\n\nset_option autoImplicit false\n\n" +
  "#check (∀ value : ℝ, value + 0 = value)"
);
assert.equal(statement, "∀ value : ℝ, value + 0 = value");
console.log("T08 PASS: statement extraction");

// ── T09: placeholder candidate cannot verify through runner ────────────
const sorryResult = await verifyLeanProofWithRunner(
  candidate({ proofBody: "sorry" }),
  {
    check: async () => ({
      status: "statement_typechecked",
      diagnostics: [],
      exitCode: 0,
      stdout: "",
      stderr: ""
    })
  }
);
assert.equal(sorryResult.ok, false);
assert.equal(sorryResult.verified, false);
assert.equal(sorryResult.failure, "placeholder_rejected");
console.log("T09 PASS: placeholder never verifies");

console.log("lean-proof-verification.test.mjs PASS");
