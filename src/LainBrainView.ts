import {
  ItemView,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import {
  askDeepSeek,
  DeepSeekNoteContext
} from "./DeepSeekClient";

export const VIEW_TYPE_LAIN_BRAIN = "lain-brain-view";

export class LainBrainView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private getApiKey: () => string
  ) {
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

  private getActiveMarkdownFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();

    if (file === null || file.extension !== "md") {
      return null;
    }

    return file;
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();

    this.contentEl.createEl("h2", {
      text: "Lain Brain"
    });

    this.contentEl.createEl("p", {
      text: "Build a personal knowledge model with your notes."
    });

    const noteLabel = this.contentEl.createEl("small");
    noteLabel.style.display = "block";

    const updateNoteLabel = (): void => {
      const file = this.getActiveMarkdownFile();

      noteLabel.setText(
        file === null
          ? "No active note"
          : `Using note: ${file.basename}`
      );
    };

    updateNoteLabel();
    this.registerEvent(
      this.app.workspace.on("file-open", updateNoteLabel)
    );

    const input = this.contentEl.createEl("textarea");
    input.placeholder = "Tell Lain Brain what you are thinking...";
    input.rows = 6;
    input.style.width = "100%";

    const button = this.contentEl.createEl("button", {
      text: "Ask"
    });

    const answer = this.contentEl.createEl("p");

    button.addEventListener("click", async () => {
      const message = input.value.trim();

      if (message === "") {
        answer.setText("Please write something first.");
        return;
      }

      answer.setText("Thinking...");

      const apiKey = this.getApiKey().trim();

      if (apiKey === "") {
        answer.setText(
          "Please add your DeepSeek API key in Lain Brain settings."
        );
        return;
      }

      try {
        const file = this.getActiveMarkdownFile();
        let noteContext: DeepSeekNoteContext | undefined;

        updateNoteLabel();

        if (file !== null) {
          noteContext = {
            title: file.basename,
            content: await this.app.vault.cachedRead(file)
          };
        }

        const response = await askDeepSeek(
          apiKey,
          message,
          noteContext
        );
        answer.setText(response);
      } catch {
        answer.setText(
          "Unable to get an answer from DeepSeek. Please try again."
        );
      }
    });
  }
}
