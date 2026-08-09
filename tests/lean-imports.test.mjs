// ═══════════════════════════════════════════════════════════════════════
// Lean Import Tests
//
// Covers:
//   A. No import — empty imports array produces no import lines
//   B. Narrow import — specific module like Mathlib.Data.Real.Basic
//   C. Fallback — imports = ["Mathlib"] as explicit fallback
//   D. Multiple imports — order preserved, line-by-line
//   E. Backward compat — deserialized artifacts without imports
//      default to ["Mathlib"]
// ═══════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  buildLeanCode,",
      "  validateLeanBodyNoImports,",
      "  LEAN_ARTIFACT_SCHEMA_VERSION,",
      "  serializeLeanArtifactIndex,",
      "  deserializeLeanArtifactIndex,",
      "  validateLeanCode",
      "} from './src/FormalizationProtocol';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "lean-imports-entry.ts",
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
  Buffer,
  crypto: { randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout
});
const {
  buildLeanCode,
  validateLeanBodyNoImports,
  LEAN_ARTIFACT_SCHEMA_VERSION,
  serializeLeanArtifactIndex,
  deserializeLeanArtifactIndex,
  validateLeanCode
} = module.exports;

// ═══════════════════════════════════════════════════════════════════════
// Test A: No import
// ═══════════════════════════════════════════════════════════════════════

{
  const body = [
    "set_option autoImplicit false",
    "",
    "#check (1 + 1 : Nat)"
  ].join("\n");

  const code = buildLeanCode([], body);

  // Must NOT contain any import line
  assert.ok(!code.includes("import "), "empty imports must produce no import lines");
  assert.ok(code.startsWith("set_option autoImplicit false"));
  assert.ok(code.includes("#check (1 + 1 : Nat)"));

  // Must equal body exactly (no extra newlines)
  assert.equal(code, body);

  console.log("IMPORT-A PASS: no import — empty imports produces no import lines");
}

// ═══════════════════════════════════════════════════════════════════════
// Test B: Narrow import
// ═══════════════════════════════════════════════════════════════════════

{
  const body = [
    "set_option autoImplicit false",
    "",
    "#check (∀ value : ℝ, value + 0 = value)"
  ].join("\n");

  const code = buildLeanCode(["Mathlib.Data.Real.Basic"], body);

  assert.ok(code.startsWith("import Mathlib.Data.Real.Basic\n"));
  assert.ok(code.includes("set_option autoImplicit false"));
  assert.ok(code.includes("∀ value : ℝ, value + 0 = value"));
  // Must NOT contain the full `import Mathlib`
  const importLines = code.split("\n").filter(l => l.startsWith("import "));
  assert.equal(importLines.length, 1);
  assert.equal(importLines[0], "import Mathlib.Data.Real.Basic");

  console.log("IMPORT-B PASS: narrow import — specific module used");
}

// ═══════════════════════════════════════════════════════════════════════
// Test C: Fallback — imports = ["Mathlib"]
// ═══════════════════════════════════════════════════════════════════════

{
  const body = [
    "set_option autoImplicit false",
    "",
    "#check (1 + 1 : Nat)"
  ].join("\n");

  const code = buildLeanCode(["Mathlib"], body);

  assert.ok(code.startsWith("import Mathlib\n"));
  assert.ok(code.includes("set_option autoImplicit false"));
  assert.ok(code.includes("#check (1 + 1 : Nat)"));

  // Single import line
  const importLines = code.split("\n").filter(l => l.startsWith("import "));
  assert.equal(importLines.length, 1);
  assert.equal(importLines[0], "import Mathlib");

  console.log("IMPORT-C PASS: fallback — explicit import Mathlib works");
}

// ═══════════════════════════════════════════════════════════════════════
// Test D: Multiple imports — order preserved, no duplicate Mathlib
// ═══════════════════════════════════════════════════════════════════════

{
  const body = [
    "set_option autoImplicit false",
    "",
    "#check (∀ x : ℝ, x + 0 = x)"
  ].join("\n");

  const imports = [
    "Mathlib.Data.Real.Basic",
    "Mathlib.Algebra.Group.Basic"
  ];

  const code = buildLeanCode(imports, body);

  // Both imports present in order
  const importLines = code.split("\n").filter(l => l.startsWith("import "));
  assert.equal(importLines.length, 2);
  assert.equal(importLines[0], "import Mathlib.Data.Real.Basic");
  assert.equal(importLines[1], "import Mathlib.Algebra.Group.Basic");

  // Body follows after a blank line
  const afterImports = code.split("\n\n").slice(1).join("\n\n");
  assert.equal(afterImports, body);

  console.log("IMPORT-D PASS: multiple imports — order preserved line by line");
}

// ═══════════════════════════════════════════════════════════════════════
// Test E: Schema version is 2
// ═══════════════════════════════════════════════════════════════════════

{
  assert.equal(LEAN_ARTIFACT_SCHEMA_VERSION, 2);
  console.log("IMPORT-E PASS: schema version is 2");
}

// ═══════════════════════════════════════════════════════════════════════
// Test F: Backward compat — old artifact without imports defaults to ["Mathlib"]
// ═══════════════════════════════════════════════════════════════════════

{
  // Simulate a v1 artifact (no imports field)
  const oldArtifact = {
    id: "old-artifact-1",
    claimId: "claim-1",
    formalizationId: "formal-1",
    generatedCode: "import Mathlib\n\n#check (1 + 1 : Nat)",
    reviewedCode: "import Mathlib\n\n#check (1 + 1 : Nat)",
    status: "statement_typechecked",
    diagnostics: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const index = {
    schemaVersion: 2,
    artifacts: { [oldArtifact.id]: oldArtifact }
  };

  const serialized = serializeLeanArtifactIndex(index);
  const deserialized = deserializeLeanArtifactIndex(serialized);

  assert.ok(deserialized !== null);
  const restored = deserialized.artifacts[oldArtifact.id];
  assert.ok(restored !== undefined);

  // imports should default to ["Mathlib"] for backward compat
  assert.ok(Array.isArray(restored.imports));
  assert.equal(restored.imports.length, 1);
  assert.equal(restored.imports[0], "Mathlib");

  console.log("IMPORT-F PASS: backward compat — missing imports defaults to [\"Mathlib\"]");
}

// ═══════════════════════════════════════════════════════════════════════
// Test F2: Schema version 3 (unknown future) is rejected
// ═══════════════════════════════════════════════════════════════════════

{
  const futureIndex = {
    schemaVersion: 3,
    artifacts: {}
  };

  const deserialized = deserializeLeanArtifactIndex(futureIndex);
  assert.equal(deserialized, null, "schemaVersion 3 must be rejected");

  // Also check v1 and v2 are accepted
  const v1 = deserializeLeanArtifactIndex({
    schemaVersion: 1,
    artifacts: {
      "old-artifact": {
        id: "old-artifact",
        claimId: "c1",
        formalizationId: "f1",
        generatedCode: "import Mathlib\n\n#check (1+1:Nat)",
        reviewedCode: "import Mathlib\n\n#check (1+1:Nat)",
        status: "statement_typechecked",
        diagnostics: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }
  });
  assert.ok(v1 !== null, "schemaVersion 1 must be accepted");
  assert.equal(v1.artifacts["old-artifact"].imports[0], "Mathlib");

  const v2 = deserializeLeanArtifactIndex({
    schemaVersion: 2,
    artifacts: {
      "new-artifact": {
        id: "new-artifact",
        claimId: "c2",
        formalizationId: "f2",
        imports: ["Mathlib.Data.Real.Basic"],
        generatedCode: "import Mathlib.Data.Real.Basic\n\n#check (∀ x:ℝ, x+0=x)",
        reviewedCode: "import Mathlib.Data.Real.Basic\n\n#check (∀ x:ℝ, x+0=x)",
        status: "statement_typechecked",
        diagnostics: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }
  });
  assert.ok(v2 !== null, "schemaVersion 2 must be accepted");
  assert.equal(v2.artifacts["new-artifact"].imports[0], "Mathlib.Data.Real.Basic");

  console.log("IMPORT-F2 PASS: schema version 3 rejected, v1 and v2 accepted");
}

// ═══════════════════════════════════════════════════════════════════════
// Test G: Body without import — validateLeanBodyNoImports returns empty
// ═══════════════════════════════════════════════════════════════════════

{
  const cleanBody = [
    "set_option autoImplicit false",
    "",
    "#check (∀ x : ℝ, x + 0 = x)"
  ].join("\n");

  const diags = validateLeanBodyNoImports(cleanBody);
  assert.equal(diags.length, 0,
    "clean body without imports must pass validation");

  console.log("IMPORT-G PASS: body without import directives passes guard");
}

// ═══════════════════════════════════════════════════════════════════════
// Test H: Body with `import Mathlib` — rejected
// ═══════════════════════════════════════════════════════════════════════

{
  const badBody = [
    "import Mathlib",
    "",
    "set_option autoImplicit false",
    "",
    "#check (∀ x : ℝ, x + 0 = x)"
  ].join("\n");

  const diags = validateLeanBodyNoImports(badBody);
  assert.equal(diags.length, 1, "body with import Mathlib must be rejected");
  assert.equal(diags[0].severity, "error");
  assert.ok(diags[0].message.includes("LLM violated"),
    `message must indicate contract violation, got: ${diags[0].message}`);
  assert.equal(diags[0].line, 1,
    "diagnostic must point to the import line");

  console.log("IMPORT-H PASS: body containing `import Mathlib` is rejected");
}

// ═══════════════════════════════════════════════════════════════════════
// Test I: Body with leading-whitespace `import` — rejected
// ═══════════════════════════════════════════════════════════════════════

{
  const badBody = [
    "set_option autoImplicit false",
    "",
    "  import Mathlib.Data.Real.Basic",
    "",
    "#check (∀ x : ℝ, x + 0 = x)"
  ].join("\n");

  const diags = validateLeanBodyNoImports(badBody);
  assert.equal(diags.length, 1,
    "body with whitespace-prefixed import must be rejected");
  assert.equal(diags[0].severity, "error");
  assert.equal(diags[0].line, 3,
    "diagnostic must point to the correct line (3, not 1)");

  console.log("IMPORT-I PASS: leading-whitespace import directive rejected");
}

// ═══════════════════════════════════════════════════════════════════════
// Test J: Prose word "import" not caught as false positive
// ═══════════════════════════════════════════════════════════════════════

{
  // "import" appears mid-line as part of prose, not as a directive
  const proseBody = [
    "set_option autoImplicit false",
    "",
    "/-- The import of this lemma from Mathlib is nontrivial. --/",
    "",
    "#check (∀ x : ℝ, x + 0 = x)"
  ].join("\n");

  const diags = validateLeanBodyNoImports(proseBody);
  assert.equal(diags.length, 0,
    "prose word 'import' must not be mistaken for a directive");

  // Commented-out import should also be ignored
  const commentedBody = [
    "set_option autoImplicit false",
    "",
    "-- import Mathlib  -- (commented out)",
    "",
    "#check (1 + 1 : Nat)"
  ].join("\n");

  const diags2 = validateLeanBodyNoImports(commentedBody);
  assert.equal(diags2.length, 0,
    "commented-out import must not be caught");

  // Tab-indented import should still be caught (it's a directive)
  const tabbedBody = [
    "set_option autoImplicit false",
    "",
    "\timport Mathlib",
    "",
    "#check (1 + 1 : Nat)"
  ].join("\n");

  const diags3 = validateLeanBodyNoImports(tabbedBody);
  assert.equal(diags3.length, 1,
    "tab-indented import directive must still be caught");

  console.log("IMPORT-J PASS: prose 'import' and comments not falsely flagged");
}

// ═══════════════════════════════════════════════════════════════════════
// Regression: `import Mathlib -- trailing comment` must be rejected
// ═══════════════════════════════════════════════════════════════════════

{
  const body = [
    "set_option autoImplicit false",
    "",
    "import Mathlib -- trailing comment",
    "",
    "#check (∀ x : ℝ, x + 0 = x)"
  ].join("\n");

  const diags = validateLeanBodyNoImports(body);
  assert.equal(diags.length, 1,
    "import with trailing comment must be rejected");
  assert.equal(diags[0].severity, "error");
  assert.equal(diags[0].line, 3);

  // Variant: import module path with trailing comment
  const body2 = [
    "import Mathlib.Data.Real.Basic -- comment",
    "",
    "set_option autoImplicit false",
    "",
    "#check (∀ x : ℝ, x + 0 = x)"
  ].join("\n");

  const diags2 = validateLeanBodyNoImports(body2);
  assert.equal(diags2.length, 1,
    "import with module path and trailing comment must be rejected");

  console.log("IMPORT-J2 PASS: import with trailing comment rejected");
}

// ═══════════════════════════════════════════════════════════════════════
// Regression: `  -- import Mathlib` (commented-out) must be allowed
// ═══════════════════════════════════════════════════════════════════════

{
  const body = [
    "set_option autoImplicit false",
    "",
    "  -- import Mathlib",
    "",
    "#check (1 + 1 : Nat)"
  ].join("\n");

  const diags = validateLeanBodyNoImports(body);
  assert.equal(diags.length, 0,
    "commented-out import with leading whitespace must be allowed");

  // Additional variant: comment at column 0
  const body2 = [
    "-- import Mathlib.Data.Real.Basic",
    "",
    "set_option autoImplicit false",
    "",
    "#check (1 + 1 : Nat)"
  ].join("\n");

  const diags2 = validateLeanBodyNoImports(body2);
  assert.equal(diags2.length, 0,
    "commented-out import at column 0 must be allowed");

  console.log("IMPORT-J3 PASS: commented-out import with leading whitespace allowed");
}

// ═══════════════════════════════════════════════════════════════════════
// Test K: Narrow-import code passes safety validator (old G)
// ═══════════════════════════════════════════════════════════════════════

{
  const code = buildLeanCode(
    ["Mathlib.Data.Real.Basic"],
    [
      "set_option autoImplicit false",
      "",
      "#check (∀ value : ℝ, value + 0 = value)"
    ].join("\n")
  );

  const diagnostics = validateLeanCode(code);
  assert.equal(diagnostics.length, 0, "narrow-import code must pass safety validator");

  console.log("IMPORT-K PASS: narrow-import code passes safety validator");
}

// ═══════════════════════════════════════════════════════════════════════
// Test L: Multiple-import code structure is correct (old H)
// ═══════════════════════════════════════════════════════════════════════

{
  // Three imports, verify ordering
  const imports = [
    "Mathlib.Data.Real.Basic",
    "Mathlib.Algebra.Group.Basic",
    "Mathlib.Tactic"
  ];

  const body = [
    "set_option autoImplicit false",
    "",
    "open Real",
    "",
    "#check (∀ x : ℝ, x + 0 = x)"
  ].join("\n");

  const code = buildLeanCode(imports, body);

  const lines = code.split("\n");
  assert.equal(lines[0], "import Mathlib.Data.Real.Basic");
  assert.equal(lines[1], "import Mathlib.Algebra.Group.Basic");
  assert.equal(lines[2], "import Mathlib.Tactic");
  assert.equal(lines[3], "");  // blank separator
  assert.equal(lines[4], "set_option autoImplicit false");

  console.log("IMPORT-L PASS: three imports preserve ordering with blank separator");
}

// ═══════════════════════════════════════════════════════════════════════
// Test M: Full artifact round-trip with explicit imports (old I)
// ═══════════════════════════════════════════════════════════════════════

{
  const artifact = {
    id: "lean-artifact-imports-test",
    claimId: "claim-real-1",
    formalizationId: "formal-real-1",
    imports: ["Mathlib.Data.Real.Basic"],
    generatedCode: buildLeanCode(
      ["Mathlib.Data.Real.Basic"],
      [
        "set_option autoImplicit false",
        "",
        "#check (∀ x : ℝ, x + 0 = x)"
      ].join("\n")
    ),
    reviewedCode: buildLeanCode(
      ["Mathlib.Data.Real.Basic"],
      [
        "set_option autoImplicit false",
        "",
        "#check (∀ x : ℝ, x + 0 = x)"
      ].join("\n")
    ),
    status: "statement_typechecked",
    diagnostics: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const index = {
    schemaVersion: 2,
    artifacts: { [artifact.id]: artifact }
  };

  const serialized = serializeLeanArtifactIndex(index);
  const deserialized = deserializeLeanArtifactIndex(serialized);

  assert.ok(deserialized !== null);
  const restored = deserialized.artifacts[artifact.id];
  assert.ok(restored !== undefined);

  // imports preserved
  assert.ok(Array.isArray(restored.imports));
  assert.equal(restored.imports.length, 1);
  assert.equal(restored.imports[0], "Mathlib.Data.Real.Basic");

  // The generated code contains the narrow import
  assert.ok(restored.generatedCode.includes("import Mathlib.Data.Real.Basic"));
  assert.ok(!restored.generatedCode.includes("import Mathlib\n"));

  console.log("IMPORT-M PASS: full artifact round-trip with explicit imports preserved");
}

// ═══════════════════════════════════════════════════════════════════════
// Complete
// ═══════════════════════════════════════════════════════════════════════

console.log(JSON.stringify({
  noImportProducesNoImportLines: true,
  narrowImportSpecificModule: true,
  fallbackExplicitMathlib: true,
  multipleImportsOrderPreserved: true,
  schemaVersionIs2: true,
  backwardCompatDefaultsToMathlib: true,
  schemaVersion3Rejected: true,
  bodyWithoutImportPassesGuard: true,
  bodyWithImportMathlibRejected: true,
  bodyWithLeadingWhitespaceImportRejected: true,
  proseImportNotFalsePositive: true,
  importWithTrailingCommentRejected: true,
  commentedOutImportWithWhitespaceAllowed: true,
  narrowImportPassesSafetyValidator: true,
  threeImportsOrderCorrect: true,
  fullArtifactRoundTrip: true,
  result: "PASS"
}, null, 2));
