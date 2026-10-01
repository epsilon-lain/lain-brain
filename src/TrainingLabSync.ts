import {
  TRAINING_ROUND_MAX_BYTES, TrainingLabRepository, exportTrainingObjects,
  inspectTrainingRun, parseTrainingRound
} from "./TrainingLab";

export const TRAINING_QUEUE = "Lain Brain Training Queue";
const MAX_REQUEST_BYTES = TRAINING_ROUND_MAX_BYTES + 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_NAME = /^request-([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.json$/u;

interface QueueAdapter {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ size: number } | null>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** Only exchanges data. Never launches programs, trains weights or calls providers.
 * The external trainer opts in by creating a request in this fixed vault folder.
 * All history writes go through the same repository used by the modal. */
export class TrainingLabSync {
  private busy = false;
  constructor(private readonly adapter: QueueAdapter, private readonly repository: TrainingLabRepository) {}

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!await this.adapter.exists(TRAINING_QUEUE)) return;
      const listing = await this.adapter.list(TRAINING_QUEUE);
      let processed = 0;
      for (const path of listing.files.sort()) {
        // Ignore nested/unrelated files and partial writes.
        if (!path.startsWith(`${TRAINING_QUEUE}/`)) continue;
        const match = REQUEST_NAME.exec(path.slice(TRAINING_QUEUE.length + 1));
        if (!match) continue;
        const requestId = match[1]!;
        const reply = `${TRAINING_QUEUE}/response-${requestId}.json`;
        if (await this.adapter.exists(reply)) continue;
        await this.process(path, requestId, reply);
        if (++processed >= 4) break;
      }
    } finally { this.busy = false; }
  }

  private async process(path: string, requestId: string, reply: string): Promise<void> {
    let response: Record<string, unknown>;
    try {
      const stats = await this.adapter.stat(path);
      if (!stats || stats.size > MAX_REQUEST_BYTES) throw new Error("Training request exceeds the size limit.");
      const source = await this.adapter.read(path);
      if (new TextEncoder().encode(source).byteLength > MAX_REQUEST_BYTES) throw new Error("Training request exceeds the size limit.");
      const value: unknown = JSON.parse(source);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid training request.");
      const request = value as Record<string, unknown>;
      if (Object.keys(request).some((k) => !["schemaVersion", "kind", "requestId", "operation", "roundJson"].includes(k)) ||
          request.schemaVersion !== 1 || request.kind !== "lain-brain-training-request" || request.requestId !== requestId) {
        throw new Error("Invalid training request identity/schema.");
      }
      const header = { schemaVersion: 1, kind: "lain-brain-training-response", requestId, status: "ok" };
      if (request.operation === "probe") {
        if (request.roundJson !== undefined) throw new Error("Probe requests cannot contain a training round.");
        response = { ...header, protocol: "training-sync-v1" };
      } else if (request.operation === "import" && typeof request.roundJson === "string") {
        const round = parseTrainingRound(request.roundJson);
        if (round.kind !== "training") throw new Error("Automatic sync accepts actual training reports only.");
        let state = await this.repository.load();
        const find = () => state.rounds.find((r) => r.runId === round.runId && r.round === round.round);
        let existing = find();
        if (!existing) {
          try { state = await this.repository.importRound(request.roundJson); }
          catch (error) {
            // A modal import may have saved this round between load and import.
            state = await this.repository.load();
            if (!find()) throw error;
          }
          existing = find();
        }
        if (!existing || JSON.stringify(existing) !== JSON.stringify(round)) {
          throw new Error("Round identity already exists with different content.");
        }
        // Export exactly this boundary, even if another window imported a later round.
        const boundary = { ...state, rounds: state.rounds.filter((r) => r.runId !== round.runId || r.round <= round.round) };
        const inspected = inspectTrainingRun(boundary, round.runId);
        const checked = inspected.rounds.find((r) => r.source.round === round.round)!;
        response = { ...header, runId: round.runId, round: round.round,
          checkpointSha256: round.student.checkpointSha256, dataset: round.dataset,
          verifications: checked.verifications,
          library: JSON.parse(exportTrainingObjects(boundary, round.runId)) as unknown };
        if (new TextEncoder().encode(JSON.stringify(response)).byteLength > MAX_RESPONSE_BYTES) {
          throw new Error("Training response exceeds the size limit; archive the run before continuing.");
        }
      } else { throw new Error("Unsupported training request operation."); }
    } catch (error) {
      response = { schemaVersion: 1, kind: "lain-brain-training-response", requestId, status: "error",
        message: error instanceof Error ? error.message : String(error) };
    }
    // A partial reply is never mistaken for completed feedback by the trainer.
    const pending = `${reply}.pending`;
    await this.adapter.write(pending, JSON.stringify(response, null, 2));
    await this.adapter.rename(pending, reply);
  }
}
