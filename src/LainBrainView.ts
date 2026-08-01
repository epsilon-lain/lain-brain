import {
  ItemView,
  TFile,
  TFolder,
  WorkspaceLeaf
} from "obsidian";
import {
  askDeepSeek,
  createKnowledgeNode
} from "./DeepSeekClient";
import type {
  DeepSeekConversationMessage,
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

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);

    if (existing === null) {
      await this.app.vault.createFolder(path);
      return;
    }

    if (!(existing instanceof TFolder)) {
      throw new Error(`A file already exists at ${path}.`);
    }
  }

  private getAvailableDraftPath(created: Date): string {
    const filename = created
      .toISOString()
      .replace(/[:.]/g, "-");
    let suffix = 0;

    while (true) {
      const suffixText = suffix === 0 ? "" : `-${suffix}`;
      const path =
        `Lain Brain/Drafts/${filename}${suffixText}.md`;

      if (this.app.vault.getAbstractFileByPath(path) === null) {
        return path;
      }

      suffix += 1;
    }
  }

  private async createDraftNote(
    body: string,
    noteContext?: DeepSeekNoteContext
  ): Promise<TFile> {
    await this.ensureFolder("Lain Brain");
    await this.ensureFolder("Lain Brain/Drafts");

    const created = new Date();
    const path = this.getAvailableDraftPath(created);
    const sourceNote = noteContext === undefined
      ? ""
      : `[[${noteContext.title}]]`;
    const content =
      "---\n" +
      "lain_brain_status: draft\n" +
      `source_note: ${JSON.stringify(sourceNote)}\n` +
      `created: ${created.toISOString()}\n` +
      "---\n\n" +
      `${body.trim()}\n`;

    return this.app.vault.create(path, content);
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();

    this.contentEl.createEl("h2", {
      text: "Lain Brain"
    });

    this.contentEl.createEl("p", {
      text: "Build a personal knowledge model with your notes."
    });

    const conversationEl = this.contentEl.createDiv();
    conversationEl.style.height = "320px";
    conversationEl.style.overflowY = "auto";
    conversationEl.style.padding = "0.75rem";
    conversationEl.style.marginBottom = "0.75rem";
    conversationEl.style.whiteSpace = "pre-wrap";
    conversationEl.style.fontFamily = "var(--font-monospace)";
    conversationEl.style.backgroundColor =
      "var(--background-secondary)";
    conversationEl.style.border =
      "1px solid var(--background-modifier-border)";

    const conversationHistory: DeepSeekConversationMessage[] = [];

    const scrollToNewestMessage = (): void => {
      conversationEl.scrollTop = conversationEl.scrollHeight;
    };

    const addConversationLine = (
      role: "user" | "assistant",
      content: string
    ): HTMLDivElement => {
      const line = conversationEl.createDiv();
      const prefix = role === "user" ? "lain" : "brain";

      line.style.marginBottom = "0.5rem";
      line.setText(`${prefix}> ${content}`);
      scrollToNewestMessage();

      return line;
    };

    const organizeButton = this.contentEl.createEl("button", {
      text: "整理为候选节点"
    });
    const organizeStatus = this.contentEl.createEl("p");
    let latestNoteContext: DeepSeekNoteContext | undefined;

    organizeButton.style.display = "none";

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

    const setBusy = (busy: boolean): void => {
      button.disabled = busy;
      input.disabled = busy;
      organizeButton.disabled = busy;
    };

    const sendMessage = async (): Promise<void> => {
      if (button.disabled) {
        return;
      }

      const message = input.value.trim();

      if (message === "") {
        addConversationLine(
          "assistant",
          "Please write something first."
        );
        return;
      }

      const apiKey = this.getApiKey().trim();

      if (apiKey === "") {
        addConversationLine(
          "assistant",
          "Please add your DeepSeek API key in Lain Brain settings."
        );
        return;
      }

      latestNoteContext = undefined;
      organizeButton.style.display = "none";
      organizeStatus.empty();

      conversationHistory.push({
        role: "user",
        content: message
      });
      addConversationLine("user", message);
      input.value = "";
      setBusy(true);

      const thinkingLine = addConversationLine(
        "assistant",
        "Thinking..."
      );

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
          conversationHistory,
          noteContext
        );

        conversationHistory.push({
          role: "assistant",
          content: response
        });
        thinkingLine.setText(`brain> ${response}`);
        latestNoteContext = noteContext;
        organizeButton.style.display = "inline-block";
      } catch {
        thinkingLine.setText(
          "brain> Unable to get an answer from DeepSeek. " +
          "Please try again."
        );
      } finally {
        setBusy(false);
        input.focus();
        scrollToNewestMessage();
      }
    };

    button.addEventListener("click", () => {
      void sendMessage();
    });

    input.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing
      ) {
        event.preventDefault();
        void sendMessage();
      }
    });

    organizeButton.addEventListener("click", async () => {
      if (
        conversationHistory.length === 0 ||
        organizeButton.disabled
      ) {
        return;
      }

      const apiKey = this.getApiKey().trim();

      if (apiKey === "") {
        organizeStatus.setText(
          "Please add your DeepSeek API key in Lain Brain settings."
        );
        return;
      }

      const historySnapshot = conversationHistory.map((message) => ({
        ...message
      }));

      setBusy(true);
      organizeStatus.setText("Organizing draft...");

      try {
        const body = await createKnowledgeNode(
          apiKey,
          historySnapshot,
          latestNoteContext
        );
        const draftFile = await this.createDraftNote(
          body,
          latestNoteContext
        );

        organizeStatus.setText("Draft created.");
        await this.app.workspace
          .getLeaf("tab")
          .openFile(draftFile);
      } catch {
        organizeStatus.setText(
          "Unable to create a draft node. Please try again."
        );
      } finally {
        setBusy(false);
        input.focus();
      }
    });
  }
}
