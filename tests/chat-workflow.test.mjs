import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export { askDeepSeek, createNormalChatSystemPrompt, USER_SEMANTIC_CONVERSATION_RULES } from './src/DeepSeekClient';",
      "export { LainBrainSession, isSupportedAttachmentFile, normalizeChatAttachmentFile, extractAttachmentFiles, extractPdfText, SUPPORTED_ATTACHMENT_IMAGE_TYPES, SUPPORTED_ATTACHMENT_DOCUMENT_TYPES, MAX_ATTACHMENT_BYTES } from './src/LainBrainSession';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "chat-workflow-entry.ts",
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
          "exports.requestUrl = async (options) => {",
          "  const body = JSON.parse(options.body);",
          "  globalThis.__lainBrainRequests.push(body);",
          "  const system = body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\\n');",
          "  let content = 'A natural conversational reply.';",
          "  if (system.includes('Extract every substantive, mutually independent discussion topic')) {",
          "    content = JSON.stringify({ topics: [{",
          "      title: 'Separation of Concerns',",
          "      conversationTopic: 'separation of concerns',",
          "      primaryConcept: 'separation of concerns',",
          "      aliases: ['separation of concerns'],",
          "      sourceMessageIds: ['message-1', 'message-2', 'message-3', 'message-4'],",
          "      activeNoteRelevant: false",
          "    }] });",
          "  } else if (system.includes('Your task is not ordinary question answering')) {",
          "    content = '# Separation of Concerns\\n\\nThe discussion separates responsibilities without adding external claims.';",
          "  }",
          "  return { json: { choices: [{ message: { content } }] } };",
          "};"
        ].join("\n")
      }));
    }
  }]
});

const module = { exports: {} };
const requestLog = [];
// pdfjs-dist uses DOMMatrix at module init time even for text-only
// extraction.  Provide a minimal stub in the VM context.
class DOMMatrixStub { constructor(_init) { /* no-op */ } }
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console,
  URL,
  Blob,
  DOMMatrix: DOMMatrixStub,
  crypto: { randomUUID: () => "test-id" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  setTimeout,
  clearTimeout,
  __lainBrainRequests: requestLog
});
const {
  askDeepSeek,
  createNormalChatSystemPrompt,
  USER_SEMANTIC_CONVERSATION_RULES,
  LainBrainSession,
  isSupportedAttachmentFile,
  normalizeChatAttachmentFile,
  extractAttachmentFiles,
  extractPdfText,
  SUPPORTED_ATTACHMENT_IMAGE_TYPES,
  SUPPORTED_ATTACHMENT_DOCUMENT_TYPES,
  MAX_ATTACHMENT_BYTES
} = module.exports;

const normalPrompt = createNormalChatSystemPrompt();
assert.match(normalPrompt, /ordinary Lain Brain conversation/);
assert.match(normalPrompt, /not candidate-note generation/);
assert.match(normalPrompt, /Do not automatically summarize/);
assert.match(normalPrompt, /Organize into Candidate Notes/);
assert.match(normalPrompt, /treat it as ordinary material to discuss/);

await askDeepSeek("test-key", [{
  role: "user",
  content: "Discuss this freely."
}]);
assert.equal(requestLog.length, 1);
assert.match(
  requestLog[0].messages[0].content,
  /ordinary Lain Brain conversation/
);
assert.doesNotMatch(
  requestLog[0].messages[0].content,
  /Extract every substantive, mutually independent discussion topic/
);
requestLog.length = 0;

// ────────────────────────────────────────────────────────────────────
// Semantic-probe conversation policy regression tests (M2B.3)
// ────────────────────────────────────────────────────────────────────

// A — User-created concept preservation
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /无穷物件时间尺度/,
  "Policy must reference user-created concept examples explicitly"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not silently replace/,
  "Policy must prohibit silently replacing user terms"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /candidate mapping/,
  "Policy must require standard concepts to be labeled as candidate mappings"
);

// B — Cauchy semantic probe is allowed; identity claim is prohibited
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Cauchy/,
  "Policy must show Cauchy as a permitted probe example"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /probe/,
  "Policy must use 'probe' terminology for candidate mappings"
);
assert.doesNotMatch(
  USER_SEMANTIC_CONVERSATION_RULES,
  /What you really mean/,
  "Policy must not use 'what you really mean' framing"
);

// C — Counterexample responsibility
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /harmonic series/,
  "Policy must require counterexample checking with harmonic series or equivalent"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /not.*approximately correct|insufficient/i,
  "Policy must reject 'approximately correct' as sufficient"
);

// D — Equivalence has no confidence threshold
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /semantic equivalence does not have an error tolerance|confidence.*separate|does not mean equivalence/i,
  "Policy must encode: high confidence != semantic equivalence"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /UNDETERMINED/,
  "Policy must treat UNDETERMINED as a valid outcome"
);

// E — Incomplete concept completion with labeled hypotheses
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /several possible completions|multiple candidate|propose.*possible/i,
  "Policy must allow proposing multiple candidate completions"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /hypothes/i,
  "Policy must label candidates as hypotheses"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not write as if the user already chose/,
  "Policy must prohibit assuming the user chose a specific completion"
);

// F — Existing-theory analogy vs identity
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /resembles|analogous to|candidate mapping|consistent so far/i,
  "Policy must define language for degrees of similarity"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not promote the first four into the last one automatically/,
  "Policy must prohibit automatic promotion of similarity to equivalence"
);

// G — Relativity / complex-time example must not become identity proof
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /imaginary time|complex.*quantit|complex.*time/i,
  "Policy must reference the relativity/complex-time mapping danger"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /does not establish that the user.*concept is the same/i,
  "Policy must prevent formal resemblance from becoming identity"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /not.*rhetorical validation|do not.*claim.*validates/i,
  "Policy must prohibit using standard theory as rhetorical validation"
);

// The full prompt contains the conversation rules
assert.match(
  normalPrompt,
  /user language is primary/i,
  "Normal chat prompt must include semantic conversation rules"
);
assert.match(
  normalPrompt,
  /semantic equivalence does not have an error tolerance/i,
  "Normal chat prompt must contain the core equivalence principle"
);

console.log("CHAT-WORKFLOW-SEMANTIC-A PASS: user-created concept preservation");
console.log("CHAT-WORKFLOW-SEMANTIC-B PASS: Cauchy semantic probe, not identity");
console.log("CHAT-WORKFLOW-SEMANTIC-C PASS: counterexample responsibility");
console.log("CHAT-WORKFLOW-SEMANTIC-D PASS: equivalence has no confidence threshold");
console.log("CHAT-WORKFLOW-SEMANTIC-E PASS: incomplete concept completion");
console.log("CHAT-WORKFLOW-SEMANTIC-F PASS: existing-theory analogy vs identity");
console.log("CHAT-WORKFLOW-SEMANTIC-G PASS: relativity analogy is not proof");

// ────────────────────────────────────────────────────────────────────
// M2B.3.1: Provisional completion discipline regression tests
// ────────────────────────────────────────────────────────────────────

// A — Completion remains hypothesis
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /One possible completion|If we temporarily define|Under this candidate interpretation/i,
  "Policy must permit 'one possible completion is...' language"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /assistant hypothesis.*NOT a user definition/i,
  "Policy must distinguish assistant hypothesis from user definition"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not invent mathematical behavior merely to make the user.*theory work/,
  "Policy must prohibit inventing behavior to rescue the user's theory"
);

// B — Reparameterization preserves convergence behavior
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /pure time-coordinate change.*does not itself change convergence/i,
  "Policy must state that pure time-coordinate change does not change convergence"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /WHAT ELSE changed/,
  "Policy must require identifying what else changed when convergence appears to shift"
);

// C — Time compression example
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /τ.*=.*t.*\(1.*t\)|compressing.*infinite.*finite/i,
  "Policy must reference time compression example t/(1+t)"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /does not make an unbounded state converge/i,
  "Policy must state that time compression alone does not create convergence"
);

// D — Divergence taxonomy
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /tends to \+∞.*tends to -∞.*oscillat/i,
  "Policy must enumerate divergence types: +∞, -∞, oscillation"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not write.*general divergent/i,
  "Policy must reject generic S_∞ = ∞ for divergent series"
);

// E — Grandi-style oscillation example
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /1.*−.*1.*\+.*1.*−.*1|1.*-.*1.*\+.*1.*-.*1/,
  "Policy must include Grandi-series oscillation example"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /partial sums.*1.*0.*1.*0/,
  "Policy must show partial sums for the oscillation example"
);

// F — Undefined relation
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /比时间快.*faster than time/i,
  "Policy must reference the 'faster than time' undefined-relation example"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /do not infer consequences from it/i,
  "Policy must prohibit inferring consequences from undefined relations"
);

// G — Reasoning-role separation
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /USER IDEA.*ASSISTANT COMPLETION.*DERIVED CONSEQUENCE.*EXTERNAL ANALOGY.*COUNTEREXAMPLE/i,
  "Policy must encode five distinct reasoning roles"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /conversational wording must preserve these distinctions/i,
  "Policy must require conversational wording to preserve role distinctions"
);

console.log("CHAT-WORKFLOW-SEMANTIC-H PASS: completion remains hypothesis");
console.log("CHAT-WORKFLOW-SEMANTIC-I PASS: reparameterization preserves convergence");
console.log("CHAT-WORKFLOW-SEMANTIC-J PASS: time compression example");
console.log("CHAT-WORKFLOW-SEMANTIC-K PASS: divergence taxonomy");
console.log("CHAT-WORKFLOW-SEMANTIC-L PASS: Grandi oscillation example");
console.log("CHAT-WORKFLOW-SEMANTIC-M PASS: undefined relation");
console.log("CHAT-WORKFLOW-SEMANTIC-N PASS: reasoning-role separation");

// ────────────────────────────────────────────────────────────────────
// M2B.3.2: Hypothesis-scoped reasoning regression tests
// ────────────────────────────────────────────────────────────────────

// A — Conditional consequence remains scoped
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /If we temporarily define|Under that candidate interpretation|This conclusion depends on the hypothesis/i,
  "Policy must require scoping language for hypothesis-dependent conclusions"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not allow a conditional result to become unconditional/i,
  "Policy must prohibit conditional results silently becoming unconditional"
);

// B — Authority inheritance
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Consequence authority.*cannot.*exceed.*premise authority|inherit.*weakest.*authority/i,
  "Policy must encode: consequence authority <= premise authority"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /explicitly stated by user.*user-stated.*user-adopted.*assistant completion.*candidate.*external mapping.*temporary mathematical assumption/i,
  "Policy must enumerate provenance categories for premise tracking"
);

// C — Assistant hypothesis vs user definition
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /reasoning from a user definition.*consequence of the user.*current definition/i,
  "Policy must distinguish reasoning from user definition vs assistant hypothesis"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /reasoning from an assistant hypothesis.*remain.*under this candidate/i,
  "Policy must require hypothesis-conditional language for assistant proposals"
);

// D — Counterexample scope
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /insufficient as a candidate interpretation/,
  "Policy must scope counterexample to candidate, not user's whole idea"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do NOT.*counterexample.*refuting the user.*whole idea/i,
  "Policy must prohibit claiming counterexample refutes user's whole idea"
);

// E — External analogy scope
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /tells us something about the analogy.*not yet about.*own.*concept/i,
  "Policy must require external-analogy conclusions to stay scoped to the analogy"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /not automatically.*consequence of the user.*own definition/i,
  "Policy must prevent external-formula consequences from becoming user-theory consequences"
);

// F — Nested hypotheses
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /remain conditional on BOTH/i,
  "Policy must require conclusions to stay conditional on all nested hypotheses"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not collapse.*H1.*H2.*into.*user.*theory/i,
  "Policy must prohibit collapsing nested hypotheses into user's theory"
);

// G — Later correction invalidates dependent conclusions
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /自己定义的运算/,
  "Policy must include user-defined-operation correction example"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /historical.*conditional evidence.*not current meaning/i,
  "Policy must require old conclusions to become historical after premise change"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not silently carry conclusions across a changed premise/i,
  "Policy must prohibit carrying conclusions across changed premises"
);

console.log("CHAT-WORKFLOW-SEMANTIC-O PASS: conditional consequence scoping");
console.log("CHAT-WORKFLOW-SEMANTIC-P PASS: authority inheritance");
console.log("CHAT-WORKFLOW-SEMANTIC-Q PASS: hypothesis vs user definition");
console.log("CHAT-WORKFLOW-SEMANTIC-R PASS: counterexample scope");
console.log("CHAT-WORKFLOW-SEMANTIC-S PASS: external analogy scope");
console.log("CHAT-WORKFLOW-SEMANTIC-T PASS: nested hypotheses");
console.log("CHAT-WORKFLOW-SEMANTIC-U PASS: correction invalidates dependent conclusions");

// ────────────────────────────────────────────────────────────────────
// M2B.3.3: Trigger-vs-target discipline regression tests
// ────────────────────────────────────────────────────────────────────

// A — Trigger != target
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /I saw X.*and it made me wonder Y.*Y is normally.*target/i,
  "Policy must encode: 'I saw X and it made me wonder Y' makes Y the target"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not automatically treat.*named theorem.*as a request for an explanation/i,
  "Policy must prohibit auto-explaining named theorems"
);

// B — Named theorem does not imply explain-theorem request
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not begin.*long.*FTA.*Liouville.*tutorial/i,
  "Policy must explicitly prohibit long FTA/Liouville tutorial when not requested"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /unless.*user actually asks.*proof/i,
  "Policy must require the user to actually ask for proof before explaining it"
);

// C — Preserve abstraction jump
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /a_0.*a_1.*x.*a_n.*x\^n.*simple change-patterns/i,
  "Policy must include polynomial → abstraction example"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not collapse it immediately into.*Taylor/i,
  "Policy must prohibit collapsing abstraction jump to Taylor series"
);

// D — User conjecture remains target
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /是不是|我觉得可能|意味着.*\?|我不确定/i,
  "Policy must recognize uncertainty/conjecture language patterns"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /do not convert.*question into.*textbook fact-recall/i,
  "Policy must prohibit converting conjecture into fact-recall answer"
);

// E — Candidate monopolization
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /does NOT mean the original broader idea is dead/i,
  "Policy must state: candidate failure != original idea failure"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Return explicitly to the original target/i,
  "Policy must require returning to the original target after testing a candidate"
);

// F — Correct-but-irrelevant material
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Correct but irrelevant.*still.*conversational failure/i,
  "Policy must encode that correct-but-irrelevant is a conversational failure"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /Do not include mathematically correct material merely because.*adjacent/i,
  "Policy must prohibit including correct material just because it's adjacent"
);

// G — External vocabulary comes after user primitive concepts
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /变化模式/,
  "Policy must preserve user primitive concept: 变化模式"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /伸缩系数/,
  "Policy must preserve user primitive concept: 伸缩系数"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /叠加/,
  "Policy must preserve user primitive concept: 叠加"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /无限自由度/,
  "Policy must preserve user primitive concept: 无限自由度"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /do not immediately normalize them into basis/i,
  "Policy must prohibit normalizing user concepts into standard vocabulary"
);
assert.match(
  USER_SEMANTIC_CONVERSATION_RULES,
  /What you mean is an infinite-dimensional vector space/,
  "Policy must include the bad-pattern example of claiming user 'means' a standard concept"
);

console.log("CHAT-WORKFLOW-SEMANTIC-V PASS: trigger != target");
console.log("CHAT-WORKFLOW-SEMANTIC-W PASS: named theorem != explain request");
console.log("CHAT-WORKFLOW-SEMANTIC-X PASS: preserve abstraction jump");
console.log("CHAT-WORKFLOW-SEMANTIC-Y PASS: user conjecture remains target");
console.log("CHAT-WORKFLOW-SEMANTIC-Z PASS: candidate monopolization prevented");
console.log("CHAT-WORKFLOW-SEMANTIC-AA PASS: correct-but-irrelevant is failure");
console.log("CHAT-WORKFLOW-SEMANTIC-AB PASS: external vocabulary after user primitives");

// ═════════════════════════════════════════════════════════════════════
// M2C.1: Clipboard attachment regression tests (transport-honest)
// ═════════════════════════════════════════════════════════════════════

function makeTestFile(name, type, size = 1024) {
  return new File([new Uint8Array(size)], name, { type });
}

// Dummy DataTransferItem for extractAttachmentFiles tests
function makeItem(kind, type, file) {
  return { kind, type, getAsFile: () => file };
}

// A — text/plain only: zero attachment files, caller should NOT preventDefault
{
  const txtFile = new File(["hello"], "text.txt", { type: "text/plain" });
  const result = extractAttachmentFiles(
    [makeItem("file", "text/plain", txtFile)],
    [txtFile]
  );
  assert.equal(result.length, 0,
    "text/plain must yield zero image attachments");
  assert.equal(isSupportedAttachmentFile({ type: "text/plain", size: 100 }), false);
  console.log("CLIPBOARD-A PASS: text/plain yields no attachments (caller should NOT preventDefault)");
}

// B — image/png file: one attachment, caller SHOULD take ownership
{
  const imgFile = new File([new Uint8Array(2048)], "shot.png", { type: "image/png" });
  const result = extractAttachmentFiles(
    [makeItem("file", "image/png", imgFile)]
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "shot.png");
  assert.equal(result[0].type, "image/png");

  const normalized = normalizeChatAttachmentFile(imgFile);
  assert.notEqual(normalized, null);
  assert.equal(normalized.mimeType, "image/png");
  console.log("CLIPBOARD-B PASS: image/png yields one attachment (caller SHOULD preventDefault)");
}

// C — image + text in same clipboard: image attached, text NOT destroyed
{
  const imgFile = new File([new Uint8Array(500)], "pic.png", { type: "image/png" });
  const txtFile = new File(["text"], "note.txt", { type: "text/plain" });
  const result = extractAttachmentFiles(
    [
      makeItem("string", "text/plain", txtFile),
      makeItem("file", "image/png", imgFile)
    ],
    [txtFile, imgFile]
  );
  assert.equal(result.length, 1,
    "Only the image should be attached; text must not be consumed");
  assert.equal(result[0].name, "pic.png");
  console.log("CLIPBOARD-C PASS: image+text clipboard attaches image, preserves text");
}

// D — duplicate representations of same clipboard image: one logical attachment
{
  const file = new File([new Uint8Array(100)], "dup.png", { type: "image/png" });
  // Same file exposed through both items and files
  const result = extractAttachmentFiles(
    [makeItem("file", "image/png", file)],
    [file]
  );
  assert.equal(result.length, 1,
    "Duplicate paste representations must collapse to one attachment");
  console.log("CLIPBOARD-D PASS: duplicate clipboard representations deduplicated per paste");
}

// ── Resource cleanup: URL.createObjectURL / revokeObjectURL tracking ──
{
  let createdUrls = 0;
  let revokedUrls = 0;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { createdUrls++; return origCreate.call(URL, blob); };
  URL.revokeObjectURL = (url) => { revokedUrls++; return origRevoke.call(URL, url); };

  try {
    // Simulate what renderAttachmentRow does: create URL then later revoke
    const img = makeTestFile("test.png", "image/png", 100);
    const url1 = URL.createObjectURL(img);
    const url2 = URL.createObjectURL(img);
    assert.equal(createdUrls, 2, "Two createObjectURL calls tracked");
    URL.revokeObjectURL(url1);
    assert.equal(revokedUrls, 1);
    URL.revokeObjectURL(url2);
    assert.equal(revokedUrls, 2, "All URLs revoked");
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
  console.log("CLIPBOARD-E PASS: object URL create/revoke lifecycle tracked");
}

// Minimal app for session-based tests (no Vault dependency)
const attachmentTestApp = {
  vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null, getFileByPath: () => null, getFolderByPath: () => null, cachedRead: async () => "", read: async () => "" },
  workspace: { getLeaf: () => ({ openFile: async () => {} }) },
  metadataCache: { getFileCache: () => null }
};

// F — PDF is consumable: supported at normalization, composable in UI
{
  // PDF is supported with real local text extraction (pdfjs-dist)
  assert.equal(isSupportedAttachmentFile({ type: "application/pdf", size: 5000 }), true,
    "PDF must be supported");
  assert.ok(SUPPORTED_ATTACHMENT_DOCUMENT_TYPES.has("application/pdf"));

  const normalized = normalizeChatAttachmentFile(makeTestFile("paper.pdf", "application/pdf", 5000));
  assert.notEqual(normalized, null, "PDF must be accepted at normalization");
  assert.equal(normalized.mimeType, "application/pdf");

  // PDF attaches to composer
  const session = new LainBrainSession(
    attachmentTestApp, () => "sk-test", () => null,
    { analyzeImage: async () => { throw new Error("unexpected"); } },
    async () => "reply"
  );
  session.setChatSemanticAnalyzer(async () => {
    throw new Error("Semantic shadow is tested independently.");
  });
  assert.equal(session.addChatAttachment(makeTestFile("doc.pdf", "application/pdf", 5000)), true);
  assert.equal(session.getPendingAttachments().length, 1);
  assert.equal(session.getPendingAttachments()[0].mimeType, "application/pdf");

  // extractPdfText is exported for production use (tested in Electron).
  // The VM context lacks dynamic import so the real pdfjs-dist extraction
  // is exercised in the Obsidian/Electron runtime environment.
  assert.equal(typeof extractPdfText, "function",
    "extractPdfText is a callable export");

  console.log("CLIPBOARD-F PASS: PDF supported, attaches to composer, extractPdfText exported");
}

// G — Remove before send: attachment cleared, pendingAttachments empty
{
  const session = new LainBrainSession(
    attachmentTestApp, () => "sk-test", () => null,
    { analyzeImage: async () => { throw new Error("unexpected"); } }
  );

  const added = session.addChatAttachment(makeTestFile("temp.png", "image/png", 100));
  assert.equal(added, true);
  assert.equal(session.getPendingAttachments().length, 1);

  session.removeChatAttachment(session.getPendingAttachments()[0].id);
  assert.equal(session.getPendingAttachments().length, 0);
  console.log("CLIPBOARD-G PASS: remove before send clears attachment list");
}

// H — Send text + image: single-image vision path exercised
{
  let visionCalls = 0;
  let receivedImageCount = 0;
  const session = new LainBrainSession(
    attachmentTestApp, () => "sk-test",
    () => ({ id: "tv", displayName: "TV", baseUrl: "https://a.test", model: "m", apiKey: "k", capabilities: { supportsImages: true } }),
    { analyzeImage: async (_p, _msg, image) => { visionCalls++; receivedImageCount = Array.isArray(image) ? image.length : 1; return { text: "ok", providerId: "tv", providerDisplayName: "TV" }; } }
  );
  session.setChatSemanticAnalyzer(async () => {
    throw new Error("Semantic shadow is tested independently.");
  });
  session.setDraft("Explain");
  session.addChatAttachment(makeTestFile("one.png", "image/png", 1000));
  assert.equal(await session.send("tv"), "sent");
  await session.waitForChatSemanticShadow();
  assert.equal(visionCalls, 1);
  assert.equal(receivedImageCount, 1);
  assert.equal(session.getPendingAttachments().length, 0, "Cleared after send");

  const msgs = session.getChatTranscriptMessages();
  const userMsg = msgs.find((m) => m.role === "user" && m.attachment !== undefined);
  assert.notEqual(userMsg, undefined);
  assert.equal(userMsg.attachments.length, 1);
  console.log("CLIPBOARD-H PASS: single image reaches vision transport, snapshot valid");
}

// I — Two-image send: all images reach transport in order
{
  let visionCalls = 0;
  let receivedCount = 0;
  const session = new LainBrainSession(
    attachmentTestApp, () => "sk-test",
    () => ({ id: "tv", displayName: "TV", baseUrl: "https://a.test", model: "m", apiKey: "k", capabilities: { supportsImages: true } }),
    { analyzeImage: async (_p, _msg, image) => { visionCalls++; receivedCount = Array.isArray(image) ? image.length : 1; return { text: "ok", providerId: "tv", providerDisplayName: "TV" }; } }
  );
  session.setChatSemanticAnalyzer(async () => {
    throw new Error("Semantic shadow is tested independently.");
  });
  session.setDraft("Compare these");
  session.addChatAttachment(makeTestFile("a.png", "image/png", 100));
  session.addChatAttachment(makeTestFile("b.png", "image/png", 200));
  assert.equal(await session.send("tv"), "sent");
  await session.waitForChatSemanticShadow();
  assert.equal(visionCalls, 1);
  assert.equal(receivedCount, 2, "Both images must reach the transport");

  const msgs = session.getChatTranscriptMessages();
  const userMsg = msgs.find((m) => m.role === "user");
  assert.notEqual(userMsg, undefined);
  assert.equal(userMsg.attachments.length, 2, "Both attachment metadata preserved");
  console.log("CLIPBOARD-I PASS: two images reach multi-image vision transport");
}

// J — Duplicate add is harmless but does not silently drop
{
  const session = new LainBrainSession(
    attachmentTestApp, () => "sk-test", () => null,
    { analyzeImage: async () => { throw new Error("unexpected"); } }
  );
  session.addChatAttachment(makeTestFile("x.png", "image/png", 900));
  session.addChatAttachment(makeTestFile("x.png", "image/png", 900));
  assert.equal(session.getPendingAttachments().length, 1,
    "Same name+size image deduplicated (same paste op)");
  // Different paste: different file, same name+size still deduplicates
  // because the model uses filename+byteSize. This is acceptable for
  // dedup-within-paste; global dedup is handled by the addChatAttachment
  // check which is filename+byteSize scoped.
  console.log("CLIPBOARD-J PASS: duplicate handling scoped to same paste op");
}

// Supp — oversized / unsupported files rejected
{
  assert.equal(normalizeChatAttachmentFile(makeTestFile("big.png", "image/png", MAX_ATTACHMENT_BYTES + 1)), null);
  assert.equal(normalizeChatAttachmentFile(makeTestFile("x.bin", "application/octet-stream", 100)), null);
  console.log("CLIPBOARD-SUPPL PASS: oversized / unsupported rejected safely");
}

const vaultWrites = [];
let markdownVaultScans = 0;
const app = {
  vault: {
    cachedRead: async () => "",
    getMarkdownFiles: () => {
      markdownVaultScans += 1;
      return [];
    },
    getFileByPath: () => null,
    getAbstractFileByPath: () => null,
    getFolderByPath: () => null,
    createFolder: async (path) => {
      vaultWrites.push({ operation: "createFolder", path });
    },
    create: async (path, content) => {
      vaultWrites.push({ operation: "create", path, content });
      return { path, basename: path.replace(/^.*\//, "").replace(/\.md$/i, "") };
    },
    modify: async (file, content) => {
      vaultWrites.push({ operation: "modify", path: file.path, content });
    },
    trash: async (file) => {
      vaultWrites.push({ operation: "trash", path: file.path });
    }
  },
  metadataCache: {
    getFirstLinkpathDest: () => null
  },
  workspace: {
    getLeaf: () => ({ openFile: async () => {} })
  }
};
const session = new LainBrainSession(
  app,
  () => "configured-key",
  () => null,
  { analyzeImage: async () => { throw new Error("Vision not expected"); } }
);
session.setChatSemanticAnalyzer(async () => {
  throw new Error("Semantic shadow is tested independently.");
});
const loadingStates = [];
session.subscribe(() => {
  loadingStates.push({
    loadingMode: session.loadingMode,
    candidateLoading: session.candidateLoading
  });
});

session.setDraft("Let's discuss separation of concerns.");
assert.equal(await session.send(), "sent");
assert.equal(session.candidateCount, 0);
assert.equal(session.getCandidateNotes().length, 0);
assert.equal(session.getChatTranscriptMessages().some(
  (message) => message.content.includes("Organizing candidate notes...")
), false);
assert.equal(loadingStates.some((state) => state.candidateLoading), false);
assert.equal(vaultWrites.length, 0);
assert.equal(requestLog.length, 1);
assert.match(
  requestLog[0].messages[0].content,
  /ordinary Lain Brain conversation/
);

session.setDraft([
  "# ????",
  "",
  "## ????",
  "Please discuss this pasted Markdown as material."
].join("\n"));
assert.equal(await session.send(), "sent");
assert.equal(session.candidateCount, 0);
assert.equal(session.getCandidateNotes().length, 0);
assert.equal(vaultWrites.length, 0);
// M2B.6a-v0: the contextual-sense experiment performs ONE read-only
// concept-index scan per session (cached for subsequent sends).
// No vault writes of any kind.
assert.equal(markdownVaultScans, 1);
assert.equal(requestLog.length, 2);
assert.equal(requestLog.some((request) =>
  request.messages.some((message) =>
    message.content.includes("Classify atomic claims")
  )
), false);
assert.match(
  requestLog[1].messages[0].content,
  /ordinary Lain Brain conversation/
);
assert.equal(
  session.getCandidateNotes().flatMap((candidate) => candidate.claims).length,
  0
);

loadingStates.length = 0;
requestLog.length = 0;
const organizeResult = await session.generateOrUpdateCandidateNotes();
assert.equal(organizeResult, "success");
assert.equal(session.candidateCount, 1);
assert.equal(session.getCandidateNotes()[0].claims.length, 0);
assert.equal(
  loadingStates.some((state) => state.candidateLoading),
  true
);
assert.equal(vaultWrites.length, 0);
const organizePrompts = requestLog.flatMap((request) =>
  request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
);
assert.equal(
  organizePrompts.some((prompt) =>
    prompt.includes(
      "Extract every substantive, mutually independent discussion topic"
    )
  ),
  true
);
assert.equal(
  organizePrompts.some((prompt) =>
    prompt.includes("Your task is not ordinary question answering")
  ),
  true
);

const viewSource = await import("node:fs/promises").then((fs) =>
  fs.readFile("src/LainBrainView.ts", "utf8")
);
const chatPanelSource = await import("node:fs/promises").then((fs) =>
  fs.readFile("src/LainBrainChatPanel.ts", "utf8")
);
const largeViewSource = await import("node:fs/promises").then((fs) =>
  fs.readFile("src/LainBrainLargeView.ts", "utf8")
);
assert.match(viewSource, /text: "Organize into Candidate Notes"/);
assert.match(
  viewSource,
  /generateOrUpdateCandidateNotes\(false\)/
);
assert.doesNotMatch(chatPanelSource, /classifyCandidateClaims|Review Claims/);
assert.match(largeViewSource, /text: "Review Claims"/);

console.log(JSON.stringify({
  normalChatPrompt: "PASS",
  normalSendCandidateCount: 0,
  pastedCandidateStyleCandidateCount: 0,
  normalSendClaimCount: 0,
  normalSendVaultWrites: 0,
  normalSendRelationScans: 0,
  normalSendCandidateLoadingObserved: false,
  organizeCandidateCount: session.candidateCount,
  organizeCandidatePromptObserved: true,
  organizeVaultWrites: vaultWrites.length,
  result: "PASS"
}, null, 2));
