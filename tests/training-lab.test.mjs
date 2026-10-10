import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import esbuild from "esbuild";

const built = await esbuild.build({
  stdin: { contents: 'export * from "./src/TrainingLab"; export * from "./src/TrainingLabModal"; export { TFolder as TestFolder } from "obsidian";',
    resolveDir: process.cwd(), sourcefile: "training-lab-test.ts", loader: "ts" },
  bundle: true, platform: "node", format: "cjs", target: "es2021", write: false,
  plugins: [{ name: "obsidian-shim", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "shim" }));
    build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ loader: "js", contents: `
      export class Modal {
        constructor(app) { this.app = app; this.contentEl = globalThis.makeElement("div"); }
        setTitle(title) { this.title = title; }
      }
      export class Notice { constructor(message) { globalThis.notices.push(message); } }
      export class TFolder {}
    ` }));
  } }]
});
function makeElement(tag, options = {}) {
  return {
    tag, text: options.text ?? "", value: options.value ?? "", style: {}, disabled: false,
    children: [], events: {}, attributes: {},
    createEl(childTag, childOptions) {
      const child = makeElement(childTag, childOptions); this.children.push(child); return child;
    },
    createDiv() { return this.createEl("div"); },
    empty() { this.children = []; },
    setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener(k, action) { this.events[k] = action; }
  };
}
const module = { exports: {} };
const notices = [];
vm.runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports, TextEncoder, console, makeElement, notices
});
const api = module.exports;
const clone = (v) => JSON.parse(JSON.stringify(v));
const x = { op: "x" };
const constant = (value) => ({ op: "const", value });
const plus = (left, right) => ({ op: "add", left, right });
const scale = (factor, body) => ({ op: "scale", factor, body });
const call = (objectId, argument = x) => ({ op: "call", objectId, argument });
const affine = plus(scale("2", x), constant("1"));
const review = { model: "local-teacher", decision: "approve", rationale: "Reported teacher opinion." };
const candidate = (id, definition = affine, reference = affine, teacher = review) => ({
  id, label: id, definition,
  reference: { taskId: "task-1", split: "train", definition: reference },
  ...(teacher ? { teacher } : {})
});
const round = (n = 1, candidates = [candidate("f")], changes = {}) => ({
  schemaVersion: 1, kind: "instrument", runId: "test-run", round: n,
  recordedAt: `2026-10-01T00:${String(n).padStart(2, "0")}:00.000Z`,
  student: { model: "test-student", parameterCount: 1_000_000, checkpointSha256: String(n).repeat(64) },
  dataset: { trainSha256: "a".repeat(64), evalSha256: "b".repeat(64) },
  config: { mode: "brain_objects", device: "synthetic-test", seed: 7 },
  measurements: { steps: n * 10, trainLoss: 1 / n, trainSeconds: 1 },
  predictions: [{ input: "x=1", target: "3", prediction: "", split: "eval" }],
  candidates, ...changes
});
const importRound = (state, value) => api.appendTrainingRound(state, api.parseTrainingRound(JSON.stringify(value)));
const inspected = (state, runId = "test-run") => api.inspectTrainingRun(state, runId);

// Two rounds, an alternative representation, object composition, reload, and export.
let state = importRound(api.emptyTrainingLab(), round(1, [candidate("f", plus(x, plus(x, constant("2/2"))))]));
assert.equal(inspected(state).objects.length, 1);
assert.equal(inspected(state).objects[0].canonical.slope, "2");
assert.equal(state.rounds[0].predictions[0].prediction, "");
assert.ok(Object.isFrozen(state.rounds[0].candidates[0].definition));
state = importRound(state, round(2, [candidate("g", call("f", call("f")), plus(scale("4", x), constant("3")))]));
const reloaded = api.parseTrainingLabState(JSON.stringify(state));
assert.deepEqual(clone(reloaded), clone(state));
const exported = JSON.parse(api.exportTrainingObjects(reloaded, "test-run"));
assert.equal(exported.objects.length, 2);
assert.deepEqual(exported.objects[1].canonical, { slope: "4", intercept: "3" });
assert.equal(exported.sourceKind, "instrument");
assert.equal(exported.throughRound, 2);
assert.ok(!("predictions" in exported)); // No evaluation examples fed back to the trainer.
assert.throws(() => api.exportTrainingObjects(state, "other-run"), /Unknown/);
let fixtureState = api.emptyTrainingLab();
for (const name of ["round-01.instrument.json", "round-02.instrument.json"]) {
  fixtureState = api.appendTrainingRound(fixtureState,
    api.parseTrainingRound(await readFile(`examples/training-lab/${name}`, "utf8")));
}
const fixtureExport = JSON.parse(api.exportTrainingObjects(fixtureState, "example-affine"));
assert.equal(fixtureExport.objects.length, 2);
assert.deepEqual(fixtureExport.objects[1].canonical, { slope: "4", intercept: "3" });

// Independent interpreter for the exported executable definitions.
function evaluate(expr, input, library) {
  switch (expr.op) {
    case "x": return input;
    case "const": { const [n, d = "1"] = expr.value.split("/"); return Number(n) / Number(d); }
    case "add": return evaluate(expr.left, input, library) + evaluate(expr.right, input, library);
    case "scale": { const [n, d = "1"] = expr.factor.split("/"); return Number(n) / Number(d) * evaluate(expr.body, input, library); }
    case "call": return evaluate(library.get(expr.objectId).definition, evaluate(expr.argument, input, library), library);
    default: throw new Error("Unknown operation");
  }
}
const library = new Map(exported.objects.map((o) => [o.id, o]));
for (let i = -20; i <= 20; i++) assert.equal(evaluate(library.get("g").definition, i / 2, library), 4 * (i / 2) + 3);

// Teacher approval is insufficient: wrong definitions, dangling/cyclic/forward
// references, same-round references, and cross-run references never become objects.
const negative = importRound(api.emptyTrainingLab(), round(1, [
  candidate("wrong", plus(scale("2", x), constant("2"))),
  candidate("self", call("self")), candidate("unknown", call("missing")),
  candidate("first", call("later")), candidate("later"),
  candidate("same-round", call("later")),
  candidate("disputed", affine, affine, { ...review, decision: "reject" }),
  candidate("pending", affine, affine, null),
  candidate("uncertain", affine, affine, { ...review, decision: "uncertain" })
]));
const pendingInput = round(1, [candidate("pending")]); delete pendingInput.candidates[0].teacher;
assert.equal(inspected(importRound(api.emptyTrainingLab(), pendingInput)).objects.length, 0);
const negativeResults = inspected(negative);
assert.deepEqual(clone(negativeResults.rounds[0].verifications.slice(0, 6).map((v) => v.verification)),
  ["different", "invalid", "invalid", "invalid", "equivalent", "invalid"]);
assert.ok(!negativeResults.objects.some((o) => ["wrong", "disputed", "uncertain"].includes(o.id)));
const crossRun = importRound(state, round(1, [candidate("cross", call("f"))], { runId: "new-run" }));
assert.equal(inspected(crossRun, "new-run").objects.length, 0);

// Teacher-free mode still checks mathematics; baseline doesn't export a library.
const teacherFree = round(1, [candidate("f")], { config: { mode: "teacher_free", device: "cpu", seed: 0 } });
delete teacherFree.candidates[0].teacher;
assert.equal(inspected(importRound(api.emptyTrainingLab(), teacherFree)).objects.length, 1);
assert.equal(inspected(importRound(api.emptyTrainingLab(), round(1, [candidate("f")], {
  config: { mode: "baseline", device: "cpu", seed: 0 }
}))).objects.length, 0);

// Exact arithmetic catches differences invisible in JavaScript floating point.
const exact = round(1, [candidate("huge", constant("9007199254740993"), constant("9007199254740992"))]);
assert.equal(inspected(importRound(api.emptyTrainingLab(), exact)).rounds[0].verifications[0].verification, "different");
const fractions = round(1, [candidate("fraction", plus(scale("1/3", x), scale("2/3", x)), x)]);
assert.equal(inspected(importRound(api.emptyTrainingLab(), fractions)).objects.length, 1);

// Input and snapshot integrity: no arbitrary code, forged statuses, eval-derived
// references, unstable IDs/config, duplicate/reordered rounds or NaN measurements.
for (const mutate of [
  (r) => { r.schemaVersion = 2; },
  (r) => { r.kind = "real-maybe"; },
  (r) => { r.student.checkpointSha256 = "not-a-hash"; },
  (r) => { r.dataset.evalSha256 = r.dataset.trainSha256; },
  (r) => { r.measurements.trainLoss = null; },
  (r) => { r.measurements.evalAccuracy = 1.1; },
  (r) => { r.candidates[0].status = "verified"; },
  (r) => { r.candidates[0].reference.split = "eval"; },
  (r) => { r.candidates[0].reference.definition = call("f"); },
  (r) => { r.candidates[0].definition = { op: "python", code: "print('unsafe')" }; },
  (r) => { r.candidates[0].definition = constant("1/0"); },
  (r) => { r.candidates[0].definition = constant("1e100"); },
  (r) => { r.runId = "../personal-note"; },
  (r) => { r.recordedAt = "2026-02-30T00:00:00.000Z"; },
  (r) => { for (let i = 0; i < 30; i++) r.candidates[0].definition = scale("1", r.candidates[0].definition); }
]) {
  const malformed = round(); mutate(malformed);
  assert.throws(() => api.parseTrainingRound(JSON.stringify(malformed)));
}
assert.throws(() => api.parseTrainingRound(" ".repeat(api.TRAINING_ROUND_MAX_BYTES + 1)), /size/);
assert.throws(() => api.normalizeTrainingRound({ ...round(), measurements: { ...round().measurements, trainLoss: NaN } }));
assert.throws(() => importRound(state, round(2)), /consecutively/);
assert.throws(() => importRound(state, round(4)), /consecutively/);
assert.throws(() => importRound(state, round(3, [candidate("f")])), /immutable/);
assert.throws(() => importRound(state, round(3, [], { dataset: { trainSha256: "c".repeat(64), evalSha256: "b".repeat(64) } })), /fixed/);
assert.throws(() => importRound(state, round(3, [], { measurements: { steps: 20, trainLoss: 1, trainSeconds: 1 } })), /increase/);
assert.throws(() => importRound(state, round(3, [], { kind: "training" })), /fixed/);

// Reload recomputes local verification; no stored status is trusted.
const tampered = clone(state); tampered.rounds[0].candidates[0].definition = constant("99");
const recomputed = inspected(api.parseTrainingLabState(JSON.stringify(tampered)));
assert.equal(recomputed.objects.length, 0); // dependent g is rejected as well.

// Durable storage: concurrent windows serialize; failed writes don't advance a
// round, and corrupt history is never silently replaced by an empty history.
let persisted = null; let writes = 0; let failWrite = false;
const repository = new api.TrainingLabRepository({
  read: async () => persisted,
  write: async (source) => { if (failWrite) throw new Error("disk full"); persisted = source; writes++; }
});
const concurrent = await Promise.allSettled([
  repository.importRound(JSON.stringify(round())), repository.importRound(JSON.stringify(round()))
]);
assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
assert.equal(writes, 1);
failWrite = true;
await assert.rejects(repository.importRound(JSON.stringify(round(2, []))), /disk full/);
assert.equal((await repository.load()).rounds.length, 1);
failWrite = false;
await repository.importRound(JSON.stringify(round(2, [])));
assert.equal((await repository.load()).rounds.length, 2);
persisted = "corrupt";
await assert.rejects(repository.importRound(JSON.stringify(round(3, []))));
assert.equal(persisted, "corrupt");

// Obsidian-facing UI integration: local import, visibility, object/history
// exports, and restart. The only writes go to lab storage or NEW export JSON.
let uiPersisted = null;
const uiRepository = new api.TrainingLabRepository({
  read: async () => uiPersisted, write: async (source) => { uiPersisted = source; }
});
const files = new Map(); let folder = false;
const app = { vault: {
  getAbstractFileByPath: (path) => path === "Lain Brain Training Exports" ? (folder ? files.get(path) : null) : files.get(path) ?? null,
  createFolder: async (path) => {
    folder = true;
    files.set(path, new api.TestFolder());
  },
  create: async (path, source) => { assert.ok(!files.has(path)); files.set(path, source); }
} };
const flatten = (node) => [node, ...node.children.flatMap(flatten)];
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
const click = async (modal, label) => {
  const button = flatten(modal.contentEl).find((e) => e.tag === "button" && e.text === label);
  assert.ok(button, label); assert.equal(button.disabled, false, label); button.events.click(); await flush();
};
const modal = new api.TrainingLabModal(app, uiRepository);
modal.onOpen(); await flush();
await click(modal, "载入合成示例");
assert.equal(uiPersisted, null); // Loading a sample doesn't mutate history.
await click(modal, "导入并验证这一轮");
assert.equal(JSON.parse(uiPersisted).rounds[0].kind, "instrument");
assert.ok(flatten(modal.contentEl).some((e) => e.text.includes("合成仪器测试")));
await click(modal, "导出对象库供下一轮训练");
const objectExport = [...files.entries()].find(([path]) => path.includes("objects-example-affine"));
assert.equal(JSON.parse(objectExport[1]).objects.length, 1);
await click(modal, "导出完整历史备份");
assert.ok([...files.keys()].some((path) => path.includes("training-history")));
const restarted = new api.TrainingLabModal(app, uiRepository);
restarted.onOpen(); await flush();
assert.ok(flatten(restarted.contentEl).some((e) => e.text === "1 轮 · 1 个已接纳实验对象"));
const writesBeforeDuplicate = uiPersisted;
await click(restarted, "载入合成示例");
await click(restarted, "导入并验证这一轮");
assert.equal(uiPersisted, writesBeforeDuplicate);
assert.ok(flatten(restarted.contentEl).some((e) => e.text.includes("consecutively")));
assert.ok(notices.length >= 2);
files.set("Lain Brain Training Exports", "pre-existing-user-file");
await click(restarted, "导出对象库供下一轮训练");
assert.equal(files.get("Lain Brain Training Exports"), "pre-existing-user-file");
assert.ok(flatten(restarted.contentEl).some((e) => e.text.includes("同名文件")));
console.log("Training Lab: protocol, exact verification, round replay, storage and modal integration passed.");
