export const MACRO_SCHEMA_VERSION = 1 as const;

export type MacroPattern =
  | { readonly kind: "exact"; readonly phrase: string }
  | {
      readonly kind: "parameterized";
      readonly template: string;
      readonly parameters: readonly MacroParameter[];
    }
  | { readonly kind: "trailing"; readonly phrase: string };

export interface MacroParameter {
  readonly name: string;
  readonly type: "integer" | "text";
  readonly min?: number;
  readonly max?: number;
}

export type MacroAction =
  | { readonly kind: "submit_to_brain" }
  | { readonly kind: "delete_segment"; readonly segmentId?: string; readonly line?: number | { readonly parameter: string } }
  | { readonly kind: "replace_segment"; readonly segmentId?: string; readonly text: string }
  | { readonly kind: "truncate_from_segment"; readonly segmentId?: string }
  | { readonly kind: "mark_candidate_note"; readonly segmentId?: string }
  | { readonly kind: "unmark_candidate_note"; readonly segmentId?: string }
  | { readonly kind: "restore_last_step" }
  | { readonly kind: "insert_text"; readonly text: string; readonly afterSegmentId?: string };

export type MacroConfirmationPolicy =
  | { readonly kind: "never" }
  | { readonly kind: "always" }
  | { readonly kind: "destructive" };

export interface MacroDefinition {
  readonly id: string;
  readonly name: string;
  readonly patterns: readonly MacroPattern[];
  readonly parameters: readonly MacroParameter[];
  readonly actions: readonly MacroAction[];
  readonly writesToChat: boolean;
  readonly undoable: boolean;
  readonly confirmation: MacroConfirmationPolicy;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: number;
}

export interface MacroMatchResult {
  readonly kind: "match";
  readonly macro: MacroDefinition;
  readonly parameters: Readonly<Record<string, string | number>>;
  readonly normalizedText: string;
  readonly consumedText: string;
}

export type MacroMatchOutcome =
  | MacroMatchResult
  | { readonly kind: "none"; readonly normalizedText: string }
  | { readonly kind: "conflict"; readonly normalizedText: string; readonly macros: readonly MacroDefinition[] };

export function isMacroAction(value: unknown): value is MacroAction {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = (value as { kind: unknown }).kind;
  return typeof kind === "string" && new Set([
    "submit_to_brain", "delete_segment", "replace_segment", "truncate_from_segment",
    "mark_candidate_note", "unmark_candidate_note", "restore_last_step", "insert_text"
  ]).has(kind);
}

export function validateMacroDefinition(value: unknown): MacroDefinition | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || typeof input.name !== "string" ||
      !Array.isArray(input.patterns) || !Array.isArray(input.parameters) ||
      !Array.isArray(input.actions) || typeof input.createdAt !== "string" ||
      typeof input.updatedAt !== "string" || typeof input.enabled !== "boolean") return null;
  if (!input.patterns.every((pattern) => {
    if (typeof pattern !== "object" || pattern === null) return false;
    const kind = (pattern as { kind?: unknown }).kind;
    return kind === "exact" || kind === "trailing" || kind === "parameterized";
  }) || !input.actions.every(isMacroAction)) return null;
  const parameters = input.parameters.filter((item): item is MacroParameter => {
    if (typeof item !== "object" || item === null) return false;
    const parameter = item as Record<string, unknown>;
    return typeof parameter.name === "string" &&
      (parameter.type === "integer" || parameter.type === "text");
  });
  if (parameters.length !== input.parameters.length) return null;
  return Object.freeze({
    id: input.id,
    name: input.name,
    patterns: input.patterns as MacroPattern[],
    parameters,
    actions: input.actions as MacroAction[],
    writesToChat: input.writesToChat === true,
    undoable: input.undoable !== false,
    confirmation: input.confirmation === undefined
      ? { kind: "destructive" as const }
      : input.confirmation as MacroConfirmationPolicy,
    enabled: input.enabled,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    schemaVersion: typeof input.schemaVersion === "number" ? input.schemaVersion : MACRO_SCHEMA_VERSION
  });
}
