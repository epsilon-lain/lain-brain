/** Ephemeral per-turn interpretation. No transcript is persisted by this layer. */
export interface VoiceAnalysis {
  cleanedText: string;
  possibleMacro: boolean;
  candidateText?: string | null;
}

export type VoiceDecision =
  | { kind: "text"; text: string }
  | { kind: "command"; text: string }
  | { kind: "review"; raw: string; command: string;
      candidate: string; body: string };

export interface VoiceCandidate {
  command: string;
  candidate: string;
  body: string;
}

export interface VoiceIntentServices {
  clean: (raw: string, macroHints: readonly string[]) => Promise<VoiceAnalysis>;
  classify: (raw: string, cleaned: string, command: string) =>
    Promise<"command" | "text" | "uncertain">;
}

const normalize = (text: string): string => text.normalize("NFKC")
  .trim().replace(/[。！？!?，,；;：:.\s]+$/gu, "")
  .trim().toLowerCase();

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
    private readonly macroHints: () => readonly string[]
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
    if (!original) return { kind: "text", text: "" };

    // Explicit standalone commands need no network round trip.
    if (this.isExactMacro(original)) {
      this.clear();
      return { kind: "command", text: original };
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
      return { kind: "text", text: cleaned };
    }

    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) {
      return { kind: "review", raw: original,
        command: proposed.command, candidate: proposed.candidate,
        body: proposed.body };
    }
    const decision = await within(
      this.services.classify(original, cleaned, proposed.command), remaining
    );
    if (decision === "command") {
      return { kind: "command", text: proposed.command };
    }
    if (decision === "text") return { kind: "text", text:
      this.isExactMacro(cleaned) ? original : cleaned };
    return { kind: "review", raw: original,
      command: proposed.command, candidate: proposed.candidate,
      body: proposed.body };
  }
}
