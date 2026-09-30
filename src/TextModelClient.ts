import { requestUrl } from "obsidian";
import {
  NEBIUS_CHAT_URL,
  resolveTextModelConfig
} from "./TextModelConfig";
import type { TextModelCredentials } from "./TextModelConfig";

export interface TextModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface ChatCompletionResponse {
  id?: unknown;
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

export async function requestTextModel(
  credentials: TextModelCredentials,
  messages: readonly TextModelMessage[]
): Promise<string> {
  const config = resolveTextModelConfig(credentials);
  const name = config.provider === "nebius" ? "Nebius" : "DeepSeek";
  if (config.apiKey === "") {
    throw new Error(`Add a ${name} API key in Lain Brain settings.`);
  }
  if (config.model === "" ||
      (config.provider === "nebius" && !config.model.startsWith("nvidia/"))) {
    throw new Error("Select an NVIDIA model ID (nvidia/…) for Nebius.");
  }
  const endpoint = config.provider === "nebius"
    ? NEBIUS_CHAT_URL
    : "https://api.deepseek.com/chat/completions";
  // Never include raw provider errors: they may echo prompts or credentials.
  const response = await requestUrl({
    url: endpoint,
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: config.model, messages }),
    throw: false
  }).catch(() => {
    throw new Error(`${name} request failed. Check your connection and settings.`);
  });
  if (typeof response.status === "number" &&
      (response.status < 200 || response.status >= 300)) {
    throw new Error(`${name} request failed (HTTP ${response.status}).`);
  }
  const data = response.json as ChatCompletionResponse | null;
  const answer = data?.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || answer.trim() === "") {
    throw new Error(`${name} returned no answer.`);
  }
  const receipt = Object.freeze({
    provider: config.provider,
    requestedModel: config.model,
    endpoint,
    servedModel: safeMetadata(data?.model, config.apiKey),
    requestId: safeMetadata(data?.id, config.apiKey),
    inputTokens: tokenCount(data?.usage?.prompt_tokens),
    outputTokens: tokenCount(data?.usage?.completion_tokens),
    completedAt: new Date().toISOString()
  });
  // Observability must not discard a successful answer.
  try { config.onReceipt?.(receipt); } catch { /* local observer only */ }
  return answer;
}

function safeMetadata(value: unknown, apiKey: string): string | undefined {
  return typeof value === "string" && !value.includes(apiKey) &&
    /^[\w./:-]{1,200}$/.test(value)
    ? value : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : undefined;
}
