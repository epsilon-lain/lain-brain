import { ItemView, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_LAIN_BRAIN = "lain-brain-view";

export class LainBrainView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_LAIN_BRAIN;
  }

  getDisplayText(): string {
    return "Lain Brain";
  }

  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();

    this.contentEl.createEl("h2", {
      text: "Lain Brain"
    });

    this.contentEl.createEl("p", {
      text: "Build a personal knowledge model with your notes."
    });

    const input = this.contentEl.createEl("textarea");
    input.placeholder = "Tell Lain Brain what you are thinking...";
    input.rows = 6;
    input.style.width = "100%";

    const button = this.contentEl.createEl("button", {
      text: "Ask"
    });

    const answer = this.contentEl.createEl("p");

    button.addEventListener("click", () => {
      const message = input.value.trim();

      if (message === "") {
        answer.setText("Please write something first.");
        return;
      }

      answer.setText(`Lain Brain heard: ${message}`);
    });
  }
}