export type ProviderProtocol =
  | "openai-responses"
  | "openai-chat-completions";

export interface ProviderCapabilities {
  supportsText: boolean;
  supportsImages: boolean;
  supportsPdf: boolean;
}

export interface ProviderProfile {
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  capabilities: ProviderCapabilities;
  builtInKind?: "openai" | "qwen";
}

export const OPENAI_VISION_PROFILE_ID = "builtin-openai-vision";
export const QWEN_VISION_PROFILE_ID = "builtin-qwen-vision";
export const OPENAI_RESPONSES_URL =
  "https://api.openai.com/v1/responses";
export const QWEN_COMPATIBLE_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

export function createDefaultProviderProfiles(): ProviderProfile[] {
  return [
    {
      id: OPENAI_VISION_PROFILE_ID,
      displayName: "OpenAI Vision",
      protocol: "openai-responses",
      baseUrl: OPENAI_RESPONSES_URL,
      model: "gpt-5.6",
      apiKey: "",
      capabilities: imageCapabilities(),
      builtInKind: "openai"
    },
    {
      id: QWEN_VISION_PROFILE_ID,
      displayName: "Qwen Vision",
      protocol: "openai-chat-completions",
      baseUrl: QWEN_COMPATIBLE_BASE_URL,
      model: "",
      apiKey: "",
      capabilities: imageCapabilities(),
      builtInKind: "qwen"
    }
  ];
}

export function createCustomProviderProfile(): ProviderProfile {
  return {
    id: createProviderProfileId(),
    displayName: "Custom Vision Provider",
    protocol: "openai-chat-completions",
    baseUrl: "https://",
    model: "",
    apiKey: "",
    capabilities: {
      supportsText: true,
      supportsImages: false,
      supportsPdf: false
    }
  };
}

export function normalizeProviderProfiles(
  value: unknown,
  legacy?: {
    enabled?: unknown;
    apiKey?: unknown;
    model?: unknown;
  }
): {
  profiles: ProviderProfile[];
  migratedActiveProviderId: string | null;
} {
  const defaults = createDefaultProviderProfiles();

  if (!Array.isArray(value)) {
    const openAI = defaults[0];

    if (openAI !== undefined) {
      openAI.apiKey = stringValue(legacy?.apiKey);
      openAI.model = stringValue(legacy?.model).trim() || "gpt-5.6";
    }

    return {
      profiles: defaults,
      migratedActiveProviderId:
        legacy?.enabled === true ? OPENAI_VISION_PROFILE_ID : null
    };
  }

  const profiles: ProviderProfile[] = [];
  const seenIds = new Set<string>();

  for (const item of value) {
    const parsed = parseProviderProfile(item);

    if (parsed === null || seenIds.has(parsed.id)) {
      continue;
    }

    seenIds.add(parsed.id);
    profiles.push(parsed);
  }

  for (const builtIn of defaults) {
    const existingIndex = profiles.findIndex(
      (profile) => profile.id === builtIn.id
    );

    if (existingIndex === -1) {
      profiles.push(builtIn);
      continue;
    }

    const existing = profiles[existingIndex];

    if (existing !== undefined) {
      profiles[existingIndex] = {
        ...builtIn,
        apiKey: existing.apiKey,
        model: existing.model || builtIn.model
      };
    }
  }

  return { profiles, migratedActiveProviderId: null };
}

export function validateProviderProfile(
  profile: ProviderProfile
): string | null {
  const name = profile.displayName.trim();

  if (name === "" || name.length > 70 || /[\r\n]/.test(name)) {
    return "Provider name must be between 1 and 70 characters.";
  }

  if (!isHttpsUrl(profile.baseUrl)) {
    return "Base URL must be a valid HTTPS URL.";
  }

  if (profile.model.trim() === "") {
    return "Model is required.";
  }

  if (profile.apiKey.trim() === "") {
    return "API key is required.";
  }

  return null;
}

export function canAnalyzeImages(profile: ProviderProfile): boolean {
  return (
    validateProviderProfile(profile) === null &&
    profile.capabilities.supportsImages
  );
}

export function getActiveImageProvider(
  profiles: readonly ProviderProfile[],
  activeProviderId: string | null
): ProviderProfile | null {
  if (activeProviderId === null) {
    return null;
  }

  return profiles.find((profile) => profile.id === activeProviderId) ?? null;
}

export function createProviderProfileId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();

  if (randomId !== undefined) {
    return `custom-${randomId}`;
  }

  return `custom-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function parseProviderProfile(value: unknown): ProviderProfile | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const item = value as Record<string, unknown>;
  const id = stringValue(item.id).trim();
  const protocol = item.protocol;

  if (
    id === "" ||
    (
      protocol !== "openai-responses" &&
      protocol !== "openai-chat-completions"
    )
  ) {
    return null;
  }

  const capabilities =
    typeof item.capabilities === "object" &&
    item.capabilities !== null
      ? item.capabilities as Record<string, unknown>
      : {};
  const builtInKind = item.builtInKind === "openai" ||
    item.builtInKind === "qwen"
      ? item.builtInKind
      : undefined;

  return {
    id,
    displayName: stringValue(item.displayName),
    protocol,
    baseUrl: stringValue(item.baseUrl),
    model: stringValue(item.model),
    apiKey: stringValue(item.apiKey),
    capabilities: {
      supportsText: capabilities.supportsText === true,
      supportsImages: capabilities.supportsImages === true,
      supportsPdf: capabilities.supportsPdf === true
    },
    builtInKind
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function imageCapabilities(): ProviderCapabilities {
  return {
    supportsText: true,
    supportsImages: true,
    supportsPdf: false
  };
}
