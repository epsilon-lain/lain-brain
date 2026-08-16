import { Modal, type App } from "obsidian";
import type { LainBrainSession } from "./LainBrainSession";
import { LeanProofWorkspaceModal } from "./LeanProofWorkspaceModal";
import {
  BrainFormalizationWorkflow,
  type BrainFormalizationState
} from "./BrainFormalizationWorkflow";
import {
  renderPersonalSemanticIR,
  renderSemanticDiff
} from "./PersonalSemanticIR";

const KIND_LABELS: Record<string, string> = {
  definition: "Definition",
  proposition: "Proposition",
  theorem: "Theorem",
  conjecture: "Conjecture",
  intuition: "Intuition"
};

/**
 * Small review-first surface for one "Formalize using Brain concepts" run.
 * The user reviews meaning before any Lean syntax is generated.
 */
export class BrainFormalizationModal extends Modal {
  private workflow: BrainFormalizationWorkflow | undefined;
  private loading = true;
  private closed = false;
  private error = "";
  private successMessage = "";
  private rejectionReason = "";
  private statementEdit = "";
  private quantifiersEdit = "";
  private conclusionEdit = "";
  private assumptionsEdit = "";

  constructor(
    app: App,
    private readonly session: LainBrainSession
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
    void this.load();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    const workflow = await this.session.createBrainFormalizationWorkflow();
    if (this.closed) {
      return;
    }
    if ("error" in workflow) {
      this.loading = false;
      this.error = workflow.error;
      this.render();
      return;
    }

    this.workflow = workflow;
    await workflow.start();
    if (this.closed) {
      return;
    }
    this.loading = false;
    const state = workflow.getState();
    this.error = state.error ?? "";
    this.syncEdits(state);
    this.render();
  }

  private syncEdits(state: Readonly<BrainFormalizationState>): void {
    const ir = state.ir;
    if (ir === undefined) {
      return;
    }
    this.statementEdit = ir.canonicalStatement;
    this.quantifiersEdit = ir.quantifiers;
    this.conclusionEdit = ir.conclusion;
    this.assumptionsEdit = ir.assumptions
      .filter((assumption) => assumption.kind !== "implicit")
      .map((assumption) => assumption.text)
      .join("\n");
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.style.padding = "0.8rem";
    this.contentEl.style.maxHeight = "70vh";
    this.contentEl.style.overflowY = "auto";

    this.contentEl.createEl("h3", {
      text: "Formalize using Brain concepts"
    });

    if (this.loading) {
      this.contentEl.createEl("p", {
        text: "Resolving concepts and proposing a semantic interpretation..."
      });
      return;
    }

    if (this.error !== "") {
      const errorEl = this.contentEl.createEl("p", { text: this.error });
      errorEl.style.color = "var(--text-error)";
    }

    if (this.successMessage !== "") {
      const successEl = this.contentEl.createEl("p", {
        text: this.successMessage
      });
      successEl.style.color = "var(--text-success)";
    }

    const workflow = this.workflow;
    if (workflow === undefined) {
      return;
    }
    const state = workflow.getState();
    const ir = state.ir;

    if (ir === undefined) {
      return;
    }

    if (state.phase === "accepted" && state.record !== undefined) {
      const proofButton = this.contentEl.createEl("button", {
        text: "Open proof workspace"
      });
      proofButton.addEventListener("click", () => {
        new LeanProofWorkspaceModal(
          this.app,
          this.session,
          state.record!.id
        ).open();
      });
    }

    this.renderSection("Original expression", [state.source.snapshot]);
    this.renderBindings(ir);

    if (ir.objects.length > 0) {
      this.renderSection(
        "Objects",
        ir.objects.map((object) =>
          `${object.name}${object.domain !== undefined
            ? ` [${object.domain}]`
            : ""}`
        )
      );
    }

    if (ir.claims.length > 0) {
      this.renderSection(
        "Claims",
        ir.claims.map(
          (claim) =>
            `[${KIND_LABELS[claim.kind] ?? claim.kind}] ${claim.statement}`
        )
      );
    }

    const explicitAssumptions = ir.assumptions.filter(
      (assumption) => assumption.kind !== "implicit"
    );
    const aiAddedAssumptions = ir.assumptions.filter(
      (assumption) => assumption.kind === "implicit" && assumption.addedByAI
    );
    if (explicitAssumptions.length > 0) {
      this.renderSection(
        "Explicit assumptions",
        explicitAssumptions.map((assumption) => assumption.text)
      );
    }
    if (aiAddedAssumptions.length > 0) {
      this.renderSection(
        "AI-added assumptions",
        aiAddedAssumptions.map((assumption) => assumption.text)
      );
    }

    if (ir.proofSteps.length > 0) {
      this.renderSection(
        "Proof steps",
        ir.proofSteps.map(
          (step) => `[${step.kind}] ${step.description}`
        )
      );
    }

    const diffText = renderSemanticDiff(state.semanticDiff);
    if (diffText !== "") {
      this.renderSection("Semantic diff", [diffText]);
    }

    if (state.validationFailures.length > 0) {
      this.renderSection(
        "Validation",
        state.validationFailures.map(
          (failure) => `${failure.code}: ${failure.message}`
        )
      );
    }

    this.renderDebugView(ir);
    this.renderReviewActions(state);
  }

  private renderSection(title: string, lines: readonly string[]): void {
    const heading = this.contentEl.createEl("h4", { text: title });
    heading.style.marginTop = "0.7rem";
    heading.style.marginBottom = "0.25rem";
    for (const line of lines) {
      const el = this.contentEl.createEl("div", { text: line });
      el.style.whiteSpace = "pre-wrap";
      el.style.overflowWrap = "anywhere";
    }
  }

  private renderBindings(ir: NonNullable<BrainFormalizationState["ir"]>): void {
    if (ir.conceptBindings.length === 0) {
      return;
    }
    const container = this.contentEl.createDiv();
    container.style.marginTop = "0.7rem";
    container.createEl("h4", { text: "Brain concept bindings" });

    for (const binding of ir.conceptBindings) {
      const row = container.createDiv();
      row.style.marginBottom = "0.35rem";
      if (binding.status === "resolved") {
        row.setText(
          `"${binding.surfacePhrase}" → ${binding.resolvedTitle ?? ""} ` +
          `(${binding.conceptId}@${binding.conceptRevision})`
        );
        if (binding.personalDefinition !== undefined) {
          const definition = row.createDiv();
          definition.setText(`Personal: ${binding.personalDefinition}`);
          definition.style.paddingLeft = "0.8rem";
          definition.style.color = "var(--text-muted)";
        }
        if (binding.definitionConflict === true) {
          const warning = row.createDiv();
          warning.setText(
            "Personal definition differs from the standard definition."
          );
          warning.style.color = "var(--text-warning)";
        }
      } else if (binding.status === "ambiguous") {
        row.createSpan({ text: `"${binding.surfacePhrase}" is ambiguous: ` });
        const select = row.createEl("select");
        const placeholder = select.createEl("option", {
          text: "Choose meaning..."
        });
        placeholder.value = "";
        for (const alternative of binding.alternatives ?? []) {
          const option = select.createEl("option", {
            text: `${alternative.title} (${alternative.conceptId})`
          });
          option.value = alternative.conceptId;
        }
        select.addEventListener("change", () => {
          if (select.value !== "") {
            void this.selectConcept(binding.id, select.value);
          }
        });
      } else {
        row.setText(
          `"${binding.surfacePhrase}" is ${binding.status === "proposed_new"
            ? "a proposed new concept"
            : "unresolved"}.`
        );
      }
    }
  }

  private renderDebugView(ir: NonNullable<BrainFormalizationState["ir"]>): void {
    const details = this.contentEl.createEl("details");
    const summary = details.createEl("summary", {
      text: "Show canonical semantic interpretation"
    });
    summary.style.cursor = "pointer";
    const pre = details.createEl("pre", {
      text: renderPersonalSemanticIR(ir)
    });
    pre.style.whiteSpace = "pre-wrap";
    pre.style.overflowWrap = "anywhere";
    pre.style.fontSize = "0.8rem";
  }

  private renderReviewActions(state: Readonly<BrainFormalizationState>): void {
    const workflow = this.workflow;
    if (workflow === undefined) {
      return;
    }

    const editor = this.contentEl.createDiv();
    editor.style.marginTop = "0.8rem";
    editor.createEl("h4", { text: "Review meaning" });

    const statementLabel = editor.createEl("label", {
      text: "Reviewed statement"
    });
    statementLabel.style.display = "block";
    const statement = editor.createEl("textarea");
    statement.value = this.statementEdit;
    statement.style.width = "100%";
    statement.addEventListener("input", () => {
      this.statementEdit = statement.value;
    });

    const quantifiersLabel = editor.createEl("label", {
      text: "Quantifiers"
    });
    quantifiersLabel.style.display = "block";
    const quantifiers = editor.createEl("input");
    quantifiers.value = this.quantifiersEdit;
    quantifiers.style.width = "100%";
    quantifiers.addEventListener("input", () => {
      this.quantifiersEdit = quantifiers.value;
    });

    const conclusionLabel = editor.createEl("label", {
      text: "Conclusion"
    });
    conclusionLabel.style.display = "block";
    const conclusion = editor.createEl("input");
    conclusion.value = this.conclusionEdit;
    conclusion.style.width = "100%";
    conclusion.addEventListener("input", () => {
      this.conclusionEdit = conclusion.value;
    });

    const assumptionsLabel = editor.createEl("label", {
      text: "Explicit assumptions (one per line)"
    });
    assumptionsLabel.style.display = "block";
    const assumptions = editor.createEl("textarea");
    assumptions.value = this.assumptionsEdit;
    assumptions.style.width = "100%";
    assumptions.addEventListener("input", () => {
      this.assumptionsEdit = assumptions.value;
    });

    const actions = editor.createDiv();
    actions.style.display = "flex";
    actions.style.gap = "0.5rem";
    actions.style.marginTop = "0.5rem";

    const applyEditButton = actions.createEl("button", { text: "Apply Edit" });
    applyEditButton.addEventListener("click", () => {
      void this.applyEdit();
    });

    const acceptButton = actions.createEl("button", { text: "Accept" });
    acceptButton.addClass("mod-cta");
    acceptButton.disabled =
      state.validationFailures.length > 0 ||
      state.ir?.conceptBindings.some(
        (binding) => binding.status === "ambiguous"
      ) === true;
    acceptButton.addEventListener("click", () => {
      void this.accept();
    });

    const rejectReason = editor.createEl("input");
    rejectReason.placeholder = "Rejection reason (optional)";
    rejectReason.style.flex = "1";
    rejectReason.addEventListener("input", () => {
      this.rejectionReason = rejectReason.value;
    });
    const rejectButton = actions.createEl("button", { text: "Reject" });
    rejectButton.addEventListener("click", () => {
      void this.reject();
    });
  }

  private async selectConcept(
    bindingId: string,
    conceptId: string
  ): Promise<void> {
    await this.workflow?.selectConcept(bindingId, conceptId);
    this.render();
  }

  private async applyEdit(): Promise<void> {
    await this.workflow?.edit({
      canonicalStatement: this.statementEdit,
      quantifiers: this.quantifiersEdit,
      conclusion: this.conclusionEdit,
      explicitAssumptions: this.assumptionsEdit
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
    });
    this.render();
  }

  private async reject(): Promise<void> {
    await this.workflow?.reject(this.rejectionReason || undefined);
    this.render();
  }

  private async accept(): Promise<void> {
    const workflow = this.workflow;
    if (workflow === undefined) {
      return;
    }
    const result = await workflow.accept();
    if (!result.ok) {
      this.error = result.error;
      this.render();
      return;
    }
    this.session.commitBrainFormalization(
      workflow,
      result.record,
      result.linkage
    );
    this.successMessage =
      "Semantic lineage saved. IR " + result.linkage.irId +
      " → Formalization " + result.linkage.recordId + ".";
    this.error = "";
    this.render();
  }
}
