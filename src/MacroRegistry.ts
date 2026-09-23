import { MACRO_SCHEMA_VERSION, validateMacroDefinition } from "./MacroTypes";
import type { MacroDefinition } from "./MacroTypes";

export interface StoredMacroRegistry {
  readonly schemaVersion: number;
  readonly macros: readonly MacroDefinition[];
  readonly definitionPhrase: string;
}

export const DEFAULT_KA_MACRO: MacroDefinition = {
  id: "builtin-ka",
  name: "Submit Chat Space",
  patterns: [{ kind: "trailing", phrase: "ka" }],
  parameters: [],
  actions: [{ kind: "submit_to_brain" }],
  writesToChat: false,
  undoable: false,
  confirmation: { kind: "never" },
  enabled: true,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
  schemaVersion: MACRO_SCHEMA_VERSION
};

export function migrateMacroRegistry(value: unknown): StoredMacroRegistry {
  const input = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const macros = Array.isArray(input.macros)
    ? input.macros.map(validateMacroDefinition).filter((macro): macro is MacroDefinition => macro !== null)
    : [];
  const withoutKa = macros.filter((macro) => macro.id !== DEFAULT_KA_MACRO.id);
  return {
    schemaVersion: MACRO_SCHEMA_VERSION,
    macros: [DEFAULT_KA_MACRO, ...withoutKa],
    definitionPhrase: typeof input.definitionPhrase === "string" && input.definitionPhrase.trim() !== ""
      ? input.definitionPhrase.trim()
      : "定义宏"
  };
}

export class MacroRegistry {
  private state: StoredMacroRegistry;
  constructor(initial?: unknown) { this.state = migrateMacroRegistry(initial); }
  get macros(): readonly MacroDefinition[] { return this.state.macros; }
  get definitionPhrase(): string { return this.state.definitionPhrase; }
  replace(macro: MacroDefinition): void {
    const next = this.state.macros.filter((item) => item.id !== macro.id);
    this.state = { ...this.state, macros: [...next, macro] };
  }
  disable(id: string): boolean {
    const macro = this.state.macros.find((item) => item.id === id);
    if (macro === undefined || macro.id === DEFAULT_KA_MACRO.id) return false;
    this.replace({ ...macro, enabled: false, updatedAt: new Date().toISOString() });
    return true;
  }
  setDefinitionPhrase(phrase: string): boolean {
    if (phrase.trim() === "") return false;
    this.state = { ...this.state, definitionPhrase: phrase.trim() };
    return true;
  }
  serialize(): StoredMacroRegistry { return { ...this.state, macros: [...this.state.macros] }; }
}
