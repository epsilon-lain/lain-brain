import {
  ItemView,
  setIcon,
  WorkspaceLeaf
} from "obsidian";
import { LainBrainChatPanel } from "./LainBrainChatPanel";
import { LainBrainMarkdownRenderBatch } from "./LainBrainMarkdownRenderer";
import type {
  LainBrainLargeViewMode,
  LainBrainSession
} from "./LainBrainSession";

export const VIEW_TYPE_LAIN_BRAIN_LARGE =
  "lain-brain-large-view";

export class LainBrainLargeView extends ItemView {
  private chatPanel?: LainBrainChatPanel;
  private unsubscribe?: () => void;
  private renderedMode?: LainBrainLargeViewMode;
  private renderedCandidateMarkdown = "";
  private renderedCandidateLoading = false;
  private renderedCandidateError: string | null = null;
  private readonly candidateMarkdownRenderer:
    LainBrainMarkdownRenderBatch;

  constructor(
    leaf: WorkspaceLeaf,
    private session: LainBrainSession,
    private closeLargeView: () => Promise<void>
  ) {
    super(leaf);
    this.candidateMarkdownRenderer =
      new LainBrainMarkdownRenderBatch(this.app);
  }

  getViewType(): string {
    return VIEW_TYPE_LAIN_BRAIN_LARGE;
  }

  getDisplayText(): string {
    return "Lain Brain Chat";
  }

  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.session.subscribe(() => {
      this.renderIfNeeded();
    });
    this.renderIfNeeded(true);
  }

  async onClose(): Promise<void> {
    this.chatPanel?.destroy();
    this.chatPanel = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.candidateMarkdownRenderer.destroy();
  }

  private renderIfNeeded(force = false): void {
    const mode = this.session.largeViewMode;

    if (mode === "chat") {
      if (force || this.renderedMode !== "chat") {
        this.renderChat();
      }
      return;
    }

    if (
      force ||
      this.renderedMode !== "candidate" ||
      this.renderedCandidateMarkdown !==
        this.session.candidateNoteMarkdown ||
      this.renderedCandidateLoading !==
        this.session.candidateLoading ||
      this.renderedCandidateError !==
        this.session.candidateError
    ) {
      this.renderCandidate();
    }
  }

  private prepareContent(titleText: string): HTMLDivElement {
    this.chatPanel?.destroy();
    this.chatPanel = undefined;
    this.candidateMarkdownRenderer.destroy();
    this.contentEl.empty();
    this.contentEl.style.display = "flex";
    this.contentEl.style.flexDirection = "column";
    this.contentEl.style.height = "100%";
    this.contentEl.style.minHeight = "0";

    const header = this.contentEl.createDiv();
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.marginBottom = "0.75rem";

    const title = header.createEl("h2", {
      text: titleText
    });
    title.style.margin = "0";
    title.style.fontFamily = "var(--font-monospace)";

    const collapseButton = header.createEl("button");
    setIcon(collapseButton, "minus");
    collapseButton.setAttr(
      "aria-label",
      "Close large Lain Brain view"
    );
    collapseButton.style.width = "14px";
    collapseButton.style.height = "14px";
    collapseButton.style.display = "inline-flex";
    collapseButton.style.alignItems = "center";
    collapseButton.style.justifyContent = "center";
    collapseButton.style.padding = "0";
    collapseButton.style.border = "none";
    collapseButton.style.borderRadius = "50%";
    collapseButton.style.backgroundColor = "#7c3aed";
    collapseButton.style.color = "#ffffff";
    collapseButton.style.fontSize = "12px";
    collapseButton.style.lineHeight = "1";
    collapseButton.style.boxSizing = "border-box";
    collapseButton.style.cursor = "pointer";

    const collapseIcon = collapseButton.querySelector("svg");

    if (collapseIcon !== null) {
      collapseIcon.style.width = "12px";
      collapseIcon.style.height = "12px";
    }

    collapseButton.addEventListener("click", () => {
      void this.closeLargeView();
    });

    const body = this.contentEl.createDiv();
    body.style.flex = "1";
    body.style.minHeight = "0";

    return body;
  }

  private renderChat(): void {
    const chatContainer = this.prepareContent("Lain Brain");

    this.renderedMode = "chat";
    this.chatPanel = new LainBrainChatPanel(
      this.app,
      chatContainer,
      this.session,
      true
    );
    this.chatPanel.focus();
  }

  private renderCandidate(): void {
    const candidateContainer =
      this.prepareContent("候选笔记");

    this.renderedMode = "candidate";
    this.renderedCandidateMarkdown =
      this.session.candidateNoteMarkdown;
    this.renderedCandidateLoading =
      this.session.candidateLoading;
    this.renderedCandidateError =
      this.session.candidateError;

    candidateContainer.style.display = "flex";
    candidateContainer.style.flexDirection = "column";
    candidateContainer.style.minHeight = "0";

    if (this.session.candidateLoading) {
      candidateContainer.createEl("p", {
        text: "brain> 正在整理候选笔记..."
      });
    }

    if (this.session.candidateError !== null) {
      candidateContainer.createEl("p", {
        text: this.session.candidateError
      });
    }

    const previewEl = candidateContainer.createDiv();
    previewEl.addClass("markdown-rendered");
    previewEl.style.flex = "1";
    previewEl.style.minHeight = "0";
    previewEl.style.overflowY = "auto";
    previewEl.style.padding = "1rem";

    if (!this.session.hasCandidateNote) {
      previewEl.setText("尚无候选笔记。");
      return;
    }

    this.candidateMarkdownRenderer.reset();
    this.candidateMarkdownRenderer.render(
      this.session.candidateNoteMarkdown,
      previewEl,
      this.session.activeNoteSourcePath
    );
  }
}
