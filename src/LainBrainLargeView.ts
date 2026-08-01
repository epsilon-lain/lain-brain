import {
  ItemView,
  Menu,
  setIcon,
  WorkspaceLeaf
} from "obsidian";
import { LainBrainChatPanel } from "./LainBrainChatPanel";
import { LainBrainMarkdownRenderBatch } from "./LainBrainMarkdownRenderer";
import type {
  LainBrainCandidateViewMode,
  LainBrainLargeViewMode,
  LainBrainSession
} from "./LainBrainSession";

export const VIEW_TYPE_LAIN_BRAIN_LARGE =
  "lain-brain-large-view";

export class LainBrainLargeView extends ItemView {
  private chatPanel?: LainBrainChatPanel;
  private candidateEditor?: HTMLTextAreaElement;
  private candidatePreviewEl?: HTMLDivElement;
  private unsubscribe?: () => void;
  private renderedMode?: LainBrainLargeViewMode;
  private renderedCandidateViewMode?: LainBrainCandidateViewMode;
  private renderedActiveCandidateId: string | null = null;
  private renderedCandidateListKey = "";
  private renderedCandidateMarkdown = "";
  private renderedCandidateLoading = false;
  private renderedCandidateError: string | null = null;
  private readonly candidateMarkdownRenderer:
    LainBrainMarkdownRenderBatch;

  constructor(
    leaf: WorkspaceLeaf,
    private session: LainBrainSession,
    private closeLargeView: () => Promise<void>,
    private openSidebarChat: () => Promise<void>
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
    this.candidateEditor = undefined;
    this.candidatePreviewEl = undefined;
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
      this.renderedActiveCandidateId !==
        this.session.activeCandidateId ||
      this.renderedCandidateListKey !==
        this.getCandidateListKey() ||
      this.renderedCandidateViewMode !==
        this.session.candidateViewMode ||
      this.renderedCandidateLoading !==
        this.session.candidateLoading ||
      this.renderedCandidateError !==
        this.session.candidateError
    ) {
      this.renderCandidate();
      return;
    }

    this.syncCandidateContent();
  }

  private prepareContent(titleText: string): HTMLDivElement {
    this.chatPanel?.destroy();
    this.chatPanel = undefined;
    this.candidateEditor = undefined;
    this.candidatePreviewEl = undefined;
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
    this.renderedCandidateViewMode =
      this.session.candidateViewMode;
    this.renderedActiveCandidateId =
      this.session.activeCandidateId;
    this.renderedCandidateListKey =
      this.getCandidateListKey();
    this.renderedCandidateMarkdown =
      this.session.candidateNoteMarkdown;
    this.renderedCandidateLoading =
      this.session.candidateLoading;
    this.renderedCandidateError =
      this.session.candidateError;

    candidateContainer.style.display = "flex";
    candidateContainer.style.flexDirection = "column";
    candidateContainer.style.height = "100%";
    candidateContainer.style.minHeight = "0";

    const candidates = this.session.getCandidateNotes();
    const activeCandidate = this.session.getActiveCandidate();
    const switcher = candidateContainer.createDiv();

    switcher.style.display = "flex";
    switcher.style.alignItems = "center";
    switcher.style.gap = "0.5rem";
    switcher.style.marginBottom = "0.6rem";

    switcher.createEl("label", {
      text: `候选笔记（${candidates.length}）`
    });

    const candidateSelect = switcher.createEl("select");
    candidateSelect.setAttr("aria-label", "选择候选笔记");
    candidateSelect.style.flex = "1";
    candidateSelect.style.minWidth = "0";
    candidateSelect.style.padding = "4px 8px";
    candidateSelect.style.backgroundColor =
      "var(--background-secondary)";
    candidateSelect.style.color = "var(--text-normal)";
    candidateSelect.style.border =
      "1px solid var(--background-modifier-border)";
    candidateSelect.style.borderRadius = "4px";
    candidateSelect.disabled = this.session.candidateLoading;

    for (const candidate of candidates) {
      const option = candidateSelect.createEl("option", {
        text:
          `${candidate.title} — ` +
          candidate.primaryConcept.name,
        value: candidate.id
      });
      option.selected =
        candidate.id === this.session.activeCandidateId;
    }

    candidateSelect.addEventListener("change", () => {
      this.session.setActiveCandidate(candidateSelect.value);
    });

    if (activeCandidate === undefined) {
      candidateContainer.createEl("p", {
        text: "暂无候选笔记。"
      });
      return;
    }

    const modeTabs = candidateContainer.createDiv();
    modeTabs.style.display = "flex";
    modeTabs.style.alignItems = "center";
    modeTabs.style.gap = "0.4rem";
    modeTabs.style.marginBottom = "0.75rem";

    this.createModeButton(modeTabs, "编辑", "edit");
    this.createModeButton(modeTabs, "预览", "preview");

    if (this.session.candidateLoading) {
      candidateContainer.createEl("p", {
        text: "brain> 正在整理候选笔记..."
      });
    }

    if (this.session.candidateError !== null) {
      const errorEl = candidateContainer.createEl("p", {
        text: this.session.candidateError
      });
      errorEl.style.color = "var(--text-error)";
    }

    const workspace = candidateContainer.createDiv();
    workspace.style.display = "flex";
    workspace.style.flex = "1";
    workspace.style.minHeight = "0";
    workspace.style.width = "100%";

    if (this.session.candidateViewMode === "edit") {
      this.renderCandidateEditor(workspace);
    } else {
      this.renderCandidatePreview(workspace);
    }
  }

  private createModeButton(
    container: HTMLElement,
    label: string,
    mode: LainBrainCandidateViewMode
  ): void {
    const selected = this.session.candidateViewMode === mode;
    const button = container.createEl("button", {
      text: label
    });

    button.setAttr("aria-pressed", selected ? "true" : "false");
    button.style.padding = "4px 10px";
    button.style.border =
      "1px solid var(--background-modifier-border)";
    button.style.borderRadius = "4px";
    button.style.backgroundColor = selected
      ? "var(--interactive-accent)"
      : "var(--background-secondary)";
    button.style.color = selected
      ? "var(--text-on-accent)"
      : "var(--text-normal)";
    button.style.fontWeight = selected ? "600" : "400";
    button.disabled = this.session.candidateLoading;

    button.addEventListener("click", () => {
      this.session.setCandidateViewMode(mode);
    });
  }

  private renderCandidateEditor(
    container: HTMLElement
  ): void {
    const editor = container.createEl("textarea");

    this.candidateEditor = editor;
    editor.value = this.session.candidateNoteMarkdown;
    editor.setAttr("aria-label", "编辑候选笔记 Markdown");
    editor.setAttr("wrap", "soft");
    editor.spellcheck = true;
    editor.disabled = this.session.candidateLoading;
    editor.style.width = "100%";
    editor.style.height = "100%";
    editor.style.minHeight = "0";
    editor.style.boxSizing = "border-box";
    editor.style.resize = "none";
    editor.style.overflow = "auto";
    editor.style.padding = "1rem";
    editor.style.border =
      "1px solid var(--background-modifier-border)";
    editor.style.borderRadius = "4px";
    editor.style.outline = "none";
    editor.style.backgroundColor = "var(--background-primary)";
    editor.style.color = "var(--text-normal)";
    editor.style.caretColor = "var(--text-normal)";
    editor.style.fontFamily = "var(--font-monospace)";
    editor.style.fontSize = "var(--font-text-size)";
    editor.style.lineHeight = "1.6";
    editor.style.tabSize = "2";
    editor.style.whiteSpace = "pre-wrap";
    editor.style.overflowWrap = "anywhere";

    editor.addEventListener("input", () => {
      this.renderedCandidateMarkdown = editor.value;
      this.session.setCandidateNoteMarkdown(editor.value);
    });

    editor.addEventListener("contextmenu", (event) => {
      const startOffset = editor.selectionStart;
      const endOffset = editor.selectionEnd;
      const selectedText = editor.value.slice(
        startOffset,
        endOffset
      );
      const candidate = this.session.getActiveCandidate();

      if (
        candidate === undefined ||
        candidate.viewMode !== "edit" ||
        startOffset === endOffset ||
        selectedText.trim() === ""
      ) {
        return;
      }

      event.preventDefault();

      const menu = new Menu();

      menu.addItem((item) => {
        item
          .setTitle("在 Lain Brain Chat 中讨论此选区")
          .setIcon("message-circle")
          .onClick(() => {
            const started =
              this.session.startSelectionDiscussion(
                candidate.id,
                startOffset,
                endOffset
              );

            if (started) {
              void this.openSidebarChat();
            }
          });
      });
      menu.showAtMouseEvent(event);
    });

    editor.focus();
  }

  private renderCandidatePreview(
    container: HTMLElement
  ): void {
    const previewEl = container.createDiv();

    this.candidatePreviewEl = previewEl;
    previewEl.addClass("markdown-rendered");
    previewEl.style.flex = "1";
    previewEl.style.minHeight = "0";
    previewEl.style.overflowY = "auto";
    previewEl.style.padding = "1rem";
    previewEl.style.backgroundColor = "var(--background-primary)";
    previewEl.style.border =
      "1px solid var(--background-modifier-border)";
    previewEl.style.borderRadius = "4px";

    if (this.session.candidateNoteMarkdown === "") {
      previewEl.setText("候选笔记为空。");
      return;
    }

    this.candidateMarkdownRenderer.reset();
    this.candidateMarkdownRenderer.render(
      this.session.candidateNoteMarkdown,
      previewEl,
      this.session.activeNoteSourcePath
    );
  }

  private getCandidateListKey(): string {
    return this.session.getCandidateNotes()
      .map(
        (candidate) =>
          `${candidate.id}:${candidate.title}:` +
          candidate.primaryConcept.name
      )
      .join("|");
  }

  private syncCandidateContent(): void {
    const markdown = this.session.candidateNoteMarkdown;

    if (this.session.candidateViewMode === "edit") {
      const editor = this.candidateEditor;

      if (editor !== undefined && editor.value !== markdown) {
        const selectionStart = editor.selectionStart;
        const selectionEnd = editor.selectionEnd;
        const selectionDirection = editor.selectionDirection;
        const wasFocused = document.activeElement === editor;

        editor.value = markdown;

        if (wasFocused) {
          const maximum = markdown.length;
          editor.setSelectionRange(
            Math.min(selectionStart, maximum),
            Math.min(selectionEnd, maximum),
            selectionDirection
          );
        }
      }

      this.renderedCandidateMarkdown = markdown;
      return;
    }

    if (this.renderedCandidateMarkdown !== markdown) {
      const previewEl = this.candidatePreviewEl;

      if (previewEl !== undefined) {
        previewEl.empty();
        this.candidateMarkdownRenderer.reset();

        if (markdown === "") {
          previewEl.setText("候选笔记为空。");
        } else {
          this.candidateMarkdownRenderer.render(
            markdown,
            previewEl,
            this.session.activeNoteSourcePath
          );
        }
      }

      this.renderedCandidateMarkdown = markdown;
    }
  }
}
