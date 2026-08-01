import {
  ItemView,
  Modal,
  setIcon,
  WorkspaceLeaf
} from "obsidian";
import type { App } from "obsidian";
import { LainBrainChatPanel } from "./LainBrainChatPanel";
import type { LainBrainSession } from "./LainBrainSession";

export const VIEW_TYPE_LAIN_BRAIN = "lain-brain-view";

export class LainBrainView extends ItemView {
  private chatPanel?: LainBrainChatPanel;
  private unsubscribe?: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    private session: LainBrainSession,
    private openLargeChat: () => Promise<void>,
    private openCandidateView: () => Promise<void>
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

  async onOpen(): Promise<void> {
    this.contentEl.empty();

    const header = this.contentEl.createDiv();
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";

    const title = header.createEl("h2", {
      text: "Lain Brain"
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
      text: "整理为候选笔记"
    });
    const previewButton = candidateActions.createEl("button", {
      text: "查看候选笔记"
    });
    const candidateStatus = this.contentEl.createEl("p");

    const updateCandidateControls = (): void => {
      generateButton.style.display =
        this.session.hasCompletedExchange()
          ? "inline-block"
          : "none";
      generateButton.disabled = this.session.loading;

      previewButton.style.display = this.session.hasCandidateNote
        ? "inline-block"
        : "none";
      previewButton.disabled = this.session.candidateLoading;

      if (this.session.candidateLoading) {
        candidateStatus.setText(
          "brain> 正在整理候选笔记..."
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

    this.chatPanel.focus();
  }

  private async generateCandidateWithConfirmation(): Promise<void> {
    let allowOverwriteUserEdits = false;

    if (this.session.hasUserEditedCandidate) {
      allowOverwriteUserEdits =
        await confirmCandidateOverwrite(this.app);

      if (!allowOverwriteUserEdits) {
        return;
      }
    }

    await this.session.generateOrUpdateCandidateNote(
      allowOverwriteUserEdits
    );
  }

  async onClose(): Promise<void> {
    this.chatPanel?.destroy();
    this.chatPanel = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

function confirmCandidateOverwrite(app: App): Promise<boolean> {
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
      modal.titleEl.setText("覆盖已修改的候选笔记？");
      modal.contentEl.createEl("p", {
        text:
          "当前候选笔记包含你的手动修改。重新整理会用新的候选稿" +
          "覆盖这些修改。是否继续？"
      });

      const actions = modal.contentEl.createDiv();
      actions.style.display = "flex";
      actions.style.justifyContent = "flex-end";
      actions.style.gap = "0.5rem";
      actions.style.marginTop = "1rem";

      const cancelButton = actions.createEl("button", {
        text: "取消"
      });
      const overwriteButton = actions.createEl("button", {
        text: "确认覆盖"
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
