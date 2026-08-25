import { Modal, type App } from "obsidian";
import type { LainBrainSession } from "./LainBrainSession";

const PROVENANCE_LABELS: Record<string, string> = {
  user_authored: "User-authored",
  ai_generated: "AI-generated",
  user_edited: "User-edited",
  imported: "Imported"
};

/**
 * Minimal proof workspace: a read-only exact Lean target, an editable proof
 * body, and explicit save / verify actions.  It is not a Lean IDE.
 */
export class LeanProofWorkspaceModal extends Modal {
  private draftId: string | undefined;
  private proofBody = "";
  private statusMessage = "";
  private error = "";
  private busy = false;

  constructor(
    app: App,
    private readonly session: LainBrainSession,
    private readonly formalizationId: string
  ) {
    super(app);
  }

  onOpen(): void {
    const drafts = this.session.getProofDraftsForFormalization(
      this.formalizationId
    );
    const latest = drafts[drafts.length - 1];
    if (latest !== undefined) {
      this.draftId = latest.id;
      this.proofBody = latest.proofBody;
    }
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.style.padding = "0.8rem";
    this.contentEl.style.maxHeight = "75vh";
    this.contentEl.style.overflowY = "auto";
    this.contentEl.createEl("h3", { text: "Lean Proof Workspace" });

    const target = this.session.getLeanFormalizationTarget(
      this.formalizationId
    );
    const targetSection = this.contentEl.createDiv();
    targetSection.style.marginBottom = "0.7rem";
    targetSection.createEl("h4", { text: "Exact Lean target (read-only)" });
    const targetEl = targetSection.createEl("pre", {
      text: target?.propositionText ?? "No canonical Lean target yet."
    });
    targetEl.style.whiteSpace = "pre-wrap";
    targetEl.style.overflowWrap = "anywhere";
    targetEl.style.padding = "0.5rem";
    targetEl.style.background = "var(--background-secondary)";
    if (target !== undefined) {
      targetSection.createEl("small", {
        text: `Target hash: ${target.propositionHash}`
      });
    }

    const editorSection = this.contentEl.createDiv();
    editorSection.createEl("h4", { text: "Lean proof body" });
    const editor = editorSection.createEl("textarea");
    editor.value = this.proofBody;
    editor.placeholder = "tactics only — the theorem target is fixed above";
    editor.style.width = "100%";
    editor.style.minHeight = "8rem";
    editor.style.fontFamily = "var(--font-monospace)";
    editor.addEventListener("input", () => {
      this.proofBody = editor.value;
    });

    const actions = editorSection.createDiv();
    actions.style.display = "flex";
    actions.style.gap = "0.5rem";
    actions.style.marginTop = "0.5rem";

    const saveButton = actions.createEl("button", { text: "Save draft" });
    saveButton.disabled = this.busy;
    saveButton.addEventListener("click", () => {
      void this.saveDraft();
    });

    const verifyButton = actions.createEl("button", {
      text: "Verify proof with Lean"
    });
    verifyButton.addClass("mod-cta");
    verifyButton.disabled = this.busy;
    verifyButton.addEventListener("click", () => {
      void this.verify();
    });

    if (this.error !== "") {
      const errorEl = this.contentEl.createEl("p", { text: this.error });
      errorEl.style.color = "var(--text-error)";
    }
    if (this.statusMessage !== "") {
      const statusEl = this.contentEl.createEl("p", {
        text: this.statusMessage
      });
      statusEl.style.color = "var(--text-success)";
    }

    const viewModel = this.session.getProofWorkspaceViewModel(
      this.formalizationId
    );
    const resultSection = this.contentEl.createDiv();
    resultSection.createEl("h4", { text: "Verification state" });
    resultSection.createEl("div", {
      text: `Candidate: ${viewModel.candidateStatus}`
    });
    resultSection.createEl("div", {
      text: `Verification: ${viewModel.verificationStatus}`
    });
    resultSection.createEl("div", {
      text: `Semantic staleness: ${viewModel.semanticStaleness}`
    });
    if (viewModel.proofProvenance !== undefined) {
      resultSection.createEl("div", {
        text:
          `Provenance: ` +
          `${PROVENANCE_LABELS[viewModel.proofProvenance] ?? viewModel.proofProvenance}`
      });
    }

    const artifacts = this.session.getProofArtifactsForFormalization(
      this.formalizationId
    );
    if (artifacts.length > 0) {
      const history = this.contentEl.createDiv();
      history.createEl("h4", { text: "Attempt history" });
      for (const artifact of artifacts.slice().reverse()) {
        history.createEl("div", {
          text:
            `${artifact.executedAt.slice(0, 19)} — ` +
            `${artifact.result} (${artifact.proofHash.slice(0, 8)})`
        });
      }
    }
  }

  private async saveDraft(): Promise<void> {
    this.busy = true;
    this.render();
    try {
      if (this.draftId === undefined) {
        const created = this.session.createProofDraft(
          this.formalizationId,
          this.proofBody,
          "user_authored"
        );
        if (created.ok) {
          this.draftId = created.draft.id;
          this.statusMessage = "Draft saved.";
        } else {
          this.error = created.error;
        }
      } else {
        const saved = this.session.saveProofDraft(
          this.draftId,
          this.proofBody
        );
        this.statusMessage = saved.ok ? "Draft saved." : "";
        this.error = saved.ok ? "" : saved.error;
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async verify(): Promise<void> {
    await this.saveDraft();
    if (this.draftId === undefined || this.error !== "") {
      return;
    }
    this.busy = true;
    this.render();
    try {
      const result = await this.session.verifyProofDraft(this.draftId);
      if (result.ok) {
        this.statusMessage = "Lean proof verified.";
        this.error = "";
      } else {
        this.error = result.error;
        this.statusMessage = "";
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

