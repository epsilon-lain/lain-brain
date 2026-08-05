import { App, Modal } from "obsidian";
import {
  applyBrokenLinkCleanup,
  discoverBrokenLinkCleanupReview
} from "./BrokenLinkCleanup";
import type {
  BrokenLinkCleanupProposal,
  SelectedBrokenLinkCleanup
} from "./BrokenLinkCleanup";
import type { LainBrainSession } from "./LainBrainSession";

interface BrokenLinkRowState {
  proposal: BrokenLinkCleanupProposal;
  selected: boolean;
  replacement: string;
  statusEl: HTMLElement;
}

export class BrokenLinkCleanupModal extends Modal {
  private rows: BrokenLinkRowState[] = [];
  private confirmButton?: HTMLButtonElement;

  constructor(
    app: App,
    private session: LainBrainSession
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Clean Up Broken Links");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text:
        "Review unresolved long wikilinks. Nothing changes unless you check a row and confirm."
    });
    this.contentEl.createEl("p", {
      text: "Scanning verified Lain Brain notes…"
    });
    void this.loadReview();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async loadReview(): Promise<void> {
    try {
      const proposals = await discoverBrokenLinkCleanupReview(
        this.app,
        this.session
      );
      this.renderReview(proposals);
    } catch {
      this.contentEl.empty();
      this.contentEl.createEl("p", {
        text: "Unable to scan Lain Brain links."
      });
    }
  }

  private renderReview(
    proposals: readonly BrokenLinkCleanupProposal[]
  ): void {
    this.contentEl.empty();
    this.rows = [];
    this.contentEl.createEl("p", {
      text:
        "Approved repairs remove only broken link markup and preserve the visible text. Every row is unchecked by default."
    });

    if (proposals.length === 0) {
      this.contentEl.createEl("p", {
        text: "No unsafe legacy links were found."
      });
    } else {
      const list = this.contentEl.createDiv();
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "0.75rem";

      for (const proposal of proposals) {
        this.renderProposalRow(list, proposal);
      }
    }

    const actions = this.contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "0.5rem";
    actions.style.marginTop = "1rem";
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());
    this.confirmButton = actions.createEl("button", {
      text: "Confirm Repairs"
    });
    this.confirmButton.addClass("mod-cta");
    this.confirmButton.disabled = proposals.length === 0;
    this.confirmButton.addEventListener("click", () => {
      void this.confirmRepairs();
    });
  }

  private renderProposalRow(
    container: HTMLElement,
    proposal: BrokenLinkCleanupProposal
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
    checkbox.setAttr(
      "aria-label",
      `Repair broken link in ${proposal.sourcePath}`
    );
    const fields = row.createDiv();
    fields.style.display = "flex";
    fields.style.flexDirection = "column";
    fields.style.gap = "0.3rem";
    fields.createEl("strong", { text: proposal.sourcePath });
    fields.createEl("code", { text: proposal.currentWikiLink });
    const replacement = fields.createEl("textarea");
    replacement.value = proposal.proposedReplacement;
    replacement.rows = 3;
    replacement.setAttr(
      "aria-label",
      `Replacement for ${proposal.currentWikiLink}`
    );
    fields.createEl("small", {
      text: `Reason: ${proposal.reason}`
    });
    const statusEl = fields.createEl("small");
    const state: BrokenLinkRowState = {
      proposal,
      selected: false,
      replacement: proposal.proposedReplacement,
      statusEl
    };
    this.rows.push(state);
    checkbox.addEventListener("change", () => {
      state.selected = checkbox.checked;
      statusEl.setText("");
    });
    replacement.addEventListener("input", () => {
      state.replacement = replacement.value;
      statusEl.setText("");
    });
  }

  private async confirmRepairs(): Promise<void> {
    const selected = this.rows.filter((row) => row.selected);

    if (selected.length === 0) {
      for (const row of this.rows) {
        row.statusEl.setText("Check this row to approve its repair.");
      }
      return;
    }

    if (this.confirmButton !== undefined) {
      this.confirmButton.disabled = true;
    }

    const selections: SelectedBrokenLinkCleanup[] = selected.map(
      (row) => ({
        id: row.proposal.id,
        sourcePath: row.proposal.sourcePath,
        startOffset: row.proposal.startOffset,
        endOffset: row.proposal.endOffset,
        currentWikiLink: row.proposal.currentWikiLink,
        replacement: row.replacement
      })
    );
    const results = await applyBrokenLinkCleanup(
      this.app,
      this.session,
      selections
    );
    const byId = new Map(results.map((result) => [result.id, result]));

    for (const row of selected) {
      const result = byId.get(row.proposal.id);
      row.statusEl.setText(result?.message ?? "Repair was not attempted");
      row.statusEl.style.color = result?.ok === true
        ? "var(--text-success)"
        : "var(--text-error)";
    }

    if (this.confirmButton !== undefined) {
      this.confirmButton.disabled = false;
    }
  }
}
