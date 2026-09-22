import { requestUrl } from "obsidian";

export const ASSEMBLYAI_STREAMING_SAMPLE_RATE = 16_000;
export const DEFAULT_ASSEMBLYAI_SPEECH_MODEL = "universal-3-5-pro";

export interface AssemblyAIVoiceConfig {
  enabled: boolean;
  apiKey: string;
  speechModel: string;
}

export type AssemblyAIVoiceState =
  | "idle"
  | "connecting"
  | "recording"
  | "stopping"
  | "error";

export interface AssemblyAIVoiceCallbacks {
  onTranscript: (transcript: string, finalized: boolean) => void;
  onStateChange: (
    state: AssemblyAIVoiceState,
    detail?: string
  ) => void;
}

interface AssemblyAIMessage {
  type?: unknown;
  turn_order?: unknown;
  transcript?: unknown;
  end_of_turn?: unknown;
  error?: unknown;
  message?: unknown;
}

export function buildAssemblyAIStreamingUrl(
  token: string,
  speechModel: string = DEFAULT_ASSEMBLYAI_SPEECH_MODEL,
  sampleRate: number = ASSEMBLYAI_STREAMING_SAMPLE_RATE
): string {
  const params = new URLSearchParams({
    token,
    speech_model: speechModel.trim() ||
      DEFAULT_ASSEMBLYAI_SPEECH_MODEL,
    sample_rate: String(sampleRate),
    format_turns: "true"
  });

  return "wss://streaming.assemblyai.com/v3/ws?" +
    params.toString();
}

export function downsampleToPcm16(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number = ASSEMBLYAI_STREAMING_SAMPLE_RATE
): ArrayBuffer {
  if (
    !Number.isFinite(sourceSampleRate) ||
    sourceSampleRate <= 0 ||
    targetSampleRate <= 0 ||
    sourceSampleRate < targetSampleRate
  ) {
    throw new Error(
      "The microphone sample rate must be at least the target sample rate."
    );
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex++) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(
      input.length,
      Math.max(start + 1, Math.floor((outputIndex + 1) * ratio))
    );
    let sum = 0;

    for (let inputIndex = start; inputIndex < end; inputIndex++) {
      sum += input[inputIndex] ?? 0;
    }

    const average = Math.max(-1, Math.min(1, sum / (end - start)));
    output[outputIndex] = average < 0
      ? Math.round(average * 0x8000)
      : Math.round(average * 0x7fff);
  }

  return output.buffer;
}

async function createTemporaryToken(apiKey: string): Promise<string> {
  const params = new URLSearchParams({
    expires_in_seconds: "60",
    max_session_duration_seconds: "1800"
  });
  const response = await requestUrl({
    url:
      "https://streaming.assemblyai.com/v3/token?" +
      params.toString(),
    method: "GET",
    headers: {
      Authorization: apiKey
    },
    throw: false
  });

  if (response.status < 200 || response.status >= 300) {
    const message =
      typeof response.json?.error === "string"
        ? response.json.error
        : "AssemblyAI rejected the temporary-token request.";
    throw new Error(message);
  }

  const token = response.json?.token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("AssemblyAI returned an empty temporary token.");
  }

  return token;
}

export class AssemblyAIVoiceInput {
  private state: AssemblyAIVoiceState = "idle";
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private muteNode: GainNode | null = null;
  private readonly finalTurns = new Map<number, string>();
  private partialTurn = "";
  private closeTimer: number | null = null;

  constructor(
    private readonly getConfig: () => AssemblyAIVoiceConfig,
    private readonly callbacks: AssemblyAIVoiceCallbacks
  ) {}

  get currentState(): AssemblyAIVoiceState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "error") {
      return;
    }

    const config = this.getConfig();
    if (!config.enabled) {
      this.transition("error", "Voice input is disabled in settings.");
      return;
    }
    if (config.apiKey.trim() === "") {
      this.transition(
        "error",
        "Add an AssemblyAI API key in Lain Brain settings."
      );
      return;
    }
    if (
      navigator.mediaDevices === undefined ||
      navigator.mediaDevices.getUserMedia === undefined
    ) {
      this.transition(
        "error",
        "Microphone capture is unavailable in this Obsidian runtime."
      );
      return;
    }

    this.resetTranscript();
    this.transition("connecting", "Requesting microphone access...");

    try {
      const token = await createTemporaryToken(config.apiKey.trim());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      this.stream = stream;
      const socket = new WebSocket(
        buildAssemblyAIStreamingUrl(token, config.speechModel)
      );
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.addEventListener("open", () => {
        void this.startAudioPipeline(stream, socket)
          .then(() => {
            this.transition("recording", "Listening with AssemblyAI...");
          })
          .catch((error: unknown) => {
            this.fail(error);
          });
      });

      socket.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });

      socket.addEventListener("error", () => {
        this.fail(new Error("AssemblyAI streaming connection failed."));
      });

      socket.addEventListener("close", () => {
        const wasError = this.state === "error";
        void this.releaseAudio();
        this.socket = null;
        if (!wasError) {
          this.transition("idle");
        }
      });
    } catch (error) {
      this.fail(error);
    }
  }

  async stop(): Promise<void> {
    if (
      this.state === "idle" ||
      this.state === "stopping"
    ) {
      return;
    }

    this.transition("stopping", "Finalizing transcript...");
    await this.releaseAudio();

    const socket = this.socket;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "Terminate" }));
      this.closeTimer = window.setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
      }, 3_000);
    } else {
      this.transition("idle");
    }
  }

  async destroy(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "Terminate" }));
      this.socket.close();
    }
    this.socket = null;
    await this.releaseAudio();
    this.clearCloseTimer();
    this.transition("idle");
  }

  private async startAudioPipeline(
    stream: MediaStream,
    socket: WebSocket
  ): Promise<void> {
    const audioContext = new AudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    const muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    processorNode.onaudioprocess = (event) => {
      if (
        this.state !== "recording" ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      const samples = event.inputBuffer.getChannelData(0);
      const pcm = downsampleToPcm16(
        samples,
        audioContext.sampleRate
      );
      socket.send(pcm);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(muteNode);
    muteNode.connect(audioContext.destination);

    this.audioContext = audioContext;
    this.sourceNode = sourceNode;
    this.processorNode = processorNode;
    this.muteNode = muteNode;
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }

    let message: AssemblyAIMessage;
    try {
      message = JSON.parse(raw) as AssemblyAIMessage;
    } catch {
      return;
    }

    if (message.type === "Turn") {
      const transcript =
        typeof message.transcript === "string"
          ? message.transcript.trim()
          : "";
      const order =
        typeof message.turn_order === "number"
          ? message.turn_order
          : this.finalTurns.size;

      if (message.end_of_turn === true) {
        if (transcript !== "") {
          this.finalTurns.set(order, transcript);
        }
        this.partialTurn = "";
      } else {
        this.partialTurn = transcript;
      }

      const combined = this.composeTranscript();
      if (combined !== "") {
        this.callbacks.onTranscript(
          combined,
          message.end_of_turn === true
        );
      }
      return;
    }

    if (message.type === "Termination") {
      this.clearCloseTimer();
      this.socket?.close();
      return;
    }

    const error =
      typeof message.error === "string"
        ? message.error
        : typeof message.message === "string"
          ? message.message
          : undefined;
    if (error !== undefined) {
      this.fail(new Error(error));
    }
  }

  private composeTranscript(): string {
    const finalText = Array.from(this.finalTurns.entries())
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text);
    if (this.partialTurn !== "") {
      finalText.push(this.partialTurn);
    }
    return finalText.join(" ").trim();
  }

  private resetTranscript(): void {
    this.finalTurns.clear();
    this.partialTurn = "";
  }

  private async releaseAudio(): Promise<void> {
    if (this.processorNode !== null) {
      this.processorNode.onaudioprocess = null;
      this.processorNode.disconnect();
    }
    this.sourceNode?.disconnect();
    this.muteNode?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    if (
      this.audioContext !== null &&
      this.audioContext.state !== "closed"
    ) {
      await this.audioContext.close();
    }

    this.processorNode = null;
    this.sourceNode = null;
    this.muteNode = null;
    this.audioContext = null;
    this.stream = null;
  }

  private fail(error: unknown): void {
    const message = error instanceof Error
      ? error.message
      : String(error);
    void this.releaseAudio();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "Terminate" }));
      this.socket.close();
    }
    this.socket = null;
    this.transition("error", message);
  }

  private clearCloseTimer(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  private transition(
    state: AssemblyAIVoiceState,
    detail?: string
  ): void {
    this.state = state;
    this.callbacks.onStateChange(state, detail);
  }
}
