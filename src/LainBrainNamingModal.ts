import { App, Modal, Setting } from "obsidian";
import {
  MAX_DISPLAY_NAME_LENGTH,
  validateDisplayName
} from "./PersonalNaming";

export class LainBrainNamingModal extends Modal {
  private userName: string;
  private brainName: string;
  private settled = false;
  private errorEl?: HTMLElement;

  constructor(
    app: App,
    initialUserName: string,
    initialBrainName: string,
    private saveNames: (
      userName: string,
      brainName: string
    ) => Promise<string | null>,
    private skipNaming: () => void
  ) {
    super(app);
    this.userName = initialUserName;
    this.brainName = initialBrainName;
  }

  onOpen(): void {
    this.titleEl.setText("Welcome to Lain Brain");

    new Setting(this.contentEl)
      .setName("What should I call you?")
      .addText((text) => {
        text.inputEl.maxLength = MAX_DISPLAY_NAME_LENGTH;
        text.setValue(this.userName).onChange((value) => {
          this.userName = value;
          this.clearError();
        });
      });

    new Setting(this.contentEl)
      .setName("What should I call your brain?")
      .addText((text) => {
        text.inputEl.maxLength = MAX_DISPLAY_NAME_LENGTH;
        text.setValue(this.brainName).onChange((value) => {
          this.brainName = value;
          this.clearError();
        });
      });

    this.errorEl = this.contentEl.createEl("p");
    this.errorEl.style.color = "var(--text-error)";

    const actions = this.contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "0.5rem";
    actions.style.marginTop = "1rem";

    const startButton = actions.createEl("button", {
      text: "Start building"
    });
    startButton.addClass("mod-cta");
    startButton.addEventListener("click", () => {
      void this.submit();
    });

    const skipButton = actions.createEl("button", {
      text: "Skip for now"
    });
    skipButton.addEventListener("click", () => {
      this.settled = true;
      this.skipNaming();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();

    if (!this.settled) {
      this.settled = true;
      this.skipNaming();
    }
  }

  private async submit(): Promise<void> {
    const user = validateDisplayName(this.userName, "Your name");

    if (!user.ok) {
      this.showError(user.error);
      return;
    }

    const brain = validateDisplayName(this.brainName, "Brain name");

    if (!brain.ok) {
      this.showError(brain.error);
      return;
    }

    const error = await this.saveNames(user.value, brain.value);

    if (error !== null) {
      this.showError(error);
      return;
    }

    this.settled = true;
    this.close();
  }

  private showError(message: string): void {
    this.errorEl?.setText(message);
  }

  private clearError(): void {
    this.errorEl?.setText("");
  }
}
