/** Ephemeral per-turn interpretation. No transcript is persisted by this layer. */
export interface VoiceAnalysis {
  cleanedText: string;
  possibleMacro: boolean;
  candidateText?: string | null;
}

export type VoiceDecision =
  | { kind: "text"; text: string; scores: VoiceIntentScores }
  | { kind: "command"; text: string; source: "exact" | "classified"; scores: VoiceIntentScores }
  | { kind: "voice_ambiguous"; text: string; scores: VoiceIntentScores }
  | { kind: "review"; raw: string; command: string;
      candidate: string; body: string };

export interface VoiceIntentScores {
  readonly macroSimilarity: number;
  readonly turnIndependence: number;
  readonly contextSurprise: number;
  readonly temporalContext: number;
  readonly total: number;
}

export interface VoiceCandidate {
  command: string;
  candidate: string;
  body: string;
}

export interface VoiceIntentServices {
  clean: (raw: string, macroHints: readonly string[]) => Promise<VoiceAnalysis>;
  classify: (
    raw: string,
    cleaned: string,
    command: string,
    context: VoiceIntentContext
  ) =>
    Promise<"command" | "text" | "uncertain">;
}

export interface VoiceIntentContext {
  readonly previousBody: string;
  readonly macroHints: readonly string[];
  readonly audioAvailable: boolean;
}

const normalize = (text: string): string => text.normalize("NFKC")
  .trim().replace(/[。！？!?，,；;：:.\s]+$/gu, "")
  .trim().toLowerCase();

function isStandaloneUtterance(text: string): boolean {
  const compact = text
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}]/gu, "");
  return compact.length > 0 && compact.length <= 24 && !/\s/u.test(text.trim());
}

function contextSurpriseScore(previousBody: string, raw: string): number {
  if (previousBody.trim() === "") {
    return 0;
  }
  const previousTokens = new Set(previousBody
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== ""));
  const rawTokens = raw
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "");
  const overlap = rawTokens.filter((token) => previousTokens.has(token)).length;
  return overlap === 0 && rawTokens.length <= 3 ? 0.7 : 0.2;
}

/** Limit the entire post-final interpretation, including slow providers. */
function within<T>(promise: Promise<T>, milliseconds: number):
  Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(0, milliseconds));
    promise.then((result) => {
      clearTimeout(timer);
      resolve(result);
    }, () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

export class VoiceIntentBuffer {
  private prepared: { key: string; result: Promise<VoiceAnalysis> } | null = null;
  constructor(
    private readonly services: VoiceIntentServices,
    private readonly isExactMacro: (text: string) => boolean,
    private readonly findCandidate: (raw: string, cleaned: string,
      suggested?: string | null) =>
      VoiceCandidate | null,
    private readonly macroHints: () => readonly string[],
    private readonly getContext: () => VoiceIntentContext,
    private readonly hasEnabledUserMacro: () => boolean
  ) {}

  prewarm(partial: string): void {
    const key = normalize(partial);
    // One speculative request per turn; streaming partials can change often.
    if (!key || this.prepared !== null) return;
    const result = this.services.clean(partial.trim(), this.macroHints());
    // A discarded partial may fail after finalization; settle it safely.
    void result.catch(() => {});
    this.prepared = { key, result };
  }

  clear(): void {
    this.prepared = null;
  }

  async interpret(raw: string, budgetMs = 1_800): Promise<VoiceDecision> {
    const started = Date.now();
    const original = raw.trim();
    if (!original) {
      return {
        kind: "text",
        text: "",
        scores: {
          macroSimilarity: 0,
          turnIndependence: 0,
          contextSurprise: 0,
          temporalContext: 0,
          total: 0
        }
      };
    }
    const standalone = isStandaloneUtterance(original);
    const scores = (macroSimilarity: number): VoiceIntentScores => {
      const context = this.getContext();
      const surprise = contextSurpriseScore(context.previousBody, original);
      const temporal = this.getContext().macroHints.length > 0 ? 0.15 : 0;
      return {
        macroSimilarity,
        turnIndependence: standalone ? 1 : 0.2,
        contextSurprise: surprise,
        temporalContext: temporal,
        total: macroSimilarity * 0.55 +
          (standalone ? 1 : 0.2) * 0.2 +
          surprise * 0.15 +
          temporal * 0.1
      };
    };

    // Explicit standalone commands need no network round trip.
    if (this.isExactMacro(original)) {
      this.clear();
      return { kind: "command", text: original, source: "exact", scores: scores(1) };
    }

    if (this.hasEnabledUserMacro()) {
      this.clear();
      return { kind: "voice_ambiguous", text: original, scores: scores(0) };
    }

    const prepared = this.prepared?.key === normalize(original)
      ? this.prepared.result : null;
    this.prepared = null;
    const analysis = await within(
      prepared ?? this.services.clean(original, this.macroHints()), budgetMs
    );
    const cleaned = analysis?.cleanedText.trim() || original;
    const proposed = this.findCandidate(original, cleaned,
      analysis?.possibleMacro ? analysis.candidateText : undefined);
    if (proposed === null) {
      return { kind: "text", text: cleaned, scores: scores(0) };
    }

    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) {
      return { kind: "text", text: original, scores: scores(0.6) };
    }
    const decision = await within(
      this.services.classify(
        original,
        cleaned,
        proposed.command,
        this.getContext()
      ),
      remaining
    );
    if (decision === "command") {
      return { kind: "command", text: proposed.command, source: "classified", scores: scores(0.95) };
    }
    return { kind: "text", text: original, scores: scores(0.6) };
  }
}
