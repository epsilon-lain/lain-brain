import type { App } from "obsidian";
import { serializeConceptNodeIntoMarkdown } from "./BrainGrowthPersistence";
import { loadObsidianConceptIndex } from "./ObsidianConceptIndex";
import {
  loadConceptForMaintenance,
  persistConfirmedConceptUpdate
} from "./ObsidianConceptMaintenance";
import type { ConfirmedSemanticDelta } from "./SemanticDelta";
import {
  applySemanticPropagationPlan,
  createPendingSemanticDecision,
  resolvePendingSemanticDecision,
  planSemanticPropagation,
  type PendingSemanticDecision,
  type PropagationSkippedConcept
} from "./SemanticPropagation";
import {
  completeSemanticPropagation,
  listQueuedSemanticPropagationJobs,
  migrateSemanticDeltaState,
  recordConfirmedDelta,
  replaceSemanticPendingDecisions,
  updateSemanticPropagationJob,
  type SemanticDeltaState,
  type SemanticPropagationReport
} from "./SemanticDeltaState";
import {
  detectStructuralConflicts,
  dismissStructuralConflict,
  reconcileStructuralConflictPendingDecisions,
  reconcileStructuralConflicts
} from "./StructuralConflict";
import { replaceStructuralConflictState } from "./SemanticDeltaState";

export interface SemanticPropagationCoordinatorOptions {
  readonly maxDepth?: number;
  readonly maxConcepts?: number;
  readonly maxWritesPerJob?: number;
}

/**
 * Explicit bounded background queue. It is independent of chat/shadow queues
 * and may only execute operations produced by the pure authorization-aware
 * propagation engine.
 */
export class SemanticPropagationCoordinator {
  private state: SemanticDeltaState;
  private processing?: Promise<void>;
  private readonly maxDepth: number;
  private readonly maxConcepts: number;
  private readonly maxWritesPerJob: number;

  constructor(
    private readonly app: App,
    initialState: SemanticDeltaState | undefined,
    private readonly save: (state: SemanticDeltaState) => Promise<void>,
    options: SemanticPropagationCoordinatorOptions = {}
  ) {
    this.state = migrateSemanticDeltaState(initialState);
    this.maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 2));
    this.maxConcepts = Math.max(1, Math.floor(options.maxConcepts ?? 50));
    this.maxWritesPerJob = Math.max(
      1,
      Math.floor(options.maxWritesPerJob ?? 25)
    );
  }

  getState(): SemanticDeltaState {
    return this.state;
  }

  async recordConfirmedDelta(
    delta: Readonly<ConfirmedSemanticDelta>,
    originVaultPath: string
  ): Promise<boolean> {
    const next = recordConfirmedDelta(this.state, delta, originVaultPath);
    if (next === this.state) {
      return true;
    }
    try {
      await this.save(next);
      this.state = next;
      return true;
    } catch {
      return false;
    }
  }

  async markOriginWriteFailed(deltaId: string): Promise<void> {
    const job = this.state.jobs.find((item) => item.deltaId === deltaId);
    if (job?.status !== "awaiting_origin_write") {
      return;
    }
    await this.replaceState(updateSemanticPropagationJob(
      this.state,
      deltaId,
      "failed",
      "Origin concept update failed."
    ));
  }

  async markOriginCommittedAndEnqueue(deltaId: string): Promise<void> {
    const job = this.state.jobs.find((item) => item.deltaId === deltaId);
    if (job?.status !== "awaiting_origin_write") {
      return;
    }
    await this.replaceState(updateSemanticPropagationJob(
      this.state,
      deltaId,
      "queued"
    ));
    this.start();
  }

  resumeIncompleteJobs(): void {
    if (listQueuedSemanticPropagationJobs(this.state).length > 0) {
      this.start();
    }
  }

  async waitForIdle(): Promise<void> {
    await this.processing;
  }

  async resolveDecision(
    decisionId: string,
    status: "resolved" | "dismissed" | "superseded"
  ): Promise<void> {
    const pendingDecisions = resolvePendingSemanticDecision(
      this.state.pendingDecisions,
      decisionId,
      status
    );
    await this.replaceState(replaceSemanticPendingDecisions(
      this.state,
      pendingDecisions
    ));
  }

  async dismissStructuralConflict(
    conflictId: string,
    dismissedAt: string,
    interactionRef: string
  ): Promise<void> {
    const conflicts = dismissStructuralConflict(
      this.state.structuralConflicts,
      conflictId,
      { dismissedAt, interactionRef }
    );
    const pendingDecisions = reconcileStructuralConflictPendingDecisions(
      conflicts,
      this.state.pendingDecisions
    );
    await this.replaceState(replaceStructuralConflictState(
      this.state,
      conflicts,
      pendingDecisions
    ));
  }

  private start(): void {
    if (this.processing !== undefined) {
      return;
    }
    this.processing = this.processQueue().finally(() => {
      this.processing = undefined;
      if (listQueuedSemanticPropagationJobs(this.state).length > 0) {
        this.start();
      }
    });
  }

  private async replaceState(next: SemanticDeltaState): Promise<void> {
    if (next === this.state) {
      return;
    }
    await this.save(next);
    this.state = next;
  }

  private async processQueue(): Promise<void> {
    while (true) {
      const job = listQueuedSemanticPropagationJobs(this.state)[0];
      if (job === undefined) {
        return;
      }
      const delta = this.state.deltas.find((item) => item.id === job.deltaId);
      if (delta === undefined) {
        await this.replaceState(updateSemanticPropagationJob(
          this.state,
          job.deltaId,
          "failed",
          "Confirmed SemanticDelta is missing."
        ));
        continue;
      }
      await this.replaceState(updateSemanticPropagationJob(
        this.state,
        job.deltaId,
        "planning"
      ));
      try {
        await this.processJob(delta);
      } catch {
        await this.replaceState(updateSemanticPropagationJob(
          this.state,
          job.deltaId,
          "failed",
          "Propagation failed without modifying authoritative user meaning."
        ));
      }
    }
  }

  private async processJob(delta: ConfirmedSemanticDelta): Promise<void> {
    const discovered = await loadObsidianConceptIndex(this.app);
    const sourceMatches = discovered.records.filter(
      (record) => record.concept.id === delta.conceptId
    );
    if (
      sourceMatches.length !== 1 ||
      sourceMatches[0]!.concept.revision !== delta.resultingRevision
    ) {
      await this.replaceState(updateSemanticPropagationJob(
        this.state,
        delta.id,
        "failed",
        "Origin concept is missing, ambiguous, or at an unexpected revision."
      ));
      return;
    }
    try {
      await this.inspectStructuralConflicts(delta, discovered.index.concepts);
    } catch {
      // Diagnostics are fail-open: a valid user-authoritative update and its
      // bounded propagation are not rolled back because review metadata failed.
    }
    const plan = planSemanticPropagation(delta, discovered.index, {
      maxDepth: this.maxDepth,
      maxConcepts: this.maxConcepts
    });
    await this.replaceState(updateSemanticPropagationJob(
      this.state,
      delta.id,
      "propagating"
    ));
    const appliedAt = delta.confirmedAt;
    const application = applySemanticPropagationPlan(
      delta,
      plan,
      discovered.index.concepts,
      appliedAt
    );
    const pending: PendingSemanticDecision[] = [
      ...application.pendingDecisions
    ];
    const skipped: PropagationSkippedConcept[] = [...application.skipped];
    const failures: string[] = [];
    const revisions: SemanticPropagationReport["appliedRevisions"][number][] = [];

    for (const revision of application.revisions.slice(0, this.maxWritesPerJob)) {
      const records = discovered.records.filter(
        (record) => record.concept.id === revision.conceptId
      );
      if (records.length !== 1) {
        pending.push(this.staleDecision(
          delta,
          revision.conceptId,
          "The affected concept identity is missing or ambiguous."
        ));
        continue;
      }
      const loaded = await loadConceptForMaintenance(
        this.app,
        records[0]!.vaultPath
      );
      if (!loaded.ok ||
        loaded.persisted.conceptNode.revision !== revision.previousRevision) {
        pending.push(this.staleDecision(
          delta,
          revision.conceptId,
          "The affected concept changed before propagation could write it."
        ));
        continue;
      }
      const preparedMarkdown = serializeConceptNodeIntoMarkdown(
        loaded.markdown,
        revision.concept,
        loaded.persisted.origin
      );
      const write = await persistConfirmedConceptUpdate(this.app, {
        vaultPath: loaded.vaultPath,
        conceptId: revision.conceptId,
        expectedRevision: revision.previousRevision,
        expectedMarkdown: loaded.markdown,
        preparedMarkdown
      });
      if (!write.ok) {
        pending.push(this.staleDecision(
          delta,
          revision.conceptId,
          write.error
        ));
        failures.push(`${revision.conceptId}: ${write.error}`);
        continue;
      }
      revisions.push({
        deltaId: revision.deltaId,
        conceptId: revision.conceptId,
        previousRevision: revision.previousRevision,
        resultingRevision: revision.resultingRevision,
        operations: revision.operations
      });
    }
    if (application.revisions.length > this.maxWritesPerJob) {
      failures.push("Propagation write budget was exceeded.");
    }
    const status = failures.length > 0
      ? "failed" as const
      : pending.some((item) => item.status === "pending")
        ? "completed_with_pending_decisions" as const
        : "completed" as const;
    const report: SemanticPropagationReport = {
      deltaId: delta.id,
      status,
      plan,
      appliedRevisions: revisions,
      pendingDecisionIds: pending.map((item) => item.id),
      skipped,
      failures
    };
    await this.replaceState(completeSemanticPropagation(
      this.state,
      report,
      pending
    ));
  }

  private async inspectStructuralConflicts(
    delta: Readonly<ConfirmedSemanticDelta>,
    concepts: Parameters<typeof detectStructuralConflicts>[0]["concepts"]
  ): Promise<void> {
    const affectedConceptIds = new Set<string>([delta.conceptId]);
    for (const value of [delta.previous, delta.next]) {
      if (value.kind !== "relationships") continue;
      for (const relationship of value.relationships) {
        affectedConceptIds.add(relationship.targetConceptId);
      }
    }
    const report = detectStructuralConflicts({
      concepts,
      confirmedDeltas: this.state.deltas,
      detectedAt: delta.confirmedAt,
      affectedConceptIds: [...affectedConceptIds]
    });
    const conflicts = reconcileStructuralConflicts({
      existing: this.state.structuralConflicts,
      report,
      recordedAt: delta.confirmedAt,
      interactionRef: `semantic-delta:${delta.id}`
    });
    const pendingDecisions = reconcileStructuralConflictPendingDecisions(
      conflicts,
      this.state.pendingDecisions
    );
    await this.replaceState(replaceStructuralConflictState(
      this.state,
      conflicts,
      pendingDecisions
    ));
  }

  private staleDecision(
    delta: Readonly<ConfirmedSemanticDelta>,
    conceptId: string,
    reason: string
  ): PendingSemanticDecision {
    return createPendingSemanticDecision({
      deltaId: delta.id,
      affectedConceptIds: [conceptId],
      reason,
      evidence: [],
      candidateActions: ["replan", "dismiss"],
      createdAt: delta.confirmedAt,
      revisionContext: {}
    });
  }
}
