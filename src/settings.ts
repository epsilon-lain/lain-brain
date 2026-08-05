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

export interface LainBrainSettings {
  deepSeekApiKey: string;
  imageProviderProfiles: ProviderProfile[];
  activeImageProviderId: string | null;
  userDisplayName: string;
  brainDisplayName: string;
  hasCompletedNamingOnboarding: boolean;
}

export const DEFAULT_SETTINGS: LainBrainSettings = {
  deepSeekApiKey: "",
  imageProviderProfiles: createDefaultProviderProfiles(),
  activeImageProviderId: null,
  userDisplayName: DEFAULT_USER_DISPLAY_NAME,
  brainDisplayName: DEFAULT_BRAIN_DISPLAY_NAME,
  hasCompletedNamingOnboarding: false
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
      storedBrainIsValid
  };
}
