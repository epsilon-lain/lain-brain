import { LocalVoiceVerifier } from "./LocalVoiceVerifier";
import type {
  VoiceBlindEvaluation,
  VoiceCalibrationStatus
} from "./LocalVoiceVerifier";

export const VOICE_ACCEPTANCE_CRITERIA = Object.freeze({
  maxFalsePositiveRate: 0.05,
  maxFalseNegativeRate: 0.05,
  maxLatencyP95Ms: 2_000,
  minPositiveSamples: 20,
  minNegativeSamples: 20,
  minCrossLanguageOrNoiseSamples: 10
});

export interface BlindVoiceSample {
  readonly macroId: string;
  readonly label: "positive" | "negative";
  readonly audio: Float32Array;
  readonly transcript: string;
  readonly latencyMs: number;
  readonly category: "speed" | "volume" | "noise" | "language" | "ordinary";
}

export interface VoiceBlindEvaluationResult {
  readonly macroId: string;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly falsePositiveCount: number;
  readonly falseNegativeCount: number;
  readonly falsePositiveRate: number;
  readonly falseNegativeRate: number;
  readonly latencyP95Ms: number;
  readonly passed: boolean;
  readonly reason: string;
  readonly waitingForRealData: boolean;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, index)] ?? 0;
}

export class VoiceBlindEvaluator {
  private readonly samples: BlindVoiceSample[] = [];
  private lastResult?: VoiceBlindEvaluationResult;

  constructor(private readonly verifier: LocalVoiceVerifier) {}

  addSample(sample: BlindVoiceSample): void {
    this.samples.push(sample);
  }

  clear(): void {
    this.samples.length = 0;
    this.lastResult = undefined;
  }

  listSamples(macroId?: string): readonly BlindVoiceSample[] {
    const selected = macroId === undefined
      ? this.samples
      : this.samples.filter((sample) => sample.macroId === macroId);
    return selected.map((sample) => ({ ...sample }));
  }

  getLastResult(): VoiceBlindEvaluationResult | undefined {
    return this.lastResult;
  }

  evaluate(macroId: string): VoiceBlindEvaluationResult {
    this.lastResult = this.buildEvaluation(macroId);
    return this.lastResult;
  }

  private buildEvaluation(macroId: string): VoiceBlindEvaluationResult {
    const positive = this.samples.filter(
      (sample) => sample.macroId === macroId && sample.label === "positive"
    );
    const negative = this.samples.filter(
      (sample) => sample.macroId === macroId && sample.label === "negative"
    );
    const cross = this.samples.filter(
      (sample) =>
        sample.macroId === macroId &&
        (sample.category === "noise" || sample.category === "language")
    );
    const latencies = this.samples
      .filter((sample) => sample.macroId === macroId)
      .map((sample) => sample.latencyMs);

    if (
      positive.length < VOICE_ACCEPTANCE_CRITERIA.minPositiveSamples ||
      negative.length < VOICE_ACCEPTANCE_CRITERIA.minNegativeSamples ||
      cross.length < VOICE_ACCEPTANCE_CRITERIA.minCrossLanguageOrNoiseSamples
    ) {
      return {
        macroId,
        positiveCount: positive.length,
        negativeCount: negative.length,
        falsePositiveCount: 0,
        falseNegativeCount: 0,
        falsePositiveRate: 1,
        falseNegativeRate: 1,
        latencyP95Ms: percentile(latencies, 95),
        passed: false,
        reason: "Waiting for the required real-audio blind test set.",
        waitingForRealData: true
      };
    }

    let falsePositiveCount = 0;
    let falseNegativeCount = 0;
    for (const sample of positive) {
      const score = this.verifier.score(macroId, sample.audio);
      if (score === null || score.confidence <= 0.25) {
        falseNegativeCount += 1;
      }
    }
    for (const sample of negative) {
      const score = this.verifier.score(macroId, sample.audio);
      if (score !== null && score.confidence > 0.25) {
        falsePositiveCount += 1;
      }
    }

    const falsePositiveRate = falsePositiveCount / negative.length;
    const falseNegativeRate = falseNegativeCount / positive.length;
    const latencyP95Ms = percentile(latencies, 95);
    const passed =
      falsePositiveRate <= VOICE_ACCEPTANCE_CRITERIA.maxFalsePositiveRate &&
      falseNegativeRate <= VOICE_ACCEPTANCE_CRITERIA.maxFalseNegativeRate &&
      latencyP95Ms <= VOICE_ACCEPTANCE_CRITERIA.maxLatencyP95Ms;

    if (passed) {
      const evaluation: VoiceBlindEvaluation = {
        falsePositiveCount,
        falseNegativeCount,
        totalCount: positive.length + negative.length,
        passed,
        reason: "Real-audio blind evaluation passed."
      };
      const status = this.verifier.markProven(macroId, evaluation);
      return {
        macroId,
        positiveCount: positive.length,
        negativeCount: negative.length,
        falsePositiveCount,
        falseNegativeCount,
        falsePositiveRate,
        falseNegativeRate,
        latencyP95Ms,
        passed,
        reason: status.reason,
        waitingForRealData: false
      };
    }

    return {
      macroId,
      positiveCount: positive.length,
      negativeCount: negative.length,
      falsePositiveCount,
      falseNegativeCount,
      falsePositiveRate,
      falseNegativeRate,
      latencyP95Ms,
      passed: false,
      reason: "Blind evaluation did not meet acceptance criteria.",
      waitingForRealData: false
    };
  }
}
