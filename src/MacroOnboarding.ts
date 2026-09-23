export type MacroOnboardingStep =
  | "intro"
  | "choose_definition_phrase"
  | "define_delete_macro"
  | "define_recover_macro"
  | "confirm"
  | "complete";

export class MacroOnboarding {
  private step: MacroOnboardingStep = "intro";
  private completed = false;

  get currentStep(): MacroOnboardingStep { return this.step; }
  get isComplete(): boolean { return this.completed; }

  begin(alreadyCompleted: boolean): boolean {
    if (alreadyCompleted) {
      this.completed = true;
      this.step = "complete";
      return false;
    }
    this.step = "intro";
    return true;
  }

  advance(): MacroOnboardingStep {
    const next: Record<MacroOnboardingStep, MacroOnboardingStep> = {
      intro: "choose_definition_phrase",
      choose_definition_phrase: "define_delete_macro",
      define_delete_macro: "define_recover_macro",
      define_recover_macro: "confirm",
      confirm: "complete",
      complete: "complete"
    };
    this.step = next[this.step];
    if (this.step === "complete") this.completed = true;
    return this.step;
  }

  cancel(): void { this.step = "intro"; }
}

export const MACRO_ONBOARDING_COPY: Readonly<Record<MacroOnboardingStep, string>> = {
  intro: "Chat Space accepts voice and keyboard input together. Press the recording button when you want to speak.",
  choose_definition_phrase: "ka submits Chat Space for now. Choose a separate phrase to enter macro definition mode.",
  define_delete_macro: "Describe a delete macro with a line number. Brain will show the exact action before saving it.",
  define_recover_macro: "Describe a recover macro. It can only restore the latest reversible local change.",
  confirm: "Review each macro preview and confirm with ka, Enter, or the button before saving.",
  complete: "Macro setup is complete. The definition phrase remains available in settings."
};
