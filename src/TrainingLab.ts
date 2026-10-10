/** Local training interchange. No provider requests, code execution, or personal
 * ConceptNode writes. Imported measurements and teacher opinions are reports;
 * the verifier only proves equivalence to the supplied affine reference. */
export const TRAINING_LAB_SCHEMA_VERSION = 1 as const;
export const TRAINING_ROUND_MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_MAX_BYTES = 8 * 1024 * 1024;

export type AffineExpression =
  | { readonly op: "x" }
  | { readonly op: "const"; readonly value: string }
  | { readonly op: "add"; readonly left: AffineExpression; readonly right: AffineExpression }
  | { readonly op: "scale"; readonly factor: string; readonly body: AffineExpression }
  | { readonly op: "call"; readonly objectId: string; readonly argument: AffineExpression };

export interface TrainingCandidate {
  readonly id: string;
  readonly label: string;
  readonly definition: AffineExpression;
  readonly reference: {
    readonly taskId: string;
    readonly split: "train";
    readonly definition: AffineExpression;
  };
  readonly teacher?: {
    readonly model: string;
    readonly decision: "approve" | "reject" | "uncertain";
    readonly rationale: string;
  };
}

export interface TrainingRound {
  readonly schemaVersion: 1;
  readonly kind: "training" | "instrument";
  readonly runId: string;
  readonly round: number;
  readonly recordedAt: string;
  readonly student: {
    readonly model: string;
    readonly parameterCount: number;
    readonly checkpointSha256: string;
  };
  readonly dataset: { readonly trainSha256: string; readonly evalSha256: string };
  readonly config: {
    readonly mode: "baseline" | "brain_objects" | "teacher_free";
    readonly device: string;
    readonly seed: number;
  };
  readonly measurements: {
    readonly steps: number;
    readonly trainLoss: number;
    readonly trainSeconds: number;
    readonly peakVramMb?: number;
    readonly evalAccuracy?: number;
  };
  readonly predictions: readonly {
    readonly input: string;
    readonly target: string;
    readonly prediction: string;
    readonly split: "train" | "eval";
  }[];
  readonly candidates: readonly TrainingCandidate[];
}

export interface TrainingLabState {
  readonly schemaVersion: 1;
  readonly rounds: readonly TrainingRound[];
}

export interface VerifiedTrainingObject {
  readonly id: string;
  readonly label: string;
  readonly runId: string;
  readonly round: number;
  readonly checkpointSha256: string;
  readonly definition: AffineExpression;
  readonly canonical: { readonly slope: string; readonly intercept: string };
  readonly reference: TrainingCandidate["reference"];
  readonly teacher?: TrainingCandidate["teacher"];
}

export interface CandidateVerification {
  readonly candidateId: string;
  readonly verification: "equivalent" | "different" | "invalid";
  readonly acceptance: "accepted" | "awaiting_teacher" | "rejected" | "baseline_only";
  readonly message: string;
}

export interface TrainingRunInspection {
  readonly objects: readonly VerifiedTrainingObject[];
  readonly rounds: readonly {
    readonly source: TrainingRound;
    readonly verifications: readonly CandidateVerification[];
  }[];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${name} contains unsupported fields.`);
  }
}
function text(value: unknown, name: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}
function id(value: unknown, name: string): string {
  const result = text(value, name, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(result)) {
    throw new Error(`${name} must use letters, digits, underscores or hyphens.`);
  }
  return result;
}
function number(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${name} must be finite and between 0 and ${max}.`);
  }
  return value;
}
function integer(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const result = number(value, name, max);
  if (!Number.isSafeInteger(result) || result < min) throw new Error(`${name} must be an integer >= ${min}.`);
  return result;
}
function choice<T extends string>(value: unknown, options: readonly T[], name: string): T {
  if (!options.includes(value as T)) throw new Error(`${name} must be one of ${options.join(", ")}.`);
  return value as T;
}
function hash(value: unknown, name: string): string {
  const result = text(value, name, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`${name} must be a lowercase SHA256 digest.`);
  return result;
}
function array(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array of at most ${max} items.`);
  return value;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach((child) => freeze(child));
    Object.freeze(value);
  }
  return value;
}
function parseJson(source: string, max: number): unknown {
  if (new TextEncoder().encode(source).byteLength > max) throw new Error("Training JSON exceeds the size limit.");
  return JSON.parse(source) as unknown;
}

type Rational = readonly [bigint, bigint];
function rational(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new Error("Zero denominator.");
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n;
  let b = d;
  while (b !== 0n) { const r = a % b; a = b; b = r; }
  const result: Rational = [n / a, d / a];
  if (result.some((part) => part.toString().length > 4096)) throw new Error("Rational arithmetic size limit exceeded.");
  return result;
}
function parseRational(value: unknown, max = 128): Rational {
  const source = text(value, "rational", max);
  if (!/^-?\d+(\/\d+)?$/u.test(source)) throw new Error("Rationals must be integer or numerator/denominator strings.");
  const [n, d] = source.split("/");
  return rational(BigInt(n!), BigInt(d ?? "1"));
}
function format(value: Rational): string {
  return value[1] === 1n ? String(value[0]) : `${value[0]}/${value[1]}`;
}
function add(a: Rational, b: Rational): Rational { return rational(a[0] * b[1] + b[0] * a[1], a[1] * b[1]); }
function multiply(a: Rational, b: Rational): Rational { return rational(a[0] * b[0], a[1] * b[1]); }

function expression(value: unknown, allowCalls: boolean, depth = 0, budget = { nodes: 0 }): AffineExpression {
  if (depth > 24 || ++budget.nodes > 128) throw new Error("Expression exceeds depth/node limits.");
  const item = record(value, "expression");
  const child = (v: unknown): AffineExpression => expression(v, allowCalls, depth + 1, budget);
  switch (item.op) {
    case "x": keys(item, ["op"], "x"); return { op: "x" };
    case "const":
      keys(item, ["op", "value"], "const");
      return { op: "const", value: format(parseRational(item.value)) };
    case "add":
      keys(item, ["op", "left", "right"], "add");
      return { op: "add", left: child(item.left), right: child(item.right) };
    case "scale":
      keys(item, ["op", "factor", "body"], "scale");
      return { op: "scale", factor: format(parseRational(item.factor)), body: child(item.body) };
    case "call":
      if (!allowCalls) throw new Error("Reference definitions must be independent and contain no object calls.");
      keys(item, ["op", "objectId", "argument"], "call");
      return { op: "call", objectId: id(item.objectId, "objectId"), argument: child(item.argument) };
    default: throw new Error("Unsupported expression operation.");
  }
}

function candidate(value: unknown): TrainingCandidate {
  const item = record(value, "candidate");
  keys(item, ["id", "label", "definition", "reference", "teacher"], "candidate");
  const ref = record(item.reference, "reference");
  keys(ref, ["taskId", "split", "definition"], "reference");
  let teacher: TrainingCandidate["teacher"];
  if (item.teacher !== undefined) {
    const review = record(item.teacher, "teacher");
    keys(review, ["model", "decision", "rationale"], "teacher");
    teacher = {
      model: text(review.model, "teacher model", 160),
      decision: choice(review.decision, ["approve", "reject", "uncertain"], "teacher decision"),
      rationale: text(review.rationale, "teacher rationale")
    };
  }
  return {
    id: id(item.id, "candidate id"), label: text(item.label, "label", 160),
    definition: expression(item.definition, true),
    reference: {
      taskId: id(ref.taskId, "taskId"),
      split: choice(ref.split, ["train"], "reference split"),
      definition: expression(ref.definition, false)
    },
    ...(teacher ? { teacher } : {})
  };
}

export function normalizeTrainingRound(value: unknown): TrainingRound {
  const item = record(value, "round");
  keys(item, ["schemaVersion", "kind", "runId", "round", "recordedAt", "student", "dataset", "config", "measurements", "predictions", "candidates"], "round");
  if (item.schemaVersion !== 1) throw new Error("Unsupported training round schemaVersion.");
  const recordedAt = text(item.recordedAt, "recordedAt", 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(recordedAt) ||
      !Number.isFinite(Date.parse(recordedAt)) || new Date(recordedAt).toISOString() !== recordedAt) {
    throw new Error("recordedAt must be a canonical ISO UTC timestamp.");
  }
  const student = record(item.student, "student");
  keys(student, ["model", "parameterCount", "checkpointSha256"], "student");
  const dataset = record(item.dataset, "dataset");
  keys(dataset, ["trainSha256", "evalSha256"], "dataset");
  const trainSha256 = hash(dataset.trainSha256, "trainSha256");
  const evalSha256 = hash(dataset.evalSha256, "evalSha256");
  if (trainSha256 === evalSha256) throw new Error("Training and evaluation snapshots must differ.");
  const config = record(item.config, "config");
  keys(config, ["mode", "device", "seed"], "config");
  const m = record(item.measurements, "measurements");
  keys(m, ["steps", "trainLoss", "trainSeconds", "peakVramMb", "evalAccuracy"], "measurements");
  const predictions = array(item.predictions, "predictions", 32).map((v) => {
    const p = record(v, "prediction");
    keys(p, ["input", "target", "prediction", "split"], "prediction");
    // Empty model output is a valid failed prediction and must remain visible.
    if (typeof p.prediction !== "string" || p.prediction.length > 4000) throw new Error("Invalid prediction text.");
    return {
      input: text(p.input, "input"), target: text(p.target, "target"),
      prediction: p.prediction, split: choice(p.split, ["train", "eval"], "prediction split")
    };
  });
  const candidates = array(item.candidates, "candidates", 16).map(candidate);
  if (new Set(candidates.map((c) => c.id)).size !== candidates.length) throw new Error("Duplicate candidate IDs.");
  return freeze({
    schemaVersion: 1, kind: choice(item.kind, ["training", "instrument"], "kind"),
    runId: id(item.runId, "runId"), round: integer(item.round, "round", 1), recordedAt,
    student: {
      model: text(student.model, "student model", 160),
      parameterCount: integer(student.parameterCount, "parameterCount", 1, 100_000_000),
      checkpointSha256: hash(student.checkpointSha256, "checkpointSha256")
    },
    dataset: { trainSha256, evalSha256 },
    config: {
      mode: choice(config.mode, ["baseline", "brain_objects", "teacher_free"], "mode"),
      device: text(config.device, "device", 160), seed: integer(config.seed, "seed", 0)
    },
    measurements: {
      steps: integer(m.steps, "steps", 1), trainLoss: number(m.trainLoss, "trainLoss"),
      trainSeconds: number(m.trainSeconds, "trainSeconds"),
      ...(m.peakVramMb === undefined ? {} : { peakVramMb: number(m.peakVramMb, "peakVramMb") }),
      ...(m.evalAccuracy === undefined ? {} : { evalAccuracy: number(m.evalAccuracy, "evalAccuracy", 1) })
    }, predictions, candidates
  });
}

export function parseTrainingRound(source: string): TrainingRound {
  return normalizeTrainingRound(parseJson(source, TRAINING_ROUND_MAX_BYTES));
}
export function emptyTrainingLab(): TrainingLabState { return freeze({ schemaVersion: 1, rounds: [] }); }

export function appendTrainingRound(state: TrainingLabState, input: TrainingRound): TrainingLabState {
  const round = normalizeTrainingRound(input);
  if (state.rounds.length >= 128) throw new Error("Training history limit reached (128 rounds). Export and archive before starting another history.");
  const previousRounds = state.rounds.filter((r) => r.runId === round.runId);
  const previous = previousRounds[previousRounds.length - 1];
  if (round.round !== (previous?.round ?? 0) + 1) throw new Error("Rounds must be imported once, consecutively, beginning at 1.");
  if (previous !== undefined) {
    if (previous.kind !== round.kind || previous.student.model !== round.student.model || previous.student.parameterCount !== round.student.parameterCount ||
        JSON.stringify(previous.dataset) !== JSON.stringify(round.dataset) ||
        JSON.stringify(previous.config) !== JSON.stringify(round.config)) {
      throw new Error("Model, dataset snapshots and experiment config must stay fixed within a run. Use a new runId.");
    }
    if (round.measurements.steps <= previous.measurements.steps) throw new Error("Cumulative training steps must increase.");
    if (round.recordedAt < previous.recordedAt) throw new Error("Round timestamps must not move backwards.");
  }
  const used = new Set(previousRounds.flatMap((r) => r.candidates.map((c) => c.id)));
  if (round.candidates.some((c) => used.has(c.id))) throw new Error("Object IDs are immutable within a run; use a new ID for a revision.");
  const result = freeze({ schemaVersion: 1 as const, rounds: [...state.rounds, round] });
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > HISTORY_MAX_BYTES) throw new Error("Training history exceeds 8 MiB.");
  return result;
}

export function parseTrainingLabState(source: string): TrainingLabState {
  const item = record(parseJson(source, HISTORY_MAX_BYTES), "training history");
  keys(item, ["schemaVersion", "rounds"], "training history");
  if (item.schemaVersion !== 1) throw new Error("Unsupported training history version.");
  return array(item.rounds, "rounds", 128).reduce<TrainingLabState>(
    (state, round) => appendTrainingRound(state, normalizeTrainingRound(round)), emptyTrainingLab()
  );
}

type Affine = readonly [Rational, Rational];
function canonical(expr: AffineExpression, objects: ReadonlyMap<string, VerifiedTrainingObject>): Affine {
  switch (expr.op) {
    case "x": return [[1n, 1n], [0n, 1n]];
    case "const": return [[0n, 1n], parseRational(expr.value)];
    case "scale": {
      const [a, b] = canonical(expr.body, objects);
      const factor = parseRational(expr.factor);
      return [multiply(factor, a), multiply(factor, b)];
    }
    case "add": {
      const [a, b] = canonical(expr.left, objects);
      const [c, d] = canonical(expr.right, objects);
      return [add(a, c), add(b, d)];
    }
    case "call": {
      const object = objects.get(expr.objectId);
      if (object === undefined) throw new Error(`Object ${expr.objectId} is not an accepted object from an earlier round in this run.`);
      const [a, b] = canonical(expr.argument, objects);
      const slope = parseRational(object.canonical.slope, 8194);
      return [multiply(slope, a), add(multiply(slope, b), parseRational(object.canonical.intercept, 8194))];
    }
  }
}

export function inspectTrainingRun(state: TrainingLabState, runId: string): TrainingRunInspection {
  const objects = new Map<string, VerifiedTrainingObject>();
  const rounds: TrainingRunInspection["rounds"][number][] = [];
  for (const source of state.rounds.filter((r) => r.runId === runId)) {
    const accepted: VerifiedTrainingObject[] = [];
    const verifications = source.candidates.map((c): CandidateVerification => {
      try {
        const [a, b] = canonical(c.definition, objects);
        const [expectedA, expectedB] = canonical(c.reference.definition, new Map());
        if (format(a) !== format(expectedA) || format(b) !== format(expectedB)) {
          return { candidateId: c.id, verification: "different", acceptance: "rejected", message: "Definition differs from the supplied training reference over rational x." };
        }
        const acceptance = source.config.mode === "baseline" ? "baseline_only" :
          source.config.mode === "teacher_free" ? "accepted" :
          c.teacher?.decision === "approve" ? "accepted" :
          c.teacher?.decision === "reject" ? "rejected" : "awaiting_teacher";
        if (acceptance === "accepted") {
          accepted.push(freeze({
            id: c.id, label: c.label, runId, round: source.round,
            checkpointSha256: source.student.checkpointSha256,
            definition: c.definition, canonical: { slope: format(a), intercept: format(b) },
            reference: c.reference, ...(c.teacher ? { teacher: c.teacher } : {})
          }));
        }
        return { candidateId: c.id, verification: "equivalent", acceptance,
          message: "Exact affine equivalence to the supplied reference for all rational x; this does not verify the reference's truth or natural-language meaning." };
      } catch (error) {
        return { candidateId: c.id, verification: "invalid", acceptance: "rejected",
          message: error instanceof Error ? error.message : String(error) };
      }
    });
    // Same-round, forward, cyclic, rejected and cross-run dependencies cannot enter the library.
    for (const object of accepted) objects.set(object.id, object);
    rounds.push({ source, verifications });
  }
  return freeze({ objects: [...objects.values()], rounds });
}

export function exportTrainingObjects(state: TrainingLabState, runId: string): string {
  const inspected = inspectTrainingRun(state, id(runId, "runId"));
  if (!inspected.rounds.length) throw new Error("Unknown training run.");
  return JSON.stringify({
    schemaVersion: 1, kind: "lain-brain-training-objects", domain: "rational-affine-v1",
    sourceKind: inspected.rounds[0]!.source.kind,
    runId, throughRound: inspected.rounds[inspected.rounds.length - 1]!.source.round,
    dataset: inspected.rounds[0]!.source.dataset,
    objects: inspected.objects,
    authority: "experimental-only; equivalence-to-supplied-reference; not personal meaning"
  }, null, 2);
}

/** A serial transaction boundary shared by every open lab window. Reload from
 * durable storage before each operation; failed persistence never reports success. */
export class TrainingLabRepository {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: {
    read(): Promise<string | null>;
    write(source: string): Promise<void>;
  }) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work);
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async read(): Promise<TrainingLabState> {
    const source = await this.storage.read();
    return source === null ? emptyTrainingLab() : parseTrainingLabState(source);
  }
  load(): Promise<TrainingLabState> { return this.serial(() => this.read()); }
  importRound(source: string): Promise<TrainingLabState> {
    return this.serial(async () => {
      const round = parseTrainingRound(source);
      const state = appendTrainingRound(await this.read(), round);
      await this.storage.write(JSON.stringify(state));
      return state;
    });
  }
}
