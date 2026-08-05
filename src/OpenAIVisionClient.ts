import {
  canAnalyzeImages,
  OPENAI_RESPONSES_URL
} from "./ProviderProfiles";
import type {
  ProviderProfile,
  ProviderProtocol
} from "./ProviderProfiles";

export const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;

export const SUPPORTED_VISION_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

export interface VisionImageFile extends Blob {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AssistantResult {
  text: string;
  providerId: string;
  providerDisplayName: string;
}

export interface VisionProviderClient {
  analyzeImage(
    profile: ProviderProfile,
    prompt: string,
    image: VisionImageFile
  ): Promise<AssistantResult>;
}

export type VisionProviderFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

interface OpenAIResponsesPayload {
  output_text?: unknown;
  output?: unknown;
}

interface ChatCompletionsPayload {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

export class OpenAIResponsesVisionAdapter
implements VisionProviderClient {
  constructor(private fetchImpl?: VisionProviderFetch) {}

  async analyzeImage(
    profile: ProviderProfile,
    prompt: string,
    image: VisionImageFile
  ): Promise<AssistantResult> {
    validateRequest(profile, image, "openai-responses");
    const imageUrl = await createImageDataUrl(image);
    const response = await requestProvider(
      profile,
      profile.baseUrl,
      {
        model: profile.model,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_url: imageUrl,
              detail: "auto"
            }
          ]
        }]
      },
      this.fetchImpl
    );
    const payload = await readJson<OpenAIResponsesPayload>(response);
    const text = extractOpenAIVisionText(payload);

    if (text === null) {
      throw new Error("Image provider returned no answer.");
    }

    return result(profile, text);
  }
}

export class OpenAIChatCompletionsVisionAdapter
implements VisionProviderClient {
  constructor(private fetchImpl?: VisionProviderFetch) {}

  async analyzeImage(
    profile: ProviderProfile,
    prompt: string,
    image: VisionImageFile
  ): Promise<AssistantResult> {
    validateRequest(profile, image, "openai-chat-completions");
    const imageUrl = await createImageDataUrl(image);
    const endpoint =
      `${profile.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await requestProvider(
      profile,
      endpoint,
      {
        model: profile.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: imageUrl }
            }
          ]
        }]
      },
      this.fetchImpl
    );
    const payload = await readJson<ChatCompletionsPayload>(response);
    const content = payload.choices?.[0]?.message?.content;

    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("Image provider returned no answer.");
    }

    return result(profile, content);
  }
}

export class VisionProviderRouter implements VisionProviderClient {
  private readonly adapters:
    Record<ProviderProtocol, VisionProviderClient>;

  constructor(fetchImpl?: VisionProviderFetch) {
    this.adapters = {
      "openai-responses":
        new OpenAIResponsesVisionAdapter(fetchImpl),
      "openai-chat-completions":
        new OpenAIChatCompletionsVisionAdapter(fetchImpl)
    };
  }

  analyzeImage(
    profile: ProviderProfile,
    prompt: string,
    image: VisionImageFile
  ): Promise<AssistantResult> {
    return this.adapters[profile.protocol].analyzeImage(
      profile,
      prompt,
      image
    );
  }
}

export function validateVisionImage(
  image: VisionImageFile
): string | null {
  if (!SUPPORTED_VISION_IMAGE_TYPES.has(image.type.toLowerCase())) {
    return "Please choose a PNG, JPEG, WebP, or GIF image.";
  }

  if (image.size <= 0) {
    return "The selected image is empty.";
  }

  if (image.size > MAX_VISION_IMAGE_BYTES) {
    return "Image must be 10 MiB or smaller.";
  }

  return null;
}

export async function createImageDataUrl(
  image: VisionImageFile
): Promise<string> {
  const validationError = validateVisionImage(image);

  if (validationError !== null) {
    throw new Error(validationError);
  }

  const bytes = new Uint8Array(await image.arrayBuffer());
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 32768, bytes.length))
    );
  }

  return `data:${image.type.toLowerCase()};base64,${btoa(binary)}`;
}

export async function askOpenAIVision(
  apiKey: string,
  model: string,
  message: string,
  image: VisionImageFile,
  fetchImpl: VisionProviderFetch = fetch
): Promise<string> {
  const adapter = new OpenAIResponsesVisionAdapter(fetchImpl);
  const response = await adapter.analyzeImage(
    {
      id: "builtin-openai-vision",
      displayName: "OpenAI Vision",
      protocol: "openai-responses",
      baseUrl: OPENAI_RESPONSES_URL,
      model: model.trim() || "gpt-5.6",
      apiKey,
      capabilities: {
        supportsText: true,
        supportsImages: true,
        supportsPdf: false
      },
      builtInKind: "openai"
    },
    message,
    image
  );

  return response.text;
}

export function extractOpenAIVisionText(
  payload: OpenAIResponsesPayload
): string | null {
  if (
    typeof payload.output_text === "string" &&
    payload.output_text.trim() !== ""
  ) {
    return payload.output_text;
  }

  if (!Array.isArray(payload.output)) {
    return null;
  }

  const parts: string[] = [];

  for (const output of payload.output) {
    if (typeof output !== "object" || output === null) {
      continue;
    }

    const content = (output as { content?: unknown }).content;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const item of content) {
      if (typeof item !== "object" || item === null) {
        continue;
      }

      const value = item as { type?: unknown; text?: unknown };

      if (value.type === "output_text" && typeof value.text === "string") {
        parts.push(value.text);
      }
    }
  }

  const answer = parts.join("\n").trim();
  return answer === "" ? null : answer;
}

function validateRequest(
  profile: ProviderProfile,
  image: VisionImageFile,
  protocol: ProviderProtocol
): void {
  if (!canAnalyzeImages(profile) || profile.protocol !== protocol) {
    throw new Error("The selected image provider is not configured.");
  }

  const imageError = validateVisionImage(image);

  if (imageError !== null) {
    throw new Error(imageError);
  }
}

async function requestProvider(
  profile: ProviderProfile,
  endpoint: string,
  body: unknown,
  fetchImpl?: VisionProviderFetch
): Promise<Response> {
  let response: Response;

  try {
    response = await (fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error("Unable to reach the image provider. Please try again.");
  }

  if (!response.ok) {
    const detail = await readSafeErrorDetail(response, profile.apiKey);
    throw new Error(
      `Image provider request failed (${response.status}).` +
      (detail === "" ? "" : ` ${detail}`)
    );
  }

  return response;
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new Error("Image provider returned an unreadable response.");
  }
}

async function readSafeErrorDetail(
  response: Response,
  apiKey: string
): Promise<string> {
  try {
    const text = await response.text();
    return text
      .replaceAll(apiKey, "[redacted]")
      .replace(
        /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi,
        "[image data]"
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
  } catch {
    return "";
  }
}

function result(
  profile: ProviderProfile,
  text: string
): AssistantResult {
  return {
    text,
    providerId: profile.id,
    providerDisplayName: profile.displayName
  };
}