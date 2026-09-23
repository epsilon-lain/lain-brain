import { MacroMatcher } from "./MacroMatcher";
import type { MacroDefinition } from "./MacroTypes";
import { analyzeVoiceSubmitTail } from "./VoiceSubmitTail";
import type { VoiceCandidate } from "./VoiceIntentBuffer";

export function voiceMacroHints(macros: readonly MacroDefinition[]): string[] {
  return macros.filter((macro) => macro.enabled)
    .flatMap((macro) => macro.patterns.map((pattern) =>
      pattern.kind === "parameterized" ? pattern.template : pattern.phrase
    ))
    .slice(0, 32);
}

export function findVoiceMacroCandidate(
  raw: string,
  cleaned: string,
  macros: readonly MacroDefinition[],
  suggested?: string | null
): VoiceCandidate | null {
  const tail = analyzeVoiceSubmitTail(raw);
  if (tail.kind === "uncertain") {
    // Repeated ASR guesses such as "Cut. Cut." are one standalone ka
    // candidate, not a body followed by a command.
    const repeated = tail.body.toLocaleLowerCase()
      .replace(/[\s.!?。！？]+$/gu, "").trim() ===
      tail.candidate.toLocaleLowerCase();
    const body = repeated ? "" : tail.body;
    const command = body ? `${body} ka` : "ka";
    const match = new MacroMatcher(macros).match(command);
    return match.kind === "match" &&
      match.macro.actions.some((action) => action.kind === "submit_to_brain")
      ? { command, candidate: tail.candidate, body } : null;
  }

  if (cleaned !== raw) {
    const match = new MacroMatcher(macros).match(cleaned);
    if (match.kind === "match") {
      return { command: cleaned, candidate: cleaned, body: "" };
    }
  }
  if (typeof suggested === "string" && suggested.length <= 160) {
    const match = new MacroMatcher(macros).match(suggested);
    if (match.kind === "match") {
      return { command: suggested, candidate: suggested, body: "" };
    }
  }
  return null;
}
