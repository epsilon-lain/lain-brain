import type { App } from "obsidian";

import {
  createCurrentUtteranceSeed,
  type ActivationSeed
} from "./ActivationSeed";
import {
  materializeActivatedContext,
  type ActivatedContextBudget,
  type ActivatedContextBundle
} from "./ActivatedContextMaterialization";
import {
  createActivatedContextPromptSection,
  type ActivatedContextPromptOptions,
  type ActivatedContextPromptSection
} from "./ActivatedContextPromptAdapter";
import type {
  ActivationTraversalBudget,
  ActivationTraversalResult
} from "./BoundedActivationTraversal";
import { createObsidianActivatedContextResolver } from
  "./ObsidianActivatedContextResolver";
import { traverseObsidianActivation } from
  "./ObsidianActivationAdjacency";
import { createSemanticPriorActivatedContextResolver } from
  "./SemanticPriorActivatedContextResolver";
import { createSemanticPriorEpisodeSeedSet } from
  "./SemanticPriorActivationBridge";
import type { SemanticPriorEpisode } from "./SemanticPrior";

export interface ForegroundActivatedContextOptions {
  readonly app: App;
  readonly currentUtterance: {
    readonly text: string;
    readonly messageId: string;
  };
  /** Exact episodes already selected by the established retrieval path. */
  readonly selectedSemanticPriorEpisodes?:
    readonly Readonly<SemanticPriorEpisode>[];
  readonly traversalBudget?:
    Readonly<Partial<ActivationTraversalBudget>>;
  readonly materializationBudget?:
    Readonly<Partial<ActivatedContextBudget>>;
  readonly promptOptions?: Readonly<ActivatedContextPromptOptions>;
}

export interface ForegroundActivatedContext {
  readonly traversal: ActivationTraversalResult;
  readonly contextBundle: ActivatedContextBundle;
  readonly promptSection: ActivatedContextPromptSection;
}

/**
 * Compose the frozen activation stages for one normal foreground request.
 * Episode selection remains upstream; this function performs no retrieval,
 * LLM call, persistence, logging, or Vault mutation.
 */
export async function prepareForegroundActivatedContext(
  options: Readonly<ForegroundActivatedContextOptions>
): Promise<ForegroundActivatedContext> {
  const episodes = options.selectedSemanticPriorEpisodes ?? [];
  const episodeById = new Map<string, Readonly<SemanticPriorEpisode>>();
  for (const episode of episodes) {
    if (!episodeById.has(episode.id)) {
      episodeById.set(episode.id, episode);
    }
  }

  const extraSeeds: ActivationSeed[] = [];
  const utteranceSeed = createCurrentUtteranceSeed(
    options.currentUtterance.text,
    options.currentUtterance.messageId
  );
  if (utteranceSeed !== undefined) {
    extraSeeds.push(utteranceSeed);
  }
  extraSeeds.push(
    ...createSemanticPriorEpisodeSeedSet(episodes).seeds
  );

  const traversal = traverseObsidianActivation(options.app, {
    extraSeeds,
    ...(options.traversalBudget === undefined
      ? {} : { budget: options.traversalBudget })
  });
  const contextBundle = await materializeActivatedContext(
    traversal,
    {
      vault: createObsidianActivatedContextResolver(options.app),
      semanticEpisode: createSemanticPriorActivatedContextResolver(
        (episodeId) => episodeById.get(episodeId)
      )
    },
    options.materializationBudget ?? {}
  );
  const promptSection = createActivatedContextPromptSection(
    contextBundle,
    options.promptOptions ?? {}
  );

  return Object.freeze({ traversal, contextBundle, promptSection });
}
