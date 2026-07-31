import type { LainBrainSession } from "./LainBrainSession";

export class LainBrainChatPanel {
  private readonly transcriptEl: HTMLDivElement;
  private readonly messagesEl: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly noteLabel: HTMLElement;
  private readonly unsubscribe: () => void;
  private renderedMessageCount = -1;
  private renderedLoadingMode: string | null = null;

  constructor(
    private containerEl: HTMLElement,
    private session: LainBrainSession,
    large: boolean
  ) {
    this.containerEl.empty();

    if (large) {
      this.containerEl.style.display = "flex";
      this.containerEl.style.flexDirection = "column";
      this.containerEl.style.height = "100%";
      this.containerEl.style.minHeight = "0";
    }

    this.noteLabel = this.containerEl.createEl("small");
    this.noteLabel.style.display = "block";
    this.noteLabel.style.marginBottom = "0.5rem";

    this.transcriptEl = this.containerEl.createDiv();
    this.transcriptEl.style.overflowY = "auto";
    this.transcriptEl.style.padding = large ? "1rem" : "0.75rem";
    this.transcriptEl.style.whiteSpace = "pre-wrap";
    this.transcriptEl.style.fontFamily = "var(--font-monospace)";
    this.transcriptEl.style.backgroundColor = large
      ? "#0c0c0c"
      : "var(--background-secondary)";
    this.transcriptEl.style.color = large
      ? "#d4d4d4"
      : "var(--text-normal)";
    this.transcriptEl.style.border = large
      ? "1px solid #333333"
      : "1px solid var(--background-modifier-border)";
    this.transcriptEl.style.borderRadius = "4px";

    if (large) {
      this.transcriptEl.style.flex = "1";
      this.transcriptEl.style.minHeight = "0";
    } else {
      this.transcriptEl.style.height = "320px";
    }

    this.messagesEl = this.transcriptEl.createDiv();

    const inputLine = this.transcriptEl.createDiv();
    inputLine.style.display = "flex";
    inputLine.style.alignItems = "flex-start";
    inputLine.style.paddingTop = "0.25rem";
    inputLine.style.backgroundColor = large
      ? "#0c0c0c"
      : "var(--background-secondary)";

    const inputPrefix = inputLine.createSpan({
      text: "lain> "
    });
    inputPrefix.style.flexShrink = "0";
    inputPrefix.style.color = large ? "#c586c0" : "inherit";

    this.input = inputLine.createEl("textarea");
    this.input.rows = 1;
    this.input.setAttr("aria-label", "Message Lain Brain");
    this.input.style.flex = "1";
    this.input.style.width = "100%";
    this.input.style.minHeight = "1.5em";
    this.input.style.height = "auto";
    this.input.style.padding = "0";
    this.input.style.margin = "0";
    this.input.style.border = "none";
    this.input.style.outline = "none";
    this.input.style.boxShadow = "none";
    this.input.style.resize = "none";
    this.input.style.overflowY = "hidden";
    this.input.style.background = "transparent";
    this.input.style.color = "inherit";
    this.input.style.caretColor = "currentColor";
    this.input.style.font = "inherit";
    this.input.style.lineHeight = "inherit";
    this.input.style.whiteSpace = "pre-wrap";
    this.input.style.overflowWrap = "anywhere";

    this.input.addEventListener("input", () => {
      this.session.setDraft(this.input.value);
      this.resizeInput();
    });

    this.input.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing
      ) {
        event.preventDefault();
        void this.session.send().finally(() => {
          this.input.focus();
        });
      }
    });

    this.unsubscribe = this.session.subscribe(() => {
      this.render();
    });

    this.render();
  }

  destroy(): void {
    this.unsubscribe();
  }

  focus(): void {
    this.input.focus();
  }

  private render(): void {
    const messages = this.session.getTranscriptMessages();
    const loadingMode = this.session.loadingMode;

    this.noteLabel.setText(this.session.activeNoteLabel);

    if (
      this.renderedMessageCount !== messages.length ||
      this.renderedLoadingMode !== loadingMode
    ) {
      this.messagesEl.empty();

      for (const message of messages) {
        this.addTranscriptLine(message.role, message.content);
      }

      if (loadingMode === "chat") {
        this.addTranscriptLine("assistant", "Thinking...");
      }

      this.renderedMessageCount = messages.length;
      this.renderedLoadingMode = loadingMode;
      this.scrollToNewestMessage();
    }

    if (this.input.value !== this.session.draft) {
      this.input.value = this.session.draft;
      this.resizeInput();
    }

    this.input.readOnly = this.session.loading;
  }

  private addTranscriptLine(
    role: "user" | "assistant",
    content: string
  ): void {
    const prefix = role === "user" ? "lain" : "brain";
    const line = this.messagesEl.createDiv();

    line.style.marginBottom = "0.5rem";
    line.setText(`${prefix}> ${content}`);
  }

  private resizeInput(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${this.input.scrollHeight}px`;
    this.scrollToNewestMessage();
  }

  private scrollToNewestMessage(): void {
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }
}
