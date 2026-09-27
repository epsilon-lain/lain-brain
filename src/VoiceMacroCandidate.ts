import { MacroMatcher } from "./MacroMatcher";
import type { MacroDefinition } from "./MacroTypes";
import type { VoiceCandidate } from "./VoiceIntentBuffer";

export function voiceMacroHints(macros: readonly MacroDefinition[]): string[] {
  return macros.filter((macro) => macro.enabled)
    .flatMap((macro) => macro.patterns.map((pattern) =>
      pattern.kind === "parameterized" ? pattern.template : pattern.phrase
    ))
    .slice(0, 32);
}

/**
 * A text-side candidate must match an enabled registered macro. It is only a
 * hint; audio verification is the execution gate. No fixed spelling table is
 * used here.
 */
export function findVoiceMacroCandidate(
  raw: string,
  cleaned: string,
  macros: readonly MacroDefinition[],
  suggested?: string | null
): VoiceCandidate | null {
  const candidates: string[] = [];
  if (cleaned !== raw) {
    candidates.push(cleaned);
  }
  if (
    typeof suggested === "string" &&
    suggested.length <= 160
  ) {
    candidates.push(suggested);
  }

  for (const candidate of candidates) {
    const match = new MacroMatcher(macros).match(candidate);
    if (match.kind === "match") {
      return { command: candidate, candidate, body: "" };
    }
  }
  return null;
}
