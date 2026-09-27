const MAX_SECONDS = 12;
const TARGET_SAMPLE_RATE = 16_000;

export class VoiceAudioRingBuffer {
  private readonly capacity: number;
  private samples = new Float32Array(TARGET_SAMPLE_RATE * MAX_SECONDS);
  private writeIndex = 0;
  private length = 0;
  private totalSamplesWritten = 0;

  constructor() {
    this.capacity = this.samples.length;
  }

  get availableMs(): number {
    return Math.floor((this.length / TARGET_SAMPLE_RATE) * 1000);
  }

  clear(): void {
    this.samples.fill(0);
    this.writeIndex = 0;
    this.length = 0;
    this.totalSamplesWritten = 0;
  }

  append(input: Float32Array): void {
    if (input.length === 0) {
      return;
    }
    for (let index = 0; index < input.length; index += 1) {
      this.samples[this.writeIndex] = input[index] ?? 0;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.totalSamplesWritten += 1;
      if (this.length < this.capacity) {
        this.length += 1;
      }
    }
  }

  /**
   * Slice by AssemblyAI stream-relative timestamps. Returns null when the
   * timestamps are missing, reversed, or outside the locally retained window.
   */
  slice(startMs: number | undefined, endMs: number | undefined):
    Float32Array | null {
    if (
      startMs === undefined ||
      endMs === undefined ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs <= startMs
    ) {
      return null;
    }

    const startSample = Math.floor((startMs / 1000) * TARGET_SAMPLE_RATE);
    const endSample = Math.ceil((endMs / 1000) * TARGET_SAMPLE_RATE);
    const retainedStart = this.totalSamplesWritten - this.length;
    if (
      startSample < retainedStart ||
      endSample > this.totalSamplesWritten ||
      endSample - startSample > TARGET_SAMPLE_RATE * MAX_SECONDS
    ) {
      return null;
    }

    const output = new Float32Array(Math.max(0, endSample - startSample));
    for (let index = 0; index < output.length; index += 1) {
      const absolute = startSample + index;
      const physical = ((absolute % this.capacity) + this.capacity) %
        this.capacity;
      output[index] = this.samples[physical] ?? 0;
    }
    return output;
  }
}
