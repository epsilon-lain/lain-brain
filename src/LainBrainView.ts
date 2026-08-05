import {
  ItemView,
  Modal,
  setIcon,
  WorkspaceLeaf
} from "obsidian";
import type { App } from "obsidian";
import { LainBrainChatPanel } from "./LainBrainChatPanel";
import { NoteNameCleanupModal } from "./NoteNameCleanupModal";
import { BrokenLinkCleanupModal } from "./BrokenLinkCleanupModal";
import type {
  CandidateNote,
  LainBrainSession
} from "./LainBrainSession";

export const VIEW_TYPE_LAIN_BRAIN = "lain-brain-view";

export class LainBrainView extends ItemView {
  private chatPanel?: LainBrainChatPanel;
  private unsubscribe?: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    private session: LainBrainSession,
    private openLargeChat: () => Promise<void>,
    private openCandidateView: () => Promise<void>,
    private requestNamingOnboarding: () => void
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_LAIN_BRAIN;
  }

  getDisplayText(): string {
    return this.session.workspaceTitle;
  }

  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();

    const header = this.contentEl.createDiv();
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";

    const title = header.createEl("h2", {
      text: this.session.workspaceTitle
    });
    title.style.margin = "0";

    const expandButton = header.createEl("button");
    setIcon(expandButton, "plus");
    expandButton.setAttr("aria-label", "Open large Lain Brain chat");
    expandButton.style.width = "13px";
    expandButton.style.height = "13px";
    expandButton.style.display = "inline-flex";
    expandButton.style.alignItems = "center";
    expandButton.style.justifyContent = "center";
    expandButton.style.padding = "0";
    expandButton.style.border = "none";
    expandButton.style.borderRadius = "50%";
    expandButton.style.backgroundColor = "#7c3aed";
    expandButton.style.color = "#ffffff";
    expandButton.style.fontSize = "11px";
    expandButton.style.lineHeight = "1";
    expandButton.style.boxSizing = "border-box";
    expandButton.style.cursor = "pointer";

    const expandIcon = expandButton.querySelector("svg");

    if (expandIcon !== null) {
      expandIcon.style.width = "11px";
      expandIcon.style.height = "11px";
    }

    expandButton.addEventListener("click", () => {
      void this.openLargeChat();
    });

    this.contentEl.createEl("p", {
      text: "Build a personal knowledge model with your notes."
    });

    const chatContainer = this.contentEl.createDiv();
    this.chatPanel = new LainBrainChatPanel(
      this.app,
      chatContainer,
      this.session,
      false
    );

    const candidateActions = this.contentEl.createDiv();
    candidateActions.style.display = "flex";
    candidateActions.style.flexWrap = "wrap";
    candidateActions.style.gap = "0.5rem";
    candidateActions.style.marginTop = "0.75rem";

    const generateButton = candidateActions.createEl("button", {
      text: "Organize into Candidate Notes"
    });
    const previewButton = candidateActions.createEl("button", {
      text: "View Candidate Notes"
    });
    const cleanupButton = candidateActions.createEl("button", {
      text: "Clean Up Names"
    });
    const brokenLinksButton = candidateActions.createEl("button", {
      text: "Clean Up Broken Links"
    });
    const candidateStatus = this.contentEl.createEl("p");

    const updateCandidateControls = (): void => {
      title.setText(this.session.workspaceTitle);
      generateButton.style.display =
        this.session.hasCompletedExchange()
          ? "inline-block"
          : "none";
      generateButton.disabled = this.session.loading;

      previewButton.style.display = this.session.hasCandidateNote
        ? "inline-block"
        : "none";
      previewButton.setText(
        `View Candidate Notes (${this.session.candidateCount})`
      );
      previewButton.disabled = this.session.candidateLoading;

      if (this.session.candidateLoading) {
        candidateStatus.setText(
          this.session.brainDisplayName + "> Organizing candidate notes..."
        );
      } else if (this.session.candidateError !== null) {
        candidateStatus.setText(this.session.candidateError);
      } else {
        candidateStatus.empty();
      }
    };

    this.unsubscribe = this.session.subscribe(
      updateCandidateControls
    );
    updateCandidateControls();

    generateButton.addEventListener("click", () => {
      void this.generateCandidateWithConfirmation();
    });

    previewButton.addEventListener("click", () => {
      void this.openCandidateView();
    });

    cleanupButton.addEventListener("click", () => {
      new NoteNameCleanupModal(this.app, this.session).open();
    });

    brokenLinksButton.addEventListener("click", () => {
      new BrokenLinkCleanupModal(this.app, this.session).open();
    });

    this.chatPanel.focus();
    this.requestNamingOnboarding();
  }

  private async generateCandidateWithConfirmation(): Promise<void> {
    const result =
      await this.session.generateOrUpdateCandidateNotes(false);

    if (result !== "needs-confirmation") {
      return;
    }

    const conflicts =
      this.session.getCandidateOverwriteConflicts();
    const confirmed = await confirmCandidateOverwrite(
      this.app,
      conflicts
    );

    if (!confirmed) {
      return;
    }

    await this.session.generateOrUpdateCandidateNotes(true);
  }

  async onClose(): Promise<void> {
    this.chatPanel?.destroy();
    this.chatPanel = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

function confirmCandidateOverwrite(
  app: App,
  candidates: readonly CandidateNote[]
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
      modal.titleEl.setText("Overwrite edited candidate notes?");
      modal.contentEl.createEl("p", {
        text:
          "The following candidate notes contain manual edits. Organizing again will overwrite these " +
          "changes. Continue?"
      });

      const list = modal.contentEl.createEl("ul");

      for (const candidate of candidates) {
        list.createEl("li", {
          text:
            `${candidate.title} (` +
            candidate.primaryConcept.name +
            ")"
        });
      }

      const actions = modal.contentEl.createDiv();
      actions.style.display = "flex";
      actions.style.justifyContent = "flex-end";
      actions.style.gap = "0.5rem";
      actions.style.marginTop = "1rem";

      const cancelButton = actions.createEl("button", {
        text: "Cancel"
      });
      const overwriteButton = actions.createEl("button", {
        text: "Confirm"
      });
      overwriteButton.addClass("mod-warning");

      cancelButton.addEventListener("click", () => {
        settle(false);
      });
      overwriteButton.addEventListener("click", () => {
        settle(true);
      });
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
