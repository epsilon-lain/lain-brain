import {
  createActivationSeedSet,
  createSemanticPriorEpisodeSeed,
  type ActivationSeedSet
} from "./ActivationSeed";
import type { SemanticPriorEpisode } from "./SemanticPrior";

/**
 * Bridge caller-selected semantic prior episodes into activation targets.
 * This helper performs no retrieval, ranking, weighting, or episode mutation.
 */
export function createSemanticPriorEpisodeSeedSet(
  episodes: readonly Readonly<SemanticPriorEpisode>[]
): ActivationSeedSet {
  return createActivationSeedSet(
    episodes.map(createSemanticPriorEpisodeSeed)
  );
}
