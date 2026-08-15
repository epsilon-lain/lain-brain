import {
  createDefaultProviderProfiles,
  normalizeProviderProfiles
} from "./ProviderProfiles";
import type { ProviderProfile } from "./ProviderProfiles";
import {
  DEFAULT_BRAIN_DISPLAY_NAME,
  DEFAULT_USER_DISPLAY_NAME,
  resolveDisplayName,
  validateDisplayName
} from "./PersonalNaming";
import {
  deserializeFormalizationIndex,
  deserializeLeanArtifactIndex
} from "./FormalizationProtocol";
import type {
  FormalizationIndex,
  LeanArtifactIndex
} from "./FormalizationProtocol";
import {
  migrateSemanticPriorState
} from "./SemanticPrior";
import type {
  SemanticPriorState
} from "./SemanticPrior";
import {
  migrateSemanticDeltaState
} from "./SemanticDeltaState";
import type { SemanticDeltaState } from "./SemanticDeltaState";

export type LeanExecutionMode = "native" | "wsl";

export interface LainBrainSettings {
  deepSeekApiKey: string;
  imageProviderProfiles: ProviderProfile[];
  activeImageProviderId: string | null;
  userDisplayName: string;
  brainDisplayName: string;
  hasCompletedNamingOnboarding: boolean;
  formalizationIndex?: FormalizationIndex;
  leanArtifactIndex?: LeanArtifactIndex;
  semanticPriorState?: SemanticPriorState;
  semanticDeltaState?: SemanticDeltaState;
  chatSemanticDeltaAnalysisEnabled: boolean;
  leanExecutionMode: LeanExecutionMode;
  leanProjectRoot: string;
  leanExecutable: string;
  leanArgs: string[];
  leanTimeoutSeconds: number;
  wslExecutable: string;
  wslDistribution: string;
  wslProjectRoot: string;
}

export const DEFAULT_SETTINGS: LainBrainSettings = {
  deepSeekApiKey: "",
  imageProviderProfiles: createDefaultProviderProfiles(),
  activeImageProviderId: null,
  userDisplayName: DEFAULT_USER_DISPLAY_NAME,
  brainDisplayName: DEFAULT_BRAIN_DISPLAY_NAME,
  hasCompletedNamingOnboarding: false,
  chatSemanticDeltaAnalysisEnabled: true,
  leanExecutionMode: "native",
  leanProjectRoot: "",
  leanExecutable: "lake",
  leanArgs: ["env", "lean"],
  leanTimeoutSeconds: 30,
  wslExecutable: "wsl.exe",
  wslDistribution: "",
  wslProjectRoot: "/mnt/c/Users/elonl/Desktop/lain_lean"
};

export function removeCustomProviderProfile(
  settings: LainBrainSettings,
  profileId: string
): boolean {
  const index = settings.imageProviderProfiles.findIndex(
    (profile) =>
      profile.id === profileId &&
      profile.builtInKind === undefined
  );

  if (index === -1) {
    return false;
  }

  settings.imageProviderProfiles.splice(index, 1);

  if (settings.activeImageProviderId === profileId) {
    settings.activeImageProviderId = null;
  }

  return true;
}

export function migrateLainBrainSettings(
  stored: unknown
): LainBrainSettings {
  const value = typeof stored === "object" && stored !== null
    ? stored as Record<string, unknown>
    : {};
  const normalized = normalizeProviderProfiles(
    value.imageProviderProfiles,
    {
      enabled: value.openAIVisionEnabled,
      apiKey: value.openAIVisionApiKey,
      model: value.openAIVisionModel
    }
  );
  const storedActiveId = typeof value.activeImageProviderId === "string"
    ? value.activeImageProviderId
    : null;
  const requestedActiveId = storedActiveId ??
    normalized.migratedActiveProviderId;
  const activeImageProviderId = normalized.profiles.some(
    (profile) => profile.id === requestedActiveId
  )
    ? requestedActiveId
    : null;
  const userDisplayName = resolveDisplayName(
    value.userDisplayName,
    DEFAULT_USER_DISPLAY_NAME
  );
  const brainDisplayName = resolveDisplayName(
    value.brainDisplayName,
    DEFAULT_BRAIN_DISPLAY_NAME
  );
  const storedUserIsValid =
    typeof value.userDisplayName === "string" &&
    validateDisplayName(value.userDisplayName, "Your name").ok;
  const storedBrainIsValid =
    typeof value.brainDisplayName === "string" &&
    validateDisplayName(value.brainDisplayName, "Brain name").ok;

  const formalizationIndex =
    deserializeFormalizationIndex(value.formalizationIndex) ?? undefined;

  const leanArtifactIndex =
    deserializeLeanArtifactIndex(value.leanArtifactIndex) ?? undefined;

  const semanticPriorState =
    migrateSemanticPriorState(value.semanticPriorState);
  const semanticDeltaState =
    migrateSemanticDeltaState(value.semanticDeltaState);

  const leanArgs = Array.isArray(value.leanArgs) &&
    value.leanArgs.every((a: unknown) => typeof a === "string")
    ? (value.leanArgs as string[])
    : ["env", "lean"];

  return {
    deepSeekApiKey: typeof value.deepSeekApiKey === "string"
      ? value.deepSeekApiKey
      : "",
    imageProviderProfiles: normalized.profiles,
    activeImageProviderId,
    userDisplayName,
    brainDisplayName,
    hasCompletedNamingOnboarding:
      value.hasCompletedNamingOnboarding === true &&
      storedUserIsValid &&
      storedBrainIsValid,
    formalizationIndex,
    leanArtifactIndex,
    semanticPriorState,
    semanticDeltaState,
    chatSemanticDeltaAnalysisEnabled:
      value.chatSemanticDeltaAnalysisEnabled !== false,
    leanExecutionMode: value.leanExecutionMode === "wsl"
      ? "wsl"
      : "native",
    leanProjectRoot: typeof value.leanProjectRoot === "string"
      ? value.leanProjectRoot
      : "",
    leanExecutable: typeof value.leanExecutable === "string" &&
      value.leanExecutable.trim() !== ""
      ? value.leanExecutable.trim()
      : "lake",
    leanArgs,
    leanTimeoutSeconds: typeof value.leanTimeoutSeconds === "number" &&
      value.leanTimeoutSeconds >= 1 &&
      value.leanTimeoutSeconds <= 300
      ? Math.floor(value.leanTimeoutSeconds)
      : 30,
    wslExecutable: typeof value.wslExecutable === "string" &&
      value.wslExecutable.trim() !== ""
      ? value.wslExecutable.trim()
      : "wsl.exe",
    wslDistribution: typeof value.wslDistribution === "string"
      ? value.wslDistribution.trim()
      : "",
    wslProjectRoot: typeof value.wslProjectRoot === "string" &&
      value.wslProjectRoot.trim() !== ""
      ? value.wslProjectRoot.trim()
      : "/mnt/c/Users/elonl/Desktop/lain_lean"
  };
}
