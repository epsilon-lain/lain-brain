export type TextModelProvider = "deepseek" | "nebius";

export const NEBIUS_NEMOTRON_MODEL = "nvidia/nemotron-3-super-120b-a12b";
// Endpoint and model pair from Nebius's Nemotron 3 Super cookbook.
export const NEBIUS_CHAT_URL =
  "https://api.tokenfactory.us-central1.nebius.com/v1/chat/completions";

export interface TextModelReceipt {
  readonly provider: TextModelProvider;
  readonly requestedModel: string;
  readonly servedModel?: string;
  readonly endpoint: string;
  readonly requestId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly completedAt: string;
}

export interface TextModelConfig {
  readonly provider: TextModelProvider;
  readonly apiKey: string;
  readonly model: string;
  readonly onReceipt?: (receipt: Readonly<TextModelReceipt>) => void;
}

// Bare keys preserve the existing DeepSeek API for integrations and tests.
export type TextModelCredentials = string | Readonly<TextModelConfig>;

export function textModelApiKey(value: TextModelCredentials): string {
  return (typeof value === "string" ? value : value.apiKey).trim();
}

export function resolveTextModelConfig(
  value: TextModelCredentials
): Readonly<TextModelConfig> {
  return Object.freeze(typeof value === "string"
    ? { provider: "deepseek", apiKey: value.trim(), model: "deepseek-v4-flash" }
    : { ...value, apiKey: value.apiKey.trim(), model: value.model.trim() });
}

export function textModelIdentity(value: TextModelCredentials): {
  providerId: string;
  providerDisplayName: string;
} {
  const config = resolveTextModelConfig(value);
  return {
    providerId: config.provider,
    providerDisplayName: config.provider === "nebius"
      ? `Nebius · ${config.model}`
      : "DeepSeek"
  };
}
