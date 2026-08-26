// ── M2B.6a-v0 — Test A: runtime sense projection ──────────────────────
//
// The projection is transient and read-only:
//   - each existing ConceptNode bucket maps to the correct runtime
//     authority class;
//   - provenance of every bucket is retained, never invented or erased;
//   - projection is deterministic; derived ids are stable per source
//     entry id, never array-position dependent;
//   - the source ConceptNode is never mutated.
// ────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  projectRuntimeSenseCandidates,",
      "  findConceptSurfaceMentions,",
      "  conceptSurfaces,",
      "  deriveDistinctiveTerms,",
      "  containsSurfaceMention,",
      "  normalizeSurfaceText",
      "} from './src/RuntimeSenseProjection';",
      "",
      "export {",
      "  createConceptNode,",
      "  updateConceptNode",
      "} from './src/BrainGrowth';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "projection-entry.ts",
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
          "exports.requestUrl = async () => { throw new Error('Unexpected network request'); };",
          "exports.Plugin = class {};",
          "exports.WorkspaceLeaf = class {};",
          "exports.Modal = class { constructor(){} open(){} close(){} };",
          "exports.setIcon = () => {};",
          "exports.TFile = class TFile { constructor(path, extension = 'md') { this.path = path; this.extension = extension; } };",
          "exports.MarkdownView = class MarkdownView {};",
          "exports.parseLinktext = (link) => ({ path: link.split('#')[0], subpath: link.includes('#') ? link.split('#')[1] : '' });"
        ].join("\n")
      }));
    }
  }]
});

const mod = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  DOMMatrix: class { constructor(){} },
  module: mod,
  exports: mod.exports,
  require,
  console,
  URL,
  crypto: { randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 8) },
  setTimeout,
  clearTimeout,
  Promise
});

const {
  projectRuntimeSenseCandidates,
  findConceptSurfaceMentions,
  conceptSurfaces,
  deriveDistinctiveTerms,
  containsSurfaceMention,
  createConceptNode,
  updateConceptNode
} = mod.exports;

const CREATED_AT = "2026-08-27T00:00:00.000Z";

const ASSISTANT_DEF = {
  id: "chat-definition:assistant",
  text: "lain 的助手实体，lain 用这个名字指代自己的助手，会回应 lain 的问题",
  sourceRefs: [{
    sourceKind: "user_edit",
    editId: "chat-semantic-confirmation:assistant",
    snapshot: "lain 的助手实体，lain 用这个名字指代自己的助手，会回应 lain 的问题",
    actor: "user"
  }]
};

const LEGACY_DEF = {
  id: "chat-definition:legacy",
  text: "lain 以前给某个旧项目起的名字",
  sourceRefs: [{
    sourceKind: "user_edit",
    editId: "chat-semantic-confirmation:legacy",
    snapshot: "lain 以前给某个旧项目起的名字",
    actor: "user"
  }]
};

function makeConceptNode() {
  const base = createConceptNode({
    id: "concept:mirai",
    title: "mirai",
    aliases: ["未来"],
    createdAt: CREATED_AT
  });
  const withConfirmed = updateConceptNode(base, {
    userDefinition: ASSISTANT_DEF,
    userDefinitionMode: "explicit_user_redefinition"
  }, {
    changedAt: CREATED_AT,
    reason: "fixture: confirmed definition"
  });
  // A different user definition without explicit redefinition is preserved
  // as an unresolved alternative — the existing preserve_user_meaning flow.
  const withAlternative = updateConceptNode(withConfirmed, {
    userDefinition: LEGACY_DEF
  }, {
    changedAt: CREATED_AT,
    reason: "fixture: preserved alternative"
  });
  return updateConceptNode(withAlternative, {
    standardDefinitions: [{
      id: "ext:future",
      text: "日语里的未来，读作 mirai，意思是 future",
      sourceReferences: ["https://example.org/ja-mirai"]
    }, {
      id: "ext:english",
      text: "English 'mirai' is a transliteration of Japanese future",
      sourceReferences: ["https://example.org/en-mirai"]
    }],
    generatedInterpretations: [{
      id: "ai:hypothesis-1",
      text: "可能也指 lain 的某个测试项目代号",
      sourceReferences: ["chat:message-1"]
    }]
  }, {
    changedAt: CREATED_AT,
    reason: "fixture: external + AI content"
  });
}

// ── A1: every bucket maps to the correct runtime authority ─────────────

{
  const node = makeConceptNode();
  const candidates = projectRuntimeSenseCandidates(node, "mirai");

  const byBucket = new Map(
    candidates.map((candidate) => [candidate.sourceBucket, candidate])
  );
  assert.equal(candidates.length, 5, "all four buckets project one candidate each");

  const confirmed = byBucket.get("userDefinition");
  assert.equal(confirmed.authority, "user_confirmed_personal");
  assert.equal(confirmed.provenance.kind, "user_text");
  assert.deepEqual(
    [...confirmed.provenance.refs.map((ref) => ref.snapshot)],
    ["lain 的助手实体，lain 用这个名字指代自己的助手，会回应 lain 的问题"]
  );
  assert.ok(confirmed.provenance.refs.every((ref) => ref.actor === "user"));

  const unconfirmed = byBucket.get("alternativeUserDefinitions");
  assert.equal(unconfirmed.authority, "user_authored_unconfirmed");
  assert.equal(unconfirmed.provenance.kind, "user_text");

  const external = candidates.find(
    (candidate) => candidate.id.endsWith(":ext:future")
  );
  assert.equal(external.authority, "external_conventional");
  assert.equal(external.provenance.kind, "external_source");
  assert.deepEqual(
    [...external.provenance.refs],
    ["https://example.org/ja-mirai"],
    "external provenance retained verbatim — never erased"
  );

  const ai = byBucket.get("generatedInterpretations");
  assert.equal(ai.authority, "ai_provisional");
  assert.equal(ai.provenance.kind, "ai_generated");
  assert.deepEqual([...ai.provenance.refs], ["chat:message-1"]);
}

// ── A2: deterministic projection with stable per-entry ids ─────────────

{
  const node = makeConceptNode();
  const first = projectRuntimeSenseCandidates(node, "mirai");
  const second = projectRuntimeSenseCandidates(node, "mirai");
  assert.deepEqual(first, second, "projection is deterministic");

  // Rebuild with standardDefinitions in a different order: the derived id
  // must follow the source entry id, not array position.
  const reordered = updateConceptNode(createConceptNode({
    id: "concept:mirai",
    title: "mirai",
    createdAt: CREATED_AT
  }), {
    userDefinition: node.userDefinition,
    userDefinitionMode: "explicit_user_redefinition",
    standardDefinitions: [
      node.standardDefinitions[1],
      node.standardDefinitions[0]
    ]
  }, { changedAt: CREATED_AT, reason: "reorder fixture" });
  const projected = projectRuntimeSenseCandidates(reordered, "mirai");
  const extFuture = projected.find(
    (candidate) => candidate.id.endsWith("ext:future")
  );
  assert.ok(extFuture !== undefined, "id derives from the source entry id");
  assert.equal(extFuture.id, "sense:concept:mirai:external_conventional:ext:future");
}

// ── A3: surface mention matching is conservative ───────────────────────

{
  const node = makeConceptNode();
  assert.equal(
    JSON.stringify(findConceptSurfaceMentions(node, "mirai 你觉得这个怎么样")),
    JSON.stringify(["mirai"])
  );
  assert.equal(
    JSON.stringify([...findConceptSurfaceMentions(node, "未来这个词读 mirai 吗")].sort()),
    JSON.stringify(["未来", "mirai"].sort()),
    "alias 未来 also matches (CJK substring containment)"
  );
  assert.equal(
    JSON.stringify(findConceptSurfaceMentions(node, "explain 一下")),
    JSON.stringify([]),
    "alphabetic surfaces require word boundaries — no 'lain' in 'explain'"
  );
  assert.equal(
    containsSurfaceMention("我说的蓝璃是", "蓝璃"),
    true,
    "CJK containment without word separators"
  );
  assert.equal(containsSurfaceMention("X 对我来说是某种自由", "蓝璃"), false);
  assert.equal(
    JSON.stringify(conceptSurfaces(node)),
    JSON.stringify(["mirai", "未来"])
  );
}

// ── A4: distinctive terms exclude the concept's own surfaces ───────────

{
  const node = makeConceptNode();
  const candidates = projectRuntimeSenseCandidates(node, "mirai");
  for (const candidate of candidates) {
    const terms = deriveDistinctiveTerms(candidate, conceptSurfaces(node));
    for (const term of terms) {
      assert.ok(
        !term.includes("mirai") && term !== "未来",
        `own surface must not be a distinctive term: "${term}"`
      );
    }
  }
  const future = candidates.find(
    (candidate) => candidate.id.endsWith("ext:future")
  );
  const terms = deriveDistinctiveTerms(future, conceptSurfaces(node));
  assert.ok(
    !terms.includes("未来"),
    "alias 未来 is an own surface of the concept — excluded as non-discriminating"
  );
  assert.ok(
    terms.includes("日语") || terms.includes("future"),
    "sense-specific terms remain"
  );
  // A concept whose own surfaces are only its title keeps sense terms:
  const titleOnly = deriveDistinctiveTerms(future, ["mirai"]);
  assert.ok(titleOnly.includes("未来"),
    "without the alias, 未来 is a distinctive term again");
}

// ── A5: projection never mutates the source ConceptNode ────────────────

{
  const node = makeConceptNode();
  const before = JSON.stringify(node);
  projectRuntimeSenseCandidates(node, "mirai");
  deriveDistinctiveTerms(
    projectRuntimeSenseCandidates(node, "mirai")[0],
    conceptSurfaces(node)
  );
  assert.equal(JSON.stringify(node), before, "source node unchanged");
}

console.log("CONTEXTUAL-SENSE-PROJECTION PASS");
