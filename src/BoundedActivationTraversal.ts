import {
  activationSeedSourceKey,
  activationTargetKey,
  createActivationSeedSet,
  type ActivationSeedSet,
  type ActivationSeedSource,
  type ActivationTarget
} from "./ActivationSeed";

export type ActivationEdgeType =
  | "outgoing_link"
  | "backlink"
  | "containing_note";

export interface ActivationEdge {
  readonly type: ActivationEdgeType;
  readonly target: ActivationTarget;
}

export interface ActivationAdjacencyProvider {
  getAdjacent(
    target: Readonly<ActivationTarget>
  ): readonly ActivationEdge[];
}

export interface ActivationTraversalBudget {
  readonly maxHops: number;
  readonly hopRetention: number;
  readonly minActivation: number;
  readonly maxVisitedTargets: number;
  readonly maxExpandedTargets: number;
  readonly maxEdgesPerTarget: number;
  readonly maxReturnedTargets: number;
  readonly maxReturnedNotes: number;
  readonly maxReturnedEpisodes: number;
  readonly maxReturnedSurfaces: number;
}

export interface ActivationTraceHop {
  readonly type: ActivationEdgeType;
  readonly from: ActivationTarget;
  readonly to: ActivationTarget;
}

export interface ActivationTrace {
  readonly seedTarget: ActivationTarget;
  readonly seedSources: readonly ActivationSeedSource[];
  readonly hops: readonly ActivationTraceHop[];
}

export interface ActivationResult {
  readonly target: ActivationTarget;

  /** Current accessibility/relevance only. Never confidence or authority. */
  readonly activation: number;

  readonly depth: number;
  readonly trace: ActivationTrace;
}

export interface ActivationTraversalResult {
  readonly results: readonly ActivationResult[];
  readonly visitedTargets: number;
  readonly expandedTargets: number;
  readonly truncated: boolean;
}

export const DEFAULT_ACTIVATION_TRAVERSAL_BUDGET:
Readonly<ActivationTraversalBudget> = Object.freeze({
  maxHops: 2,
  hopRetention: 0.5,
  minActivation: 0.25,
  maxVisitedTargets: 128,
  maxExpandedTargets: 32,
  maxEdgesPerTarget: 32,
  maxReturnedTargets: 48,
  maxReturnedNotes: 24,
  maxReturnedEpisodes: 8,
  maxReturnedSurfaces: 16
});

interface TraversalRecord {
  readonly target: ActivationTarget;
  readonly targetKey: string;
  readonly activation: number;
  readonly depth: number;
  readonly trace: ActivationTrace;
  readonly traceKey: string;
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
}

function requireUnitInterval(
  name: string,
  value: number,
  allowZero: boolean
): void {
  if (
    !Number.isFinite(value) ||
    value > 1 ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    const lower = allowZero ? "0" : "greater than 0";
    throw new RangeError(`${name} must be ${lower} and at most 1.`);
  }
}

export function resolveActivationTraversalBudget(
  supplied: Readonly<Partial<ActivationTraversalBudget>> = {}
): Readonly<ActivationTraversalBudget> {
  const budget: ActivationTraversalBudget = {
    ...DEFAULT_ACTIVATION_TRAVERSAL_BUDGET,
    ...supplied
  };

  requireNonNegativeInteger("maxHops", budget.maxHops);
  requireUnitInterval("hopRetention", budget.hopRetention, false);
  requireUnitInterval("minActivation", budget.minActivation, false);
  requireNonNegativeInteger(
    "maxVisitedTargets",
    budget.maxVisitedTargets
  );
  requireNonNegativeInteger(
    "maxExpandedTargets",
    budget.maxExpandedTargets
  );
  requireNonNegativeInteger(
    "maxEdgesPerTarget",
    budget.maxEdgesPerTarget
  );
  requireNonNegativeInteger(
    "maxReturnedTargets",
    budget.maxReturnedTargets
  );
  requireNonNegativeInteger(
    "maxReturnedNotes",
    budget.maxReturnedNotes
  );
  requireNonNegativeInteger(
    "maxReturnedEpisodes",
    budget.maxReturnedEpisodes
  );
  requireNonNegativeInteger(
    "maxReturnedSurfaces",
    budget.maxReturnedSurfaces
  );

  return Object.freeze(budget);
}

function cloneTarget(target: ActivationTarget): ActivationTarget {
  switch (target.kind) {
    case "surface":
      return Object.freeze({ kind: "surface", text: target.text });
    case "vault_note":
      return Object.freeze({
        kind: "vault_note",
        vaultPath: target.vaultPath
      });
    case "vault_subpath":
      return Object.freeze({
        kind: "vault_subpath",
        vaultPath: target.vaultPath,
        subpath: target.subpath
      });
    case "semantic_episode":
      return Object.freeze({
        kind: "semantic_episode",
        episodeId: target.episodeId
      });
  }
}

function cloneSource(source: ActivationSeedSource): ActivationSeedSource {
  const provenance = source.provenance;
  let clonedProvenance: ActivationSeedSource["provenance"];

  switch (provenance.kind) {
    case "message":
      clonedProvenance = Object.freeze({
        kind: "message",
        messageId: provenance.messageId
      });
      break;
    case "vault_location":
      clonedProvenance = provenance.subpath === undefined
        ? Object.freeze({
            kind: "vault_location",
            vaultPath: provenance.vaultPath
          })
        : Object.freeze({
            kind: "vault_location",
            vaultPath: provenance.vaultPath,
            subpath: provenance.subpath
          });
      break;
    case "semantic_episode":
      clonedProvenance = Object.freeze({
        kind: "semantic_episode",
        episodeId: provenance.episodeId
      });
      break;
  }

  return Object.freeze({
    origin: source.origin,
    provenance: clonedProvenance
  });
}

function cloneSources(
  sources: readonly ActivationSeedSource[]
): readonly ActivationSeedSource[] {
  return Object.freeze(sources.map(cloneSource));
}

function traceKey(trace: ActivationTrace): string {
  return JSON.stringify([
    activationTargetKey(trace.seedTarget),
    trace.seedSources.map(activationSeedSourceKey),
    trace.hops.map((hop) => [
      hop.type,
      activationTargetKey(hop.from),
      activationTargetKey(hop.to)
    ])
  ]);
}

function cloneTrace(trace: ActivationTrace): ActivationTrace {
  return Object.freeze({
    seedTarget: cloneTarget(trace.seedTarget),
    seedSources: cloneSources(trace.seedSources),
    hops: Object.freeze(trace.hops.map((hop) => Object.freeze({
      type: hop.type,
      from: cloneTarget(hop.from),
      to: cloneTarget(hop.to)
    })))
  });
}

function createRootRecord(
  target: ActivationTarget,
  sources: readonly ActivationSeedSource[]
): TraversalRecord {
  const clonedTarget = cloneTarget(target);
  const trace: ActivationTrace = Object.freeze({
    seedTarget: cloneTarget(target),
    seedSources: cloneSources(sources),
    hops: Object.freeze([])
  });

  return Object.freeze({
    target: clonedTarget,
    targetKey: activationTargetKey(clonedTarget),
    activation: 1,
    depth: 0,
    trace,
    traceKey: traceKey(trace)
  });
}

function createPropagatedRecord(
  parent: TraversalRecord,
  edge: ActivationEdge,
  activation: number
): TraversalRecord {
  const target = cloneTarget(edge.target);
  const nextHop: ActivationTraceHop = Object.freeze({
    type: edge.type,
    from: cloneTarget(parent.target),
    to: cloneTarget(target)
  });
  const trace: ActivationTrace = Object.freeze({
    seedTarget: cloneTarget(parent.trace.seedTarget),
    seedSources: cloneSources(parent.trace.seedSources),
    hops: Object.freeze([
      ...parent.trace.hops.map((hop) => Object.freeze({
        type: hop.type,
        from: cloneTarget(hop.from),
        to: cloneTarget(hop.to)
      })),
      nextHop
    ])
  });

  return Object.freeze({
    target,
    targetKey: activationTargetKey(target),
    activation,
    depth: parent.depth + 1,
    trace,
    traceKey: traceKey(trace)
  });
}

function compareLexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFrontier(
  left: TraversalRecord,
  right: TraversalRecord
): number {
  if (left.activation !== right.activation) {
    return right.activation - left.activation;
  }
  if (left.depth !== right.depth) {
    return left.depth - right.depth;
  }
  const targetOrder = compareLexical(left.targetKey, right.targetKey);
  return targetOrder !== 0
    ? targetOrder
    : compareLexical(left.traceKey, right.traceKey);
}

function rawTargetKey(target: ActivationTarget): string {
  switch (target.kind) {
    case "surface":
      return JSON.stringify([target.kind, target.text]);
    case "vault_note":
      return JSON.stringify([target.kind, target.vaultPath]);
    case "vault_subpath":
      return JSON.stringify([
        target.kind,
        target.vaultPath,
        target.subpath
      ]);
    case "semantic_episode":
      return JSON.stringify([target.kind, target.episodeId]);
  }
}

function normalizeEdges(
  edges: readonly ActivationEdge[]
): readonly ActivationEdge[] {
  const sorted = edges.map((edge) => ({
    edge,
    identityKey: JSON.stringify([
      edge.type,
      activationTargetKey(edge.target)
    ]),
    rawKey: rawTargetKey(edge.target)
  })).sort((left, right) => {
    const identityOrder = compareLexical(
      left.identityKey,
      right.identityKey
    );
    return identityOrder !== 0
      ? identityOrder
      : compareLexical(left.rawKey, right.rawKey);
  });
  const unique: ActivationEdge[] = [];
  let lastIdentityKey: string | undefined;

  for (const item of sorted) {
    if (item.identityKey === lastIdentityKey) {
      continue;
    }
    lastIdentityKey = item.identityKey;
    unique.push(Object.freeze({
      type: item.edge.type,
      target: cloneTarget(item.edge.target)
    }));
  }

  return Object.freeze(unique);
}

function compareResults(left: TraversalRecord, right: TraversalRecord): number {
  if (left.activation !== right.activation) {
    return right.activation - left.activation;
  }
  if (left.depth !== right.depth) {
    return left.depth - right.depth;
  }
  return compareLexical(left.targetKey, right.targetKey);
}

function freezeResult(record: TraversalRecord): ActivationResult {
  return Object.freeze({
    target: cloneTarget(record.target),
    activation: record.activation,
    depth: record.depth,
    trace: cloneTrace(record.trace)
  });
}

function applyResultQuotas(
  records: readonly TraversalRecord[],
  budget: Readonly<ActivationTraversalBudget>
): { readonly results: readonly ActivationResult[]; readonly truncated: boolean } {
  const results: ActivationResult[] = [];
  let returnedNotes = 0;
  let returnedEpisodes = 0;
  let returnedSurfaces = 0;
  let truncated = false;

  for (const record of records) {
    if (results.length >= budget.maxReturnedTargets) {
      truncated = true;
      break;
    }

    switch (record.target.kind) {
      case "vault_note":
      case "vault_subpath":
        if (returnedNotes >= budget.maxReturnedNotes) {
          truncated = true;
          continue;
        }
        returnedNotes += 1;
        break;
      case "semantic_episode":
        if (returnedEpisodes >= budget.maxReturnedEpisodes) {
          truncated = true;
          continue;
        }
        returnedEpisodes += 1;
        break;
      case "surface":
        if (returnedSurfaces >= budget.maxReturnedSurfaces) {
          truncated = true;
          continue;
        }
        returnedSurfaces += 1;
        break;
    }

    results.push(freezeResult(record));
  }

  return Object.freeze({
    results: Object.freeze(results),
    truncated
  });
}

/**
 * Propagate accessibility through caller-supplied local topology only.
 * Activation is relevance, never truth, confidence, authority, or proof.
 */
export function traverseBoundedActivation(
  seedSet: Readonly<ActivationSeedSet>,
  adjacencyProvider: ActivationAdjacencyProvider,
  suppliedBudget: Readonly<Partial<ActivationTraversalBudget>> = {}
): ActivationTraversalResult {
  const budget = resolveActivationTraversalBudget(suppliedBudget);
  const normalizedSeeds = createActivationSeedSet(seedSet.seeds).seeds;
  const acceptedSeeds = normalizedSeeds.slice(0, budget.maxVisitedTargets);
  let truncated = acceptedSeeds.length < normalizedSeeds.length;
  const records = new Map<string, TraversalRecord>();
  const frontier: TraversalRecord[] = [];

  for (const seed of acceptedSeeds) {
    const record = createRootRecord(seed.target, seed.sources);
    records.set(record.targetKey, record);
    frontier.push(record);
  }

  let expandedTargets = 0;

  while (frontier.length > 0) {
    frontier.sort(compareFrontier);
    const current = frontier.shift();
    if (current === undefined) {
      break;
    }

    const latest = records.get(current.targetKey);
    if (latest !== current) {
      continue;
    }

    const nextActivation = current.activation * budget.hopRetention;
    if (
      current.depth >= budget.maxHops ||
      nextActivation < budget.minActivation
    ) {
      continue;
    }

    if (expandedTargets >= budget.maxExpandedTargets) {
      truncated = true;
      break;
    }

    const adjacent = normalizeEdges(
      adjacencyProvider.getAdjacent(cloneTarget(current.target))
    );
    expandedTargets += 1;
    if (adjacent.length > budget.maxEdgesPerTarget) {
      truncated = true;
    }

    for (const edge of adjacent.slice(0, budget.maxEdgesPerTarget)) {
      const targetKey = activationTargetKey(edge.target);
      const existing = records.get(targetKey);

      if (existing === undefined) {
        if (records.size >= budget.maxVisitedTargets) {
          truncated = true;
          continue;
        }

        const candidate = createPropagatedRecord(
          current,
          edge,
          nextActivation
        );
        records.set(targetKey, candidate);
        frontier.push(candidate);
        continue;
      }

      if (nextActivation > existing.activation) {
        const candidate = createPropagatedRecord(
          current,
          edge,
          nextActivation
        );
        records.set(targetKey, candidate);
        frontier.push(candidate);
      }
    }
  }

  const orderedRecords = [...records.values()].sort(compareResults);
  const quotaResult = applyResultQuotas(orderedRecords, budget);

  return Object.freeze({
    results: quotaResult.results,
    visitedTargets: records.size,
    expandedTargets,
    truncated: truncated || quotaResult.truncated
  });
}
