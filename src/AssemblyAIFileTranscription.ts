import { requestUrl } from "obsidian";

export const ASSEMBLYAI_REST_BASE = "https://api.assemblyai.com/v2";

export interface RecordingFile {
  readonly name: string;
  readonly data: ArrayBuffer;
}

export interface RecordingUtterance {
  readonly speaker: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface RecordingTranscript {
  readonly text: string;
  readonly utterances: readonly RecordingUtterance[];
  readonly speakerCount: number;
}

export interface RecordingImportStage {
  readonly name: "uploading" | "submitting" | "polling";
  readonly detail?: string;
}

export interface AssemblyAIHttpRequest {
  (options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    throw?: boolean;
  }): Promise<{
    status: number;
    json?: unknown;
    text?: string;
  }>;
}

function contentTypeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  return "application/octet-stream";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function transcribeRecordingFile(
  apiKey: string,
  file: RecordingFile,
  options: {
    speakerLabels?: boolean;
    request?: AssemblyAIHttpRequest;
    pollIntervalMs?: number;
    maxPollAttempts?: number;
    onStage?: (stage: RecordingImportStage) => void;
  } = {}
): Promise<RecordingTranscript> {
  const request = options.request ?? requestUrl;
  const pollIntervalMs = Math.max(5, options.pollIntervalMs ?? 1000);
  const maxPollAttempts = Math.max(1, options.maxPollAttempts ?? 300);
  const stage = options.onStage ?? (() => {});

  if (apiKey.trim() === "") {
    throw new Error("Add an AssemblyAI API key in Lain Brain settings.");
  }

  stage({
    name: "uploading",
    detail: `${file.name} (${file.data.byteLength} bytes)`
  });
  const uploadResponse = await request({
    url: `${ASSEMBLYAI_REST_BASE}/upload`,
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": contentTypeForFileName(file.name)
    },
    body: file.data,
    throw: false
  });
  if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
    throw new Error(
      `AssemblyAI upload failed (HTTP ${uploadResponse.status}): ` +
      (asString((uploadResponse.json as { error?: unknown } | undefined)?.error) ||
        "rejected")
    );
  }
  const uploadUrl = (uploadResponse.json as { upload_url?: unknown } | undefined)
    ?.upload_url;
  if (typeof uploadUrl !== "string" || uploadUrl === "") {
    throw new Error("AssemblyAI returned no upload URL.");
  }

  stage({ name: "submitting" });
  const submitResponse = await request({
    url: `${ASSEMBLYAI_REST_BASE}/transcript`,
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      audio_url: uploadUrl,
      speech_models: ["universal-3-5-pro", "universal-2"],
      speaker_labels: options.speakerLabels !== false
    }),
    throw: false
  });
  if (submitResponse.status < 200 || submitResponse.status >= 300) {
    throw new Error(
      `AssemblyAI transcription request failed (HTTP ${submitResponse.status}): ` +
      (asString((submitResponse.json as { error?: unknown } | undefined)?.error) ||
        "rejected")
    );
  }
  const transcriptId = (submitResponse.json as { id?: unknown } | undefined)?.id;
  if (typeof transcriptId !== "string" || transcriptId === "") {
    throw new Error("AssemblyAI returned no transcript id.");
  }

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    stage({ name: "polling", detail: transcriptId });
    const pollResponse = await request({
      url: `${ASSEMBLYAI_REST_BASE}/transcript/${transcriptId}`,
      method: "GET",
      headers: { Authorization: apiKey },
      throw: false
    });
    const json = pollResponse.json as
      | {
          status?: unknown;
          error?: unknown;
          text?: unknown;
          utterances?: unknown;
        }
      | undefined;
    const status = json?.status;
    if (status === "completed") {
      const utterances = Array.isArray(json?.utterances)
        ? (json.utterances as Array<{
            speaker?: unknown;
            start?: unknown;
            end?: unknown;
            text?: unknown;
          }>).map((utterance, index) => ({
            speaker: asString(utterance.speaker) || `Speaker ${index + 1}`,
            startMs: typeof utterance.start === "number" ? utterance.start : 0,
            endMs: typeof utterance.end === "number" ? utterance.end : 0,
            text: asString(utterance.text).trim()
          }))
        : [];
      return {
        text: asString(json?.text).trim(),
        utterances,
        speakerCount: new Set(utterances.map((u) => u.speaker)).size
      };
    }
    if (status === "error") {
      throw new Error(
        `AssemblyAI transcription failed (HTTP ${pollResponse.status}): ` +
        (asString(json?.error) || "error")
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("AssemblyAI transcription timed out.");
}
