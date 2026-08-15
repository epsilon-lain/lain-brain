import type { App } from "obsidian";
import { Modal, setIcon } from "obsidian";
import { LainBrainMarkdownRenderBatch } from "./LainBrainMarkdownRenderer";
import {
  hasSelectedTextWithin,
  makeReadOnlyTextSelectable
} from "./SelectableText";
import type { VisionImageFile } from "./OpenAIVisionClient";
import {
  CHAT_STRUCTURAL_RELATION_TYPES,
  type ChatSemanticDeltaProposalTarget
} from "./ChatSemanticDelta";
import {
  extractAttachmentFiles
} from "./LainBrainSession";
import type {
  ChatAttachment,
  LainBrainImageAttachmentMetadata,
  LainBrainSession
} from "./LainBrainSession";

export class LainBrainChatPanel {
  private readonly transcriptEl: HTMLDivElement;
  private readonly messagesEl: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly inputPrefix: HTMLSpanElement;
  private readonly attachmentPreviewEl: HTMLDivElement;
  private readonly attachmentButton: HTMLButtonElement;
  private readonly fileInput: HTMLInputElement;
  private readonly noteLabel: HTMLElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly selectionContextEl: HTMLDivElement;
  private readonly semanticProposalEl: HTMLDivElement;
  private readonly unsubscribe: () => void;
  private readonly selectableCleanup: () => void;
  private readonly markdownRenderer: LainBrainMarkdownRenderBatch;
  private renderedTranscriptKey = "";
  private renderedLoadingMode: string | null = null;
  private renderedCandidateLoading = false;
  private renderedAttachmentIds: string = "";
  private attachmentObjectUrls: string[] = [];

  constructor(
    private app: App,
    private containerEl: HTMLElement,
    private session: LainBrainSession,
    large: boolean
  ) {
    this.markdownRenderer = new LainBrainMarkdownRenderBatch(this.app);
    this.containerEl.empty();

    if (large) {
      this.containerEl.style.display = "flex";
      this.containerEl.style.flexDirection = "column";
      this.containerEl.style.height = "100%";
      this.containerEl.style.minHeight = "0";
    }

    const toolbar = this.containerEl.createDiv();
    toolbar.style.display = "flex";
    toolbar.style.alignItems = "center";
    toolbar.style.justifyContent = "space-between";
    toolbar.style.gap = "0.5rem";
    toolbar.style.marginBottom = "0.5rem";

    this.noteLabel = toolbar.createEl("small");

    this.clearButton = toolbar.createEl("button", {
      text: "Clear Chat"
    });
    this.clearButton.style.padding = "2px 6px";
    this.clearButton.style.fontSize = "0.75rem";
    this.clearButton.style.lineHeight = "1.2";

    this.clearButton.addEventListener("click", () => {
      this.session.clearChat();
      this.input.focus();
    });

    this.selectionContextEl = this.containerEl.createDiv();
    this.selectionContextEl.style.display = "none";

    this.semanticProposalEl = this.containerEl.createDiv();
    this.semanticProposalEl.style.display = "none";

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
    this.selectableCleanup = makeReadOnlyTextSelectable(
      this.transcriptEl
    );

    if (large) {
      this.transcriptEl.style.flex = "1";
      this.transcriptEl.style.minHeight = "0";
    } else {
      this.transcriptEl.style.height = "320px";
    }

    this.messagesEl = this.transcriptEl.createDiv();

    this.attachmentPreviewEl = this.transcriptEl.createDiv();
    this.attachmentPreviewEl.style.display = "none";

    const inputLine = this.transcriptEl.createDiv();
    inputLine.style.display = "flex";
    inputLine.style.alignItems = "flex-start";
    inputLine.style.paddingTop = "0.25rem";
    inputLine.style.backgroundColor = large
      ? "#0c0c0c"
      : "var(--background-secondary)";

    this.inputPrefix = inputLine.createSpan({
      text: this.session.userDisplayName + "> "
    });
    this.inputPrefix.style.flexShrink = "0";
    this.inputPrefix.style.color = large ? "#c586c0" : "inherit";

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

    this.attachmentButton = inputLine.createEl("button");
    this.attachmentButton.type = "button";
    this.attachmentButton.setAttr("aria-label", "Attach image");
    this.attachmentButton.setAttr("title", "Attach image");
    setIcon(this.attachmentButton, "paperclip");
    this.attachmentButton.style.flexShrink = "0";
    this.attachmentButton.style.width = "24px";
    this.attachmentButton.style.height = "24px";
    this.attachmentButton.style.display = "inline-flex";
    this.attachmentButton.style.alignItems = "center";
    this.attachmentButton.style.justifyContent = "center";
    this.attachmentButton.style.padding = "0";
    this.attachmentButton.style.marginLeft = "0.35rem";

    this.fileInput = inputLine.createEl("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "image/png,image/jpeg,image/webp,image/gif";
    this.fileInput.style.display = "none";

    this.attachmentButton.addEventListener("click", () => {
      this.fileInput.click();
    });

    this.fileInput.addEventListener("change", () => {
      const files = this.fileInput.files;
      this.fileInput.value = "";

      if (files !== null && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          this.session.addChatAttachment(files[i] as VisionImageFile);
        }
        this.input.focus();
      }
    });

    this.input.addEventListener("input", () => {
      this.session.setDraft(this.input.value);
      this.resizeInput();
    });

    this.input.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        !hasSelectedTextWithin(this.transcriptEl)
      ) {
        event.preventDefault();
        void this.sendFromInput();
      }
    });

    this.input.addEventListener("paste", (event) => {
      const files = this.extractSupportedFilesFromClipboard(event);
      if (files.length === 0) {
        // Normal text paste — let the browser handle it unchanged.
        return;
      }
      event.preventDefault();
      for (const file of files) {
        this.session.addChatAttachment(file as VisionImageFile);
      }
      this.input.focus();
    });

    this.unsubscribe = this.session.subscribe(() => {
      this.render();
    });

    this.render();
  }

  private extractSupportedFilesFromClipboard(
    event: ClipboardEvent
  ): File[] {
    const cd = event.clipboardData;
    if (cd === null) {
      return [];
    }
    return extractAttachmentFiles(
      Array.from(cd.items),
      cd.files.length > 0 ? Array.from(cd.files) : undefined
    );
  }

  destroy(): void {
    this.unsubscribe();
    this.selectableCleanup();
    this.revokeAttachmentPreviews();
    this.markdownRenderer.destroy();
  }

  focus(): void {
    this.input.focus();
  }

  private render(): void {
    const messages = this.session.getChatTranscriptMessages();
    const selectionContext =
      this.session.getSelectionEditContext();
    const loadingMode = this.session.loadingMode;
    const candidateLoading = this.session.candidateLoading;
    const transcriptKey =
      this.session.userDisplayName + ":" +
      this.session.brainDisplayName + ":" +
      (selectionContext?.candidateId ?? "general") +
      ":" +
      messages
        .map(
          (message) =>
            `${message.role}:${message.content}:` +
            `${message.attachment?.filename ?? ""}:` +
            `${message.attachment?.byteSize ?? ""}:` +
            `${(message.attachments ?? [])
              .map((a) => `${a.filename}:${a.byteSize}`)
              .join(",")}`
        )
        .join("\u0000");

    this.noteLabel.setText(this.session.activeNoteLabel);
    this.inputPrefix.setText(
      this.session.userDisplayName + "> "
    );
    this.clearButton.disabled = this.session.loading;
    this.clearButton.style.display =
      selectionContext === undefined ? "" : "none";
    this.renderSelectionContext();
    this.renderSemanticDeltaProposal();
    this.renderAttachment();

    if (
      this.renderedTranscriptKey !== transcriptKey ||
      this.renderedLoadingMode !== loadingMode ||
      this.renderedCandidateLoading !== candidateLoading
    ) {
      this.messagesEl.empty();
      this.markdownRenderer.reset();

      for (const message of messages) {
        this.addTranscriptLine(
          message.role,
          message.content,
          message.attachment,
          message.attachments
        );
      }

      if (loadingMode === "chat") {
        this.addTranscriptLine("assistant", "Thinking...");
      }

      if (candidateLoading) {
        this.addTranscriptLine(
          "assistant",
          "Organizing candidate notes..."
        );
      }

      this.renderedTranscriptKey = transcriptKey;
      this.renderedLoadingMode = loadingMode;
      this.renderedCandidateLoading = candidateLoading;
      this.scrollToNewestMessage();
    }

    if (this.input.value !== this.session.draft) {
      this.input.value = this.session.draft;
      this.resizeInput();
    }

    this.input.readOnly = this.session.loading;
    this.attachmentButton.disabled = this.session.loading;
    this.attachmentButton.style.display =
      selectionContext === undefined ? "inline-flex" : "none";
  }

  private async sendFromInput(): Promise<void> {
    try {
      const result = await this.session.send();

      if (result === "needs-vision-confirmation") {
        const provider =
          this.session.getVisionProviderConfirmation();

        if (provider === null) {
          return;
        }

        const confirmed = await confirmVisionProviderSend(
          this.app,
          provider.displayName
        );

        if (confirmed) {
          await this.session.send(provider.id);
        } else {
          this.session.clearPendingAttachments();
        }
      }
    } finally {
      this.input.focus();
    }
  }

  private renderAttachment(): void {
    const attachments = this.session.getSelectionEditContext() === undefined
      ? this.session.getPendingAttachments()
      : [];

    const attachmentKey = attachments
      .map((a) => `${a.id}:${a.filename}`)
      .join("\x00");

    if (this.renderedAttachmentIds === attachmentKey) {
      return;
    }

    this.revokeAttachmentPreviews();
    this.attachmentPreviewEl.empty();
    this.renderedAttachmentIds = attachmentKey;

    if (attachments.length === 0) {
      this.attachmentPreviewEl.style.display = "none";
      return;
    }

    this.attachmentPreviewEl.style.display = "flex";
    this.attachmentPreviewEl.style.flexDirection = "column";
    this.attachmentPreviewEl.style.gap = "0.35rem";
    this.attachmentPreviewEl.style.padding = "0.45rem";
    this.attachmentPreviewEl.style.margin = "0.35rem 0";
    this.attachmentPreviewEl.style.border =
      "1px solid var(--background-modifier-border)";
    this.attachmentPreviewEl.style.borderRadius = "4px";

    for (const attachment of attachments) {
      this.renderAttachmentRow(attachment);
    }
  }

  private renderAttachmentRow(attachment: ChatAttachment): void {
    const isImage = attachment.mimeType.startsWith("image/");

    const row = this.attachmentPreviewEl.createDiv();
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "0.5rem";

    if (isImage) {
      const url = URL.createObjectURL(attachment.file as Blob);
      this.attachmentObjectUrls.push(url);
      const preview = row.createEl("img");
      preview.src = url;
      preview.alt = attachment.filename;
      preview.style.width = "48px";
      preview.style.height = "48px";
      preview.style.objectFit = "cover";
      preview.style.borderRadius = "3px";
    } else {
      // PDF compact chip
      const icon = row.createSpan();
      icon.style.flexShrink = "0";
      icon.style.width = "48px";
      icon.style.height = "48px";
      icon.style.display = "inline-flex";
      icon.style.alignItems = "center";
      icon.style.justifyContent = "center";
      icon.style.fontSize = "1.25rem";
      icon.style.backgroundColor = "var(--background-secondary)";
      icon.style.borderRadius = "3px";
      icon.setText("PDF");
    }

    const details = row.createDiv();
    details.style.flex = "1";
    details.style.minWidth = "0";
    details.createDiv({ text: attachment.filename });
    details.createEl("small", {
      text: `${attachment.mimeType} · ${formatByteSize(attachment.byteSize)}`
    });

    const removeButton = row.createEl("button", { text: "×" });
    removeButton.type = "button";
    removeButton.setAttr("aria-label", `Remove ${attachment.filename}`);
    removeButton.style.padding = "0 4px";
    removeButton.style.fontSize = "1rem";
    removeButton.style.lineHeight = "1";
    removeButton.style.flexShrink = "0";
    removeButton.addEventListener("click", () => {
      this.session.removeChatAttachment(attachment.id);
      this.input.focus();
    });
  }

  private revokeAttachmentPreviews(): void {
    for (const url of this.attachmentObjectUrls) {
      URL.revokeObjectURL(url);
    }
    this.attachmentObjectUrls = [];
  }
  private renderSelectionContext(): void {
    const context = this.session.getSelectionEditContext();

    this.selectionContextEl.empty();

    if (context === undefined) {
      this.selectionContextEl.style.display = "none";
      return;
    }

    this.selectionContextEl.style.display = "block";
    this.selectionContextEl.style.padding = "0.6rem";
    this.selectionContextEl.style.marginBottom = "0.5rem";
    this.selectionContextEl.style.border =
      "1px solid var(--interactive-accent)";
    this.selectionContextEl.style.borderRadius = "4px";
    this.selectionContextEl.style.backgroundColor =
      "var(--background-secondary)";

    const candidate = this.session.getCandidateNotes().find(
      (item) => item.id === context.candidateId
    );
    const title = this.selectionContextEl.createEl("strong", {
      text:
        "Discussing candidate note: " +
        (candidate?.title ?? "Unknown candidate note")
    });
    title.style.display = "block";

    const selection = this.selectionContextEl.createEl("div");
    selection.style.marginTop = "0.35rem";
    selection.style.whiteSpace = "pre-wrap";
    selection.style.overflowWrap = "anywhere";
    selection.setText(
      "Selection: " + truncateSelection(context.originalText)
    );

    const actions = this.selectionContextEl.createDiv();
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.gap = "0.4rem";
    actions.style.marginTop = "0.5rem";

    const cancelButton = actions.createEl("button", {
      text: "Cancel Selection Discussion"
    });
    cancelButton.style.padding = "2px 6px";
    cancelButton.addEventListener("click", () => {
      this.session.cancelSelectionDiscussion();
      this.input.focus();
    });

    const hasRequest = context.discussionMessages.some(
      (message) => message.role === "user"
    );

    if (hasRequest && context.pendingReplacement === undefined) {
      const generateButton = actions.createEl("button", {
        text: "Generate Replacement"
      });
      generateButton.style.padding = "2px 6px";
      generateButton.disabled = this.session.loading;
      generateButton.addEventListener("click", () => {
        void this.session.generateSelectionEditReplacement();
      });
    }

    if (this.session.selectionReplacementLoading) {
      this.selectionContextEl.createEl("p", {
        text:
          this.session.brainDisplayName +
          "> Generating replacement..."
      });
    }

    if (context.replacementError !== undefined) {
      const errorEl = this.selectionContextEl.createEl("p", {
        text: context.replacementError
      });
      errorEl.style.color = "var(--text-error)";
    }

    if (context.pendingReplacement === undefined) {
      return;
    }

    const diff = this.selectionContextEl.createDiv();
    diff.style.display = "grid";
    diff.style.gridTemplateColumns =
      "repeat(auto-fit, minmax(180px, 1fr))";
    diff.style.gap = "0.5rem";
    diff.style.marginTop = "0.6rem";

    this.createDiffBlock(
      diff,
      "Original Selection",
      context.originalText,
      "var(--background-modifier-error)"
    );
    this.createDiffBlock(
      diff,
      "Suggested Replacement",
      context.pendingReplacement,
      "var(--background-modifier-success)"
    );

    const decisionActions = this.selectionContextEl.createDiv();
    decisionActions.style.display = "flex";
    decisionActions.style.gap = "0.5rem";
    decisionActions.style.marginTop = "0.6rem";

    const applyButton = decisionActions.createEl("button", {
      text: "Apply Change"
    });
    applyButton.addClass("mod-cta");
    applyButton.addEventListener("click", () => {
      this.session.applySelectionReplacement();
    });

    const discardButton = decisionActions.createEl("button", {
      text: "Discard"
    });
    discardButton.addEventListener("click", () => {
      this.session.discardSelectionReplacement();
    });
  }

  private renderSemanticDeltaProposal(): void {
    const proposal = this.session.getActiveChatSemanticDeltaProposal();
    this.semanticProposalEl.empty();
    if (proposal === undefined) {
      this.semanticProposalEl.style.display = "none";
      return;
    }
    this.semanticProposalEl.style.display = "block";
    this.semanticProposalEl.style.padding = "0.65rem";
    this.semanticProposalEl.style.marginBottom = "0.5rem";
    this.semanticProposalEl.style.border =
      "1px solid var(--interactive-accent)";
    this.semanticProposalEl.style.borderRadius = "4px";
    this.semanticProposalEl.style.backgroundColor =
      "var(--background-secondary)";

    this.semanticProposalEl.createEl("strong", {
      text: "Brain noticed a possible semantic change."
    });
    if (proposal.status !== "active") {
      const status = this.semanticProposalEl.createEl("p", {
        text: proposal.statusMessage ?? `Proposal ${proposal.status}.`
      });
      status.style.marginBottom = "0";
      return;
    }

    const labels = {
      personal_definition: "Definition",
      relationship_confirmed: "Relationship",
      relationship_removed: "Relationship removal",
      concept_distinction: "Distinction",
      ambiguity_resolved: "Ambiguity resolution"
    } as const;
    const category = this.semanticProposalEl.createEl("p");
    category.style.marginBottom = "0.35rem";
    category.createEl("strong", { text: "Change: " });
    category.createSpan({ text: labels[proposal.changeKind] });

    this.renderSemanticParticipant(
      proposal.changeKind === "personal_definition" ? "Concept" : "Source",
      proposal.target,
      (conceptId) => this.session.selectChatSemanticDeltaTarget(conceptId)
    );
    if (proposal.secondaryTarget !== undefined) {
      this.renderSemanticParticipant(
        proposal.changeKind === "ambiguity_resolved"
          ? "Selected meaning"
          : "Target",
        proposal.secondaryTarget,
        (conceptId) =>
          this.session.selectChatSemanticDeltaSecondaryTarget(conceptId)
      );
    }

    if (
      proposal.changeKind === "relationship_confirmed" ||
      proposal.changeKind === "relationship_removed"
    ) {
      const relation = this.semanticProposalEl.createEl("p");
      relation.style.marginBottom = "0.35rem";
      relation.createEl("strong", { text: "Relation: " });
      if (this.session.isEditingChatSemanticDelta) {
        const select = relation.createEl("select");
        select.setAttr("aria-label", "Edit structural relation type");
        for (const option of CHAT_STRUCTURAL_RELATION_TYPES) {
          select.createEl("option", {
            text: option,
            value: option
          });
        }
        select.value = proposal.relationType ?? "related_to";
        select.addEventListener("change", () => {
          this.session.setActiveChatSemanticDeltaRelationType(select.value);
        });
      } else {
        relation.createSpan({ text: proposal.relationType ?? "Unavailable" });
      }
    } else if (proposal.changeKind === "concept_distinction") {
      const relation = this.semanticProposalEl.createEl("p", {
        text: "The source is explicitly distinct from the target."
      });
      relation.style.marginBottom = "0.35rem";
    } else if (proposal.changeKind === "ambiguity_resolved") {
      const label = this.semanticProposalEl.createEl("p");
      label.style.marginBottom = "0.35rem";
      label.createEl("strong", { text: "Ambiguous label: " });
      label.createSpan({ text: proposal.ambiguityLabel ?? "Unavailable" });
    }

    const explanation = this.semanticProposalEl.createEl("p");
    explanation.style.margin = "0.35rem 0";
    explanation.createEl("strong", { text: "Main change: " });
    explanation.createSpan({ text: proposal.reason });

    if (proposal.changeKind === "personal_definition") {
      const previous = this.semanticProposalEl.createEl("div");
      previous.createEl("strong", { text: "Previously: " });
      previous.createSpan({
        text: proposal.target.kind === "known_concept"
          ? proposal.target.previousMeaning ?? "No approved personal definition."
          : "This concept is not currently in the Brain."
      });
    }

    const next = this.semanticProposalEl.createEl("div");
    next.style.marginTop = "0.35rem";
    next.createEl("strong", {
      text: proposal.changeKind === "personal_definition"
        ? "Now: "
        : "Reviewed wording: "
    });
    if (this.session.isEditingChatSemanticDelta) {
      const editor = next.createEl("textarea");
      editor.setAttr("aria-label", "Edit proposed semantic meaning");
      editor.value = this.session.chatSemanticDeltaMeaningDraft;
      editor.rows = 4;
      editor.style.display = "block";
      editor.style.width = "100%";
      editor.style.marginTop = "0.3rem";
      editor.addEventListener("input", () => {
        this.session.setChatSemanticDeltaMeaningDraft(editor.value);
      });
    } else {
      next.createSpan({ text: this.session.chatSemanticDeltaMeaningDraft });
    }

    const evidence = this.semanticProposalEl.createEl("details");
    evidence.style.marginTop = "0.4rem";
    evidence.createEl("summary", { text: "Based on exact user evidence" });
    const list = evidence.createEl("ul");
    for (const source of proposal.evidence) {
      const text = source.sourceKind === "message_span"
        ? source.snapshot.slice(
            source.startOffset ?? 0,
            source.endOffset ?? source.snapshot.length
          )
        : source.snapshot;
      list.createEl("li", { text });
    }

    if (this.session.chatSemanticDeltaError !== null) {
      const error = this.semanticProposalEl.createEl("p", {
        text: this.session.chatSemanticDeltaError
      });
      error.style.color = "var(--text-error)";
    }

    const actions = this.semanticProposalEl.createDiv();
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.gap = "0.4rem";
    actions.style.marginTop = "0.5rem";

    const confirm = actions.createEl("button", { text: "Confirm" });
    confirm.addClass("mod-cta");
    confirm.disabled = this.session.chatSemanticDeltaConfirming ||
      proposal.target.kind === "ambiguous_concept" ||
      proposal.secondaryTarget?.kind === "ambiguous_concept";
    confirm.addEventListener("click", () => {
      void this.session.confirmActiveChatSemanticDelta();
    });

    if (!this.session.isEditingChatSemanticDelta) {
      const edit = actions.createEl("button", { text: "Edit" });
      edit.addEventListener("click", () => {
        this.session.beginChatSemanticDeltaEdit();
      });
    }

    const reject = actions.createEl("button", { text: "Not a change" });
    reject.disabled = this.session.chatSemanticDeltaConfirming;
    reject.addEventListener("click", () => {
      this.session.rejectActiveChatSemanticDelta();
    });
  }

  private renderSemanticParticipant(
    label: string,
    target: Readonly<ChatSemanticDeltaProposalTarget>,
    onSelect: (conceptId: string) => boolean
  ): void {
    const row = this.semanticProposalEl.createEl("p");
    row.style.marginBottom = "0.35rem";
    row.createEl("strong", { text: `${label}: ` });
    if (target.kind === "known_concept") {
      row.createSpan({ text: `${target.title} — ${target.conceptId}` });
      return;
    }
    if (target.kind === "new_concept") {
      row.createSpan({ text: `${target.suggestedTitle} (new concept)` });
      return;
    }
    row.createSpan({ text: target.query });
    const select = this.semanticProposalEl.createEl("select");
    select.setAttr(
      "aria-label",
      label === "Concept"
        ? "Select semantic-change concept"
        : `Select ${label.toLocaleLowerCase()} concept`
    );
    select.style.display = "block";
    select.style.marginTop = "0.35rem";
    select.createEl("option", {
      text: "Choose the intended concept…",
      value: ""
    });
    for (const choice of target.choices) {
      select.createEl("option", {
        text: `${choice.title} — ${choice.conceptId}`,
        value: choice.conceptId
      });
    }
    select.addEventListener("change", () => {
      if (select.value !== "") onSelect(select.value);
    });
  }

  private createDiffBlock(
    container: HTMLElement,
    label: string,
    value: string,
    backgroundColor: string
  ): void {
    const block = container.createDiv();
    block.style.minWidth = "0";

    const heading = block.createEl("strong", { text: label });
    heading.style.display = "block";
    heading.style.marginBottom = "0.25rem";

    const content = block.createDiv();
    content.style.padding = "0.5rem";
    content.style.border =
      "1px solid var(--background-modifier-border)";
    content.style.borderRadius = "4px";
    content.style.backgroundColor = backgroundColor;
    content.style.whiteSpace = "pre-wrap";
    content.style.overflowWrap = "anywhere";
    content.style.fontFamily = "var(--font-monospace)";
    content.setText(value);
  }

  private addTranscriptLine(
    role: "user" | "assistant",
    content: string,
    attachment?: LainBrainImageAttachmentMetadata,
    attachments?: LainBrainImageAttachmentMetadata[]
  ): void {
    const prefix = role === "user"
      ? this.session.userDisplayName
      : this.session.brainDisplayName;
    const line = this.messagesEl.createDiv();

    line.style.display = "flex";
    line.style.alignItems = "flex-start";
    line.style.marginBottom = "0.5rem";

    const prefixEl = line.createSpan({
      text: `${prefix}> `
    });
    prefixEl.style.flexShrink = "0";

    if (role === "user") {
      const userContainer = line.createDiv();
      userContainer.style.minWidth = "0";
      userContainer.style.whiteSpace = "pre-wrap";
      userContainer.style.overflowWrap = "anywhere";
      userContainer.createSpan({ text: content });

      if (attachment !== undefined) {
        const attachmentLabel = userContainer.createEl("small", {
          text:
            `Image: ${attachment.filename} (` +
            `${formatByteSize(attachment.byteSize)})`
        });
        attachmentLabel.style.display = "block";
        attachmentLabel.style.color = "var(--text-muted)";
      }

      // Multi-attachment labels
      const allAttachments = attachments ?? [];
      if (allAttachments.length > 0) {
        for (const att of allAttachments) {
          const isImg = att.mimeType.startsWith("image/");
          const label = userContainer.createEl("small", {
            text:
              `${isImg ? "Image" : "File"}: ${att.filename} (` +
              `${formatByteSize(att.byteSize)})`
          });
          label.style.display = "block";
          label.style.color = "var(--text-muted)";
        }
      }

      return;
    }

    const assistantContent = line.createDiv();
    assistantContent.addClass("markdown-rendered");
    assistantContent.style.flex = "1";
    assistantContent.style.minWidth = "0";
    assistantContent.style.whiteSpace = "normal";

    this.markdownRenderer.render(
      content,
      assistantContent,
      this.session.activeNoteSourcePath
    );
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

function confirmVisionProviderSend(
  app: App,
  providerDisplayName: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let settled = false;

    const settle = (value: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
      modal.close();
    };

    modal.onOpen = (): void => {
      modal.titleEl.setText("Send image?");
      modal.contentEl.createEl("p", {
        text:
          `This image will be sent to ${providerDisplayName} for analysis.`
      });

      const actions = modal.contentEl.createDiv();
      actions.style.display = "flex";
      actions.style.justifyContent = "flex-end";
      actions.style.gap = "0.5rem";

      const cancelButton = actions.createEl("button", {
        text: "Cancel"
      });
      const sendButton = actions.createEl("button", {
        text: "Send"
      });
      sendButton.addClass("mod-cta");

      cancelButton.addEventListener("click", () => settle(false));
      sendButton.addEventListener("click", () => settle(true));
    };

    modal.onClose = (): void => {
      modal.contentEl.empty();

      if (!settled) {
        settled = true;
        resolve(false);
      }
    };

    modal.open();
  });
}

function formatByteSize(byteSize: number): string {
  if (byteSize < 1024) {
    return `${byteSize} B`;
  }

  if (byteSize < 1024 * 1024) {
    return `${(byteSize / 1024).toFixed(1)} KiB`;
  }

  return `${(byteSize / (1024 * 1024)).toFixed(1)} MiB`;
}

function truncateSelection(value: string): string {
  const normalized = value
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length <= 160
    ? normalized
    : normalized.slice(0, 157) + "...";
}
