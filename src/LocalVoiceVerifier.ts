const SAMPLE_RATE = 16_000;
const FRAME_SIZE = 320;
const HOP_SIZE = 160;
const MIN_SAMPLES_PER_CLASS = 3;

export type VoiceCalibrationLabel = "positive" | "negative";

export interface VoiceVerificationResult {
  readonly calibrated: boolean;
  readonly proven: boolean;
  readonly supported: boolean;
  readonly decision: "command" | "uncertain";
  readonly confidence: number;
  readonly durationMs: number;
  readonly reason: string;
}

export interface VoiceCalibrationStatus {
  readonly calibrated: boolean;
  readonly proven: boolean;
  readonly reason: string;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly separation: number;
  readonly blindEvaluated: boolean;
}

export interface VoiceBlindEvaluation {
  readonly falsePositiveCount: number;
  readonly falseNegativeCount: number;
  readonly totalCount: number;
  readonly passed: boolean;
  readonly reason: string;
}

type Frame = readonly number[];
type Sequence = readonly Frame[];

interface MacroBank {
  positive: Sequence[];
  negative: Sequence[];
  calibrated: boolean;
  proven: boolean;
  blindEvaluated: boolean;
  reason: string;
  separation: number;
}

function frames(samples: Float32Array): Sequence {
  const result: Frame[] = [];
  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    let energy = 0;
    let crossings = 0;
    let peak = 0;
    let previous = samples[start] ?? 0;
    for (let index = 0; index < FRAME_SIZE; index += 1) {
      const value = samples[start + index] ?? 0;
      energy += value * value;
      const abs = Math.abs(value);
      peak = Math.max(peak, abs);
      if (index > 0 && (value >= 0) !== (previous >= 0)) {
        crossings += 1;
      }
      previous = value;
    }
    const rms = Math.sqrt(energy / FRAME_SIZE);
    const energyDb = rms <= 1e-8 ? -120 : 20 * Math.log10(rms);
    const zeroCrossing = crossings / (FRAME_SIZE - 1);
    const peakRms = rms <= 1e-8 ? 0 : peak / rms;
    result.push([
      (energyDb + 60) / 60,
      zeroCrossing * 20,
      peakRms / 20
    ]);
  }
  return result;
}

function frameDistance(left: Frame, right: Frame): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function dtwDistance(left: Sequence, right: Sequence): number {
  if (left.length === 0 || right.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = new Float32Array(rows * columns);
  matrix.fill(Number.POSITIVE_INFINITY);
  matrix[0] = 0;

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = frameDistance(
        left[row - 1]!,
        right[column - 1]!
      );
      const previous = Math.min(
        matrix[(row - 1) * columns + column]!,
        matrix[row * columns + column - 1]!,
        matrix[(row - 1) * columns + column - 1]!
      );
      matrix[row * columns + column] = cost + previous;
    }
  }

  return matrix[rows * columns - 1]! /
    Math.max(1, left.length, right.length);
}

function nearestDistance(
  sequence: Sequence,
  templates: readonly Sequence[]
): number {
  if (templates.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const template of templates) {
    best = Math.min(best, dtwDistance(sequence, template));
  }
  return best;
}

function separation(
  positive: readonly Sequence[],
  negative: readonly Sequence[]
): number {
  if (positive.length === 0 || negative.length === 0) {
    return 0;
  }
  let positiveToNegative = 0;
  for (const item of positive) {
    positiveToNegative += nearestDistance(item, negative);
  }
  let positiveToPositive = 0;
  for (let index = 0; index < positive.length; index += 1) {
    for (let other = 0; other < positive.length; other += 1) {
      if (index !== other) {
        positiveToPositive += dtwDistance(positive[index]!, positive[other]!);
      }
    }
  }
  const denominator = Math.max(1, positive.length * Math.max(1, positive.length - 1));
  const meanSame = positiveToPositive / denominator;
  const meanCross = positiveToNegative / Math.max(1, positive.length * negative.length);
  return meanCross / Math.max(1e-6, meanSame);
}

export class LocalVoiceVerifier {
  private readonly banks = new Map<string, MacroBank>();

  private bank(macroId: string): MacroBank {
    let value = this.banks.get(macroId);
    if (value === undefined) {
      value = {
        positive: [],
        negative: [],
        calibrated: false,
        proven: false,
        blindEvaluated: false,
        reason: `No voice samples for macro "${macroId}".`,
        separation: 0
      };
      this.banks.set(macroId, value);
    }
    return value;
  }

  addSample(
    macroId: string,
    label: VoiceCalibrationLabel,
    samples: Float32Array,
    sampleRate = SAMPLE_RATE
  ): VoiceCalibrationStatus {
    const value = this.bank(macroId);
    const sequence = frames(samples);
    if (label === "positive") {
      value.positive.push(sequence);
    } else {
      value.negative.push(sequence);
    }
    this.recalibrate(macroId, value);
    return this.status(macroId);
  }

  status(macroId: string): VoiceCalibrationStatus {
    const value = this.bank(macroId);
    return {
      calibrated: value.calibrated,
      proven: value.proven,
      reason: value.reason,
      positiveCount: value.positive.length,
      negativeCount: value.negative.length,
      separation: value.separation,
      blindEvaluated: value.blindEvaluated
    };
  }

  markProven(
    macroId: string,
    evaluation: VoiceBlindEvaluation
  ): VoiceCalibrationStatus {
    const value = this.bank(macroId);
    value.blindEvaluated = true;
    value.proven = evaluation.passed && value.calibrated;
    value.reason = evaluation.passed
      ? "Voice trigger passed a real-audio blind evaluation."
      : "Voice trigger has not passed a real-audio blind evaluation.";
    return this.status(macroId);
  }

  clear(macroId?: string): void {
    if (macroId === undefined) {
      this.banks.clear();
      return;
    }
    this.banks.delete(macroId);
  }

  verify(
    macroId: string,
    samples: Float32Array,
    sampleRate = SAMPLE_RATE
  ): VoiceVerificationResult {
    const value = this.bank(macroId);
    const durationMs = (samples.length / sampleRate) * 1000;
    if (samples.length === 0) {
      return {
        calibrated: value.calibrated,
        proven: value.proven,
        supported: false,
        decision: "uncertain",
        confidence: 0,
        durationMs,
        reason: "No audio aligned for this final turn."
      };
    }
    if (!value.calibrated) {
      return {
        calibrated: false,
        proven: false,
        supported: false,
        decision: "uncertain",
        confidence: 0,
        durationMs,
        reason: value.reason
      };
    }
    if (!value.proven) {
      return {
        calibrated: true,
        proven: false,
        supported: false,
        decision: "uncertain",
        confidence: 0,
        durationMs,
        reason: "Voice trigger is calibrated but not proven on real audio."
      };
    }

    const sequence = frames(samples);
    const positiveDistance = nearestDistance(sequence, value.positive);
    const negativeDistance = nearestDistance(sequence, value.negative);
    const confidence =
      (negativeDistance - positiveDistance) /
      (positiveDistance + negativeDistance + 1e-6);
    if (confidence > 0.25 && positiveDistance < negativeDistance) {
      return {
        calibrated: true,
        proven: true,
        supported: true,
        decision: "command",
        confidence,
        durationMs,
        reason: `Voice sequence matched macro "${macroId}".`
      };
    }
    return {
      calibrated: true,
      proven: true,
      supported: true,
      decision: "uncertain",
      confidence,
      durationMs,
      reason: `Voice sequence did not clearly match macro "${macroId}".`
    };
  }

  identifyBest(
    samples: Float32Array,
    macroIds: readonly string[],
    sampleRate = SAMPLE_RATE
  ): { macroId: string; confidence: number } | null {
    if (samples.length === 0) {
      return null;
    }
    let best: { macroId: string; confidence: number } | null = null;
    for (const macroId of macroIds) {
      const result = this.verify(macroId, samples, sampleRate);
      if (result.decision !== "command") {
        continue;
      }
      if (best === null || result.confidence > best.confidence) {
        best = { macroId, confidence: result.confidence };
      }
    }
    return best;
  }

  score(
    macroId: string,
    samples: Float32Array,
    sampleRate = SAMPLE_RATE
  ): {
    readonly calibrated: boolean;
    readonly confidence: number;
    readonly positiveDistance: number;
    readonly negativeDistance: number;
    readonly durationMs: number;
  } | null {
    const value = this.bank(macroId);
    if (!value.calibrated || samples.length === 0) {
      return null;
    }
    const sequence = frames(samples);
    const positiveDistance = nearestDistance(sequence, value.positive);
    const negativeDistance = nearestDistance(sequence, value.negative);
    const confidence =
      (negativeDistance - positiveDistance) /
      (positiveDistance + negativeDistance + 1e-6);
    return {
      calibrated: true,
      confidence,
      positiveDistance,
      negativeDistance,
      durationMs: (samples.length / sampleRate) * 1000
    };
  }

  private recalibrate(macroId: string, value: MacroBank): void {
    if (
      value.positive.length < MIN_SAMPLES_PER_CLASS ||
      value.negative.length < MIN_SAMPLES_PER_CLASS
    ) {
      value.calibrated = false;
      value.reason =
        `Need at least ${MIN_SAMPLES_PER_CLASS} positive and ${MIN_SAMPLES_PER_CLASS} negative samples for "${macroId}".`;
      value.separation = 0;
      return;
    }

    value.separation = separation(value.positive, value.negative);
    value.calibrated = value.separation >= 1.0;
    value.reason = value.calibrated
      ? `Voice sequence model for "${macroId}" is calibrated but not yet proven on real audio.`
      : `Positive and negative sequences for "${macroId}" are too similar; voice trigger is unavailable.`;
    value.proven = false;
  }
}
