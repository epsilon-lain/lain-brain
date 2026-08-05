import { App, Modal } from "obsidian";
import {
  applyNoteNameCleanup,
  discoverNoteNameCleanupReview
} from "./NoteNameCleanup";
import type {
  NoteNameCleanupProposal,
  NoteNameCleanupReview
} from "./NoteNameCleanup";
import type { LainBrainSession } from "./LainBrainSession";

interface CleanupRowState {
  proposal: NoteNameCleanupProposal;
  selected: boolean;
  targetFileName: string;
  statusEl: HTMLElement;
}

export class NoteNameCleanupModal extends Modal {
  private review?: NoteNameCleanupReview;
  private rows: CleanupRowState[] = [];
  private confirmButton?: HTMLButtonElement;

  constructor(
    app: App,
    private session: LainBrainSession
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Clean Up Names");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text:
        "Review proposed filename changes. Nothing is renamed unless you check a row and confirm."
    });
    this.contentEl.createEl("p", {
      text: "Scanning Lain Brain notes…"
    });
    void this.loadReview();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async loadReview(): Promise<void> {
    try {
      this.review = await discoverNoteNameCleanupReview(
        this.app,
        this.session
      );
      this.renderReview();
    } catch {
      this.contentEl.empty();
      this.contentEl.createEl("p", {
        text: "Unable to scan Lain Brain notes."
      });
    }
  }

  private renderReview(): void {
    const review = this.review;

    if (review === undefined) {
      return;
    }

    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text:
        "Select only the filenames you approve. Every proposal is unchecked by default."
    });
    this.rows = [];

    if (review.proposals.length === 0) {
      this.contentEl.createEl("p", {
        text: "No safe rename candidates were found."
      });
    } else {
      const list = this.contentEl.createDiv();
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "0.75rem";

      for (const proposal of review.proposals) {
        this.renderProposalRow(list, proposal);
      }
    }

    if (review.futureReviewItems.length > 0) {
      this.contentEl.createEl("h3", { text: "Future review" });
      this.contentEl.createEl("p", {
        text:
          "These unresolved long links are shown for review only. Lain Brain will not rewrite or delete them."
      });
      const futureList = this.contentEl.createEl("ul");

      for (const item of review.futureReviewItems) {
        futureList.createEl("li", {
          text:
            `${item.sourcePath}: [[${item.linkTarget}]] — ` +
            item.reason
        });
      }
    }

    const actions = this.contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "0.5rem";
    actions.style.marginTop = "1rem";

    const cancelButton = actions.createEl("button", {
      text: "Cancel"
    });
    cancelButton.addEventListener("click", () => this.close());

    this.confirmButton = actions.createEl("button", {
      text: "Confirm Renames"
    });
    this.confirmButton.addClass("mod-cta");
    this.confirmButton.disabled = review.proposals.length === 0;
    this.confirmButton.addEventListener("click", () => {
      void this.confirmRenames();
    });
  }

  private renderProposalRow(
    container: HTMLElement,
    proposal: NoteNameCleanupProposal
  ): void {
    const row = container.createDiv();
    row.style.display = "grid";
    row.style.gridTemplateColumns = "auto minmax(0, 1fr)";
    row.style.gap = "0.35rem 0.65rem";
    row.style.padding = "0.65rem";
    row.style.border = "1px solid var(--background-modifier-border)";
    row.style.borderRadius = "6px";

    const checkbox = row.createEl("input", { type: "checkbox" });
    checkbox.checked = false;
    checkbox.setAttr("aria-label", `Rename ${proposal.currentFileName}`);

    const fields = row.createDiv();
    fields.style.display = "flex";
    fields.style.flexDirection = "column";
    fields.style.gap = "0.3rem";
    fields.createEl("strong", { text: proposal.sourcePath });

    const input = fields.createEl("input", { type: "text" });
    input.value = proposal.suggestedFileName;
    input.setAttr("aria-label", `Suggested filename for ${proposal.currentFileName}`);
    fields.createEl("small", {
      text: `Reason: ${proposal.reason}`
    });
    const statusEl = fields.createEl("small");
    const state: CleanupRowState = {
      proposal,
      selected: false,
      targetFileName: proposal.suggestedFileName,
      statusEl
    };
    this.rows.push(state);

    checkbox.addEventListener("change", () => {
      state.selected = checkbox.checked;
      statusEl.setText("");
    });
    input.addEventListener("input", () => {
      state.targetFileName = input.value;
      statusEl.setText("");
    });
  }

  private async confirmRenames(): Promise<void> {
    const selected = this.rows.filter((row) => row.selected);

    if (selected.length === 0) {
      for (const row of this.rows) {
        row.statusEl.setText("Check this row to approve its rename.");
      }
      return;
    }

    if (this.confirmButton !== undefined) {
      this.confirmButton.disabled = true;
    }

    const results = await applyNoteNameCleanup(
      this.app,
      this.session,
      selected.map((row) => ({
        sourcePath: row.proposal.sourcePath,
        targetFileName: row.targetFileName
      }))
    );
    const resultsBySource = new Map(
      results.map((result) => [result.sourcePath, result])
    );

    for (const row of selected) {
      const result = resultsBySource.get(row.proposal.sourcePath);

      if (result === undefined) {
        row.statusEl.setText("Rename was not attempted.");
        row.statusEl.style.color = "var(--text-error)";
      } else {
        row.statusEl.setText(
          result.ok && result.targetPath !== undefined
            ? `Renamed to ${result.targetPath}`
            : result.message
        );
        row.statusEl.style.color = result.ok
          ? "var(--text-success)"
          : "var(--text-error)";
      }
    }

    if (this.confirmButton !== undefined) {
      this.confirmButton.disabled = false;
    }
  }
}
