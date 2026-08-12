import { App, Modal, Setting } from "obsidian";
import {
  CLAIM_KINDS,
  getClaimVerification,
  normalizeSourceReferences
} from "./ClaimClassification";
import type {
  ClaimKind,
  ClaimReviewItem
} from "./ClaimClassification";
import type { LainBrainSession } from "./LainBrainSession";
import type {
  FormalizationRecord,
  ReviewStatus,
  FormalizationAssumption,
  LeanArtifact,
  LeanDiagnostic,
  LeanEligibilityResult
} from "./FormalizationProtocol";
import { checkLeanEligibility } from "./FormalizationProtocol";
import { LainBrainMarkdownRenderBatch } from "./LainBrainMarkdownRenderer";
import { makeReadOnlyTextSelectable } from "./SelectableText";

interface ClaimReviewRow {
  item: ClaimReviewItem;
}

const KIND_LABELS: Record<ClaimKind, string> = {
  personal_interpretation: "Personal interpretation",
  factual_claim: "Factual claim",
  open_question: "Open question",
  formal_statement: "Formal statement"
};

const SPEECH_ACT_LABELS: Record<string, string> = {
  definition_candidate: "Definition candidate",
  equivalence_claim: "Equivalence claim",
  theorem_claim: "Theorem claim",
  conjecture: "Conjecture",
  proof_sketch: "Proof sketch",
  intuition: "Intuition"
};

export class ReviewClaimsModal extends Modal {
  private rows: ClaimReviewRow[] = [];
  private loading = true;
  private closed = false;
  private error = "";
  private formalizingClaimIds = new Set<string>();
  private formalizationError = "";
  private readonly markdownRenderer: LainBrainMarkdownRenderBatch;
  private previewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private previewCleanups = new Map<string, () => void>();

  // ── Apply UX state ───────────────────────────────────────────
  private successMessage = "";
  private committedIds = new Set<string>();
  private pendingScrollTarget: string | null = null;

  // ── Batch formalize state ────────────────────────────────────
  private batchFormalizing = false;
  private batchFormalizeProgress: {
    total: number;
    completed: number;
    failed: number;
  } | null = null;
  private batchFormalizeMessage = "";

  // ── Collapse state for formalization cards ───────────────────
  // Accept/Reject → auto-collapse.  Expand button → remove.
  // Applied rows' accepted formalizations start collapsed.
  private collapsedFormalizations = new Set<string>();
  // Tracks formalizations the user explicitly expanded.
  // Prevents re-collapsing on re-render.
  private manuallyExpandedFormalizations = new Set<string>();

  constructor(
    app: App,
    private session: LainBrainSession,
    private candidateId: string
  ) {
    super(app);
    this.markdownRenderer = new LainBrainMarkdownRenderBatch(app);
  }

  onOpen(): void {
    this.render();
    void this.loadSuggestions();
  }

  onClose(): void {
    this.closed = true;
    this.clearPreviews();
    this.markdownRenderer.destroy();
    this.contentEl.empty();
  }

  private async loadSuggestions(): Promise<void> {
    const result = await this.session.generateClaimReview(
      this.candidateId
    );

    if (this.closed) {
      return;
    }

    this.loading = false;

    if (result.ok) {
      this.rows = result.items.map((item) => ({
        item
      }));
      this.error = "";
    } else {
      this.error = result.error;
    }

    this.render();
  }

  private clearPreviews(): void {
    for (const timer of this.previewTimers.values()) {
      clearTimeout(timer);
    }
    this.previewTimers.clear();

    for (const cleanup of this.previewCleanups.values()) {
      cleanup();
    }
    this.previewCleanups.clear();

    this.markdownRenderer.reset();
  }

  /**
   * Returns true when a formal claim is ready for Apply:
   * non-formal claims are always ready; formal claims need
   * a current accepted formalization.
   */
  private isClaimApplyReady(row: ClaimReviewRow): boolean {
    if (row.item.kind !== "formal_statement") {
      return true;
    }

    const current =
      this.session.getCurrentFormalizationPreviewForSuggestion(
        row.item.id,
        row.item.text,
        row.item.kind
      );

    return current?.record.reviewStatus === "accepted";
  }

  private countBlockedFormalClaims(): number {
    let count = 0;
    for (const row of this.rows) {
      if (this.committedIds.has(row.item.id)) {
        continue;
      }
      if (row.item.kind === "formal_statement" && !this.isClaimApplyReady(row)) {
        count += 1;
      }
    }
    return count;
  }

  private anchorModalScrollRoots(): void {
    this.contentEl.scrollTop = 0;
    this.modalEl.scrollTop = 0;

    const modalContainer = this.modalEl.parentElement;
    if (modalContainer?.classList.contains("modal-container") === true) {
      modalContainer.scrollTop = 0;
    }
  }

  private keepModalRootsAnchoredAfterLayout(): void {
    this.anchorModalScrollRoots();

    const view = this.contentEl.ownerDocument.defaultView;
    view?.requestAnimationFrame(() => {
      if (!this.closed) {
        this.anchorModalScrollRoots();
      }
    });
  }

  // ── Batch formalize ──────────────────────────────────────────

  /**
   * Eligibility predicate for batch formalization.
   *
   * A claim is eligible when ALL of:
   *   - kind === "formal_statement"
   *   - Not already committed (applied)
   *   - Not currently formalizing
   *   - Does NOT have a current non-stale formalization preview
   *     (accepted/rejected/pending that isn't stale)
   *
   * Claims with a stale preview are NOT automatically eligible —
   * the user should explicitly re-formalize stale previews.
   */
  private isEligibleForBatchFormalize(row: ClaimReviewRow): boolean {
    if (row.item.kind !== "formal_statement") {
      return false;
    }

    if (this.committedIds.has(row.item.id)) {
      return false;
    }

    if (this.formalizingClaimIds.has(row.item.id)) {
      return false;
    }

    // Check for existing non-stale preview
    const previews =
      this.session.getFormalizationPreviewsForSuggestion(row.item.id);
    const hasCurrentPreview = previews.some((p) => {
      const stale = this.session.isFormalizationStale(
        p.record.id,
        row.item.text,
        row.item.kind
      );
      return stale === false; // current (non-stale) preview exists
    });

    return !hasCurrentPreview;
  }

  private getBatchEligibleCount(): number {
    return this.rows.filter((r) => this.isEligibleForBatchFormalize(r)).length;
  }

  // ── Per-row formalize action / status ────────────────────────
  //
  // States (formal_statement only):
  //   A. No current preview          → [Formalize]
  //   B. Currently formalizing       → [Formalizing…] disabled
  //   C. Current preview, pending    → [Formalized ✓] [Review]
  //   D. Accepted                    → [Accepted ✓]
  //   E. Rejected                    → [Rejected] [Re-formalize]
  //   F. Stale preview               → [⚠ Stale] [Re-formalize]

  private renderFormalizeAction(
    rightActions: HTMLElement,
    row: ClaimReviewRow
  ): void {
    const isFormalizing = this.formalizingClaimIds.has(row.item.id);
    const previews =
      this.session.getFormalizationPreviewsForSuggestion(row.item.id);

    // Use the same exact suggestion identity + source snapshot predicate as
    // the Apply guard. Any preview outside it is stale for this row.
    const currentPreview =
      this.session.getCurrentFormalizationPreviewForSuggestion(
        row.item.id,
        row.item.text,
        row.item.kind
      );
    const stalePreview = currentPreview === undefined
      ? previews[previews.length - 1]
      : undefined;

    // ── B. Currently formalizing ──────────────────────────
    if (isFormalizing) {
      const btn = rightActions.createEl("button", {
        text: "Formalizing..."
      });
      btn.disabled = true;
      return;
    }

    // ── D. Accepted ───────────────────────────────────────
    if (currentPreview !== undefined &&
        currentPreview.record.reviewStatus === "accepted") {
      const badge = rightActions.createEl("span");
      badge.style.color = "var(--color-green)";
      badge.style.fontWeight = "700";
      badge.style.fontSize = "0.85em";
      badge.setText("Accepted ✓");
      return;
    }

    // ── E. Rejected ───────────────────────────────────────
    if (currentPreview !== undefined &&
        currentPreview.record.reviewStatus === "rejected") {
      const badge = rightActions.createEl("span");
      badge.style.color = "var(--text-error)";
      badge.style.fontWeight = "700";
      badge.style.fontSize = "0.85em";
      badge.setText("Rejected");

      const reFormalizeBtn = rightActions.createEl("button", {
        text: "Re-formalize"
      });
      reFormalizeBtn.addEventListener("click", async () => {
        this.formalizingClaimIds.add(row.item.id);
        this.formalizationError = "";
        this.render();
        const result = await this.session.generateFormalization(
          this.candidateId,
          row.item.id,
          row.item
        );
        this.formalizingClaimIds.delete(row.item.id);
        if (!result.ok) {
          this.formalizationError = result.error;
        }
        this.render();
      });
      return;
    }

    // ── F. Stale preview (no current, but stale exists) ────
    if (currentPreview === undefined && stalePreview !== undefined) {
      const badge = rightActions.createEl("span");
      badge.style.color = "var(--text-warning)";
      badge.style.fontWeight = "700";
      badge.style.fontSize = "0.85em";
      badge.setText("⚠ Stale");

      const reFormalizeBtn = rightActions.createEl("button", {
        text: "Re-formalize"
      });
      reFormalizeBtn.addEventListener("click", async () => {
        this.formalizingClaimIds.add(row.item.id);
        this.formalizationError = "";
        this.render();
        const result = await this.session.generateFormalization(
          this.candidateId,
          row.item.id,
          row.item
        );
        this.formalizingClaimIds.delete(row.item.id);
        if (!result.ok) {
          this.formalizationError = result.error;
        }
        this.render();
      });
      return;
    }

    // ── C. Current preview, pending ────────────────────────
    if (currentPreview !== undefined &&
        currentPreview.record.reviewStatus === "pending") {
      const badge = rightActions.createEl("span");
      badge.style.color = "var(--color-green)";
      badge.style.fontWeight = "600";
      badge.style.fontSize = "0.85em";
      badge.setText("Formalized ✓");

      const reviewBtn = rightActions.createEl("button", {
        text: "Review"
      });
      reviewBtn.addEventListener("click", () => {
        // Expand the formalization card so user can review it.
        // Scroll to this claim row's formalizations section.
        this.collapsedFormalizations.delete(
          currentPreview!.record.id
        );
        this.pendingScrollTarget = row.item.id;
        this.render();
      });
      return;
    }

    // ── A. No preview → [Formalize] ────────────────────────
    const formalizeBtn = rightActions.createEl("button", {
      text: "Formalize"
    });
    formalizeBtn.disabled = this.session.loading;
    formalizeBtn.addEventListener("click", async () => {
      this.formalizingClaimIds.add(row.item.id);
      this.formalizationError = "";
      this.render();

      const result = await this.session.generateFormalization(
        this.candidateId,
        row.item.id,
        row.item
      );

      this.formalizingClaimIds.delete(row.item.id);

      if (!result.ok) {
        this.formalizationError = result.error;
      }

      this.render();
    });
  }

  private async runBatchFormalize(): Promise<void> {
    const eligible = this.rows.filter((r) =>
      this.isEligibleForBatchFormalize(r)
    );

    if (eligible.length === 0) {
      return;
    }

    this.batchFormalizing = true;
    this.batchFormalizeProgress = {
      total: eligible.length,
      completed: 0,
      failed: 0
    };
    this.batchFormalizeMessage = "";
    this.formalizationError = "";
    this.render();

    // Concurrency limit of 2
    const CONCURRENCY = 2;
    let index = 0;
    let completed = 0;
    let failed = 0;

    const processNext = async (): Promise<void> => {
      while (index < eligible.length) {
        const currentIdx = index;
        index += 1;
        const row = eligible[currentIdx]!;

        this.formalizingClaimIds.add(row.item.id);
        this.render();

        const result = await this.session.generateFormalization(
          this.candidateId,
          row.item.id,
          row.item
        );

        this.formalizingClaimIds.delete(row.item.id);

        if (result.ok) {
          completed += 1;
        } else {
          failed += 1;
        }

        this.batchFormalizeProgress = {
          total: eligible.length,
          completed,
          failed
        };
        this.render();
      }
    };

    // Start CONCURRENCY parallel workers
    const workers = Array.from({ length: CONCURRENCY }, () =>
      processNext()
    );
    await Promise.all(workers);

    this.batchFormalizing = false;

    if (failed > 0) {
      this.batchFormalizeMessage =
        `Formalized ${completed} claim${completed !== 1 ? "s" : ""}. ` +
        `${failed} failed.`;
    } else {
      this.batchFormalizeMessage =
        `Formalized ${completed} claim${completed !== 1 ? "s" : ""}.`;
    }

    this.render();
  }

  private render(): void {
    // ── Capture scroll position of the existing scroll container ──
    const existingList = this.contentEl.querySelector(
      '[data-scroll-container]'
    ) as HTMLElement | null;
    const savedScrollTop = existingList?.scrollTop ?? 0;

    this.clearPreviews();
    this.setTitle("Review Claims");
    this.contentEl.empty();
    // The content root is a viewport-constrained three-part column. The
    // claims list below is the only intentional scroll surface.
    this.contentEl.style.display = "flex";
    this.contentEl.style.flexDirection = "column";
    this.contentEl.style.height = "80vh";
    this.contentEl.style.maxHeight = "80vh";
    this.contentEl.style.minHeight = "0";
    this.contentEl.style.overflowY = "hidden";
    this.contentEl.style.overflowAnchor = "none";
    this.modalEl.style.overflow = "hidden";
    this.modalEl.style.overflowAnchor = "none";
    this.anchorModalScrollRoots();

    const header = this.contentEl.createDiv();
    header.setAttr("data-review-claims-header", "true");
    header.style.flex = "0 0 auto";
    header.createEl("p", {
      text:
        "Review each suggestion. Edit or delete unwanted claims before applying."
    });

    if (this.loading) {
      header.createEl("p", {
        text: "Preparing claim suggestions..."
      });
      const loadingBody = this.contentEl.createDiv();
      loadingBody.setAttr("data-scroll-container", "true");
      this.styleClaimsScrollContainer(loadingBody);
      const footer = this.createFooterRegion();
      this.renderFooter(footer);
      this.keepModalRootsAnchoredAfterLayout();
      return;
    }

    if (this.error !== "") {
      const errorEl = header.createEl("p", {
        text: this.error
      });
      errorEl.style.color = "var(--text-error)";
    }

    if (this.formalizationError !== "") {
      const fe = header.createEl("p", {
        text: this.formalizationError
      });
      fe.style.color = "var(--text-error)";
    }

    if (this.successMessage !== "") {
      const successEl = header.createEl("p", {
        text: this.successMessage
      });
      successEl.style.color = "var(--color-green)";
      successEl.style.fontWeight = "600";
    }

    if (this.batchFormalizeMessage !== "") {
      const batchMsg = header.createEl("p", {
        text: this.batchFormalizeMessage
      });
      batchMsg.style.color =
        this.batchFormalizeProgress !== null &&
        this.batchFormalizeProgress.failed > 0
          ? "var(--text-warning)"
          : "var(--color-green)";
      batchMsg.style.fontWeight = "600";
    }

    // ── Batch formalize action area ──────────────────────────
    const batchActions = header.createDiv();
    batchActions.style.display = "flex";
    batchActions.style.alignItems = "center";
    batchActions.style.gap = "0.5rem";
    batchActions.style.marginBottom = "0.5rem";

    const eligibleCount = this.getBatchEligibleCount();
    const batchBtn = batchActions.createEl("button", {
      text: this.batchFormalizing
        ? `Formalizing ${(this.batchFormalizeProgress?.completed ?? 0) + 1} / ${this.batchFormalizeProgress?.total ?? 0}...`
        : `Formalize formal claims (${eligibleCount})`
    });
    batchBtn.disabled =
      this.batchFormalizing ||
      eligibleCount === 0 ||
      this.loading;
    batchBtn.addEventListener("click", () => {
      void this.runBatchFormalize();
    });

    if (eligibleCount === 0 && !this.batchFormalizing) {
      const hint = batchActions.createEl("span");
      hint.style.color = "var(--text-muted)";
      hint.style.fontSize = "0.85em";
      hint.setText("No pending formal claims");
    }

    const list = this.contentEl.createDiv();
    list.setAttr("data-scroll-container", "true");
    this.styleClaimsScrollContainer(list);

    for (const row of this.rows) {
      this.renderRow(list, row);
    }

    const footer = this.createFooterRegion();
    const addButton = footer.createEl("button", {
      text: "Add claim"
    });
    addButton.addEventListener("click", () => {
      this.error = "";
      this.formalizationError = "";
      this.successMessage = "";
      this.pendingScrollTarget = null;

      const item = this.session.createEmptyClaimReviewItem(
        this.candidateId
      );

      if (item === null) {
        this.error =
          "Candidate is unavailable for claim review.";
        this.render();
        return;
      }

      this.rows.push({ item });
      this.render();
    });

    this.renderFooter(footer);

    // ── Restore scroll position ────────────────────────────────
    const newList = this.contentEl.querySelector(
      '[data-scroll-container]'
    ) as HTMLElement | null;

    if (newList !== null) {
      newList.scrollTop = savedScrollTop;
    }

    // ── Scroll to offending claim if requested ──────────────────
    if (this.pendingScrollTarget !== null) {
      const targetCard = this.contentEl.querySelector(
        `[data-claim-id="${this.pendingScrollTarget}"]`
      ) as HTMLElement | null;

      if (targetCard !== null && newList !== null) {
        revealWithinScrollContainer(newList, targetCard);
      }

      this.pendingScrollTarget = null;
    }

    this.keepModalRootsAnchoredAfterLayout();

    // ── Diagnostic: after-render state ────────────────────────
    const appliedBadgeCount = this.contentEl.querySelectorAll(
      '[data-applied="true"]'
    ).length;
    console.log(JSON.stringify({
      event: "review-claims-after-render",
      successMessage: this.successMessage || null,
      errorMessage: this.error || this.formalizationError || null,
      committedIds: [...this.committedIds],
      appliedBadgeCount
    }));
  }

  private styleClaimsScrollContainer(container: HTMLElement): void {
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.flex = "1 1 auto";
    container.style.minHeight = "0";
    container.style.gap = "0.75rem";
    container.style.overflowY = "auto";
    container.style.position = "relative";
  }

  private createFooterRegion(): HTMLElement {
    const footer = this.contentEl.createDiv();
    footer.setAttr("data-review-claims-footer", "true");
    footer.style.display = "flex";
    footer.style.alignItems = "center";
    footer.style.justifyContent = "space-between";
    footer.style.gap = "0.75rem";
    footer.style.flex = "0 0 auto";
    footer.style.flexShrink = "0";
    footer.style.paddingTop = "0.75rem";
    footer.style.borderTop =
      "1px solid var(--background-modifier-border)";
    footer.style.backgroundColor = "var(--background-primary)";
    return footer;
  }
  private renderRow(
    container: HTMLElement,
    row: ClaimReviewRow
  ): void {
    const card = container.createDiv();
    card.setAttr("data-claim-id", row.item.id);
    card.style.border =
      "1px solid var(--background-modifier-border)";
    card.style.borderRadius = "4px";
    card.style.padding = "0.75rem";

    const isCommitted = this.committedIds.has(row.item.id);

    if (isCommitted) {
      card.setAttr("data-applied", "true");
      card.style.opacity = "0.65";
      card.style.backgroundColor = "var(--background-secondary)";
    }

    const header = card.createDiv();
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "0.5rem";
    header.style.flexWrap = "wrap";

    const leftActions = header.createDiv();
    leftActions.style.display = "flex";
    leftActions.style.alignItems = "center";
    leftActions.style.gap = "0.4rem";

    if (isCommitted) {
      const appliedBadge = leftActions.createEl("span");
      appliedBadge.style.color = "var(--color-green)";
      appliedBadge.style.fontWeight = "700";
      appliedBadge.style.fontSize = "0.85em";
      appliedBadge.setText("✓ Applied");
    }

    const rightActions = header.createDiv();
    rightActions.style.display = "flex";
    rightActions.style.alignItems = "center";
    rightActions.style.gap = "0.4rem";

    // ── Per-row formalization action / status ──────────────────
    // Keep this sub-container independently refreshable while the claim
    // textarea retains focus. Its badge must always reflect current text.
    const formalizeActions = rightActions.createDiv();
    formalizeActions.style.display = "contents";
    if (row.item.kind === "formal_statement" && !isCommitted) {
      this.renderFormalizeAction(formalizeActions, row);
    }

    const deleteButton = rightActions.createEl("button", {
      text: "Delete suggestion"
    });
    deleteButton.disabled = isCommitted;
    deleteButton.addEventListener("click", () => {
      const committedFormalizations =
        this.session.getFormalizationsForClaim(row.item.id);
      const suggestionPreviews =
        this.session.getFormalizationPreviewsForSuggestion(row.item.id);

      // Committed claims with formalization history block deletion
      if (committedFormalizations.length > 0) {
        this.formalizationError =
          "This claim has formalization history. " +
          "Reject or unlink it instead.";
        this.render();
        return;
      }

      // Uncommitted suggestion — clean up ephemeral formalization previews
      if (suggestionPreviews.length > 0) {
        this.session.deleteAllFormalizationsForSuggestionId(
          row.item.id
        );
      }

      this.rows = this.rows.filter((item) => item !== row);
      this.render();
    });

    const claimLabel = card.createEl("label", {
      text: "Claim text"
    });
    claimLabel.style.display = "block";
    claimLabel.style.marginTop = "0.5rem";
    const claimText = card.createEl("textarea");
    claimText.value = row.item.text;
    claimText.rows = 3;
    claimText.style.width = "100%";
    claimText.style.resize = "vertical";
    claimText.readOnly = isCommitted;
    if (isCommitted) {
      claimText.style.color = "var(--text-muted)";
    }

    // Rendered preview below claim text
    const claimPreviewEl = card.createDiv();
    claimPreviewEl.setAttr("data-rendered-claim-preview", row.item.id);
    claimPreviewEl.addClass("markdown-rendered");
    claimPreviewEl.style.padding = "0.3rem 0.6rem";
    claimPreviewEl.style.marginTop = "0.2rem";
    claimPreviewEl.style.border =
      "1px solid var(--background-modifier-border)";
    claimPreviewEl.style.borderRadius = "3px";
    claimPreviewEl.style.fontSize = "0.9em";
    claimPreviewEl.style.maxHeight = "200px";
    claimPreviewEl.style.overflowY = "auto";
    claimPreviewEl.style.backgroundColor =
      "var(--background-primary)";

    const claimPreviewLabel = card.createEl("small", {
      text: "Rendered preview"
    });
    claimPreviewLabel.style.color = "var(--text-muted)";
    claimPreviewLabel.style.display = "block";
    claimPreviewLabel.style.marginTop = "0.15rem";

    const scheduleClaimPreview = (): void => {
      this.schedulePreview(
        "claim-" + row.item.id,
        claimText.value,
        claimPreviewEl,
        this.session.activeNoteSourcePath
      );
    };

    claimText.addEventListener("input", () => {
      row.item.text = claimText.value;
      scheduleClaimPreview();

      // Refresh both the compact status badge and the details. Previously
      // only the details changed, leaving a stale "Accepted ✓" badge visible
      // while Apply correctly rejected the changed source snapshot.
      formalizeActions.empty();
      if (row.item.kind === "formal_statement" && !isCommitted) {
        this.renderFormalizeAction(formalizeActions, row);
      }

      const formSection = card.querySelector(
        '[data-section="formalizations"]'
      ) as HTMLElement | null;

      if (formSection !== null) {
        formSection.empty();
        this.renderFormalizationsContent(formSection, row.item);
      }
    });

    // Initial preview
    if (claimText.value.trim() !== "") {
      scheduleClaimPreview();
    }

    const kindSetting = new Setting(card)
      .setName("Kind")
      .setDisabled(isCommitted);

    kindSetting.addDropdown((dropdown) => {
      for (const kind of CLAIM_KINDS) {
        dropdown.addOption(kind, KIND_LABELS[kind]);
      }

      dropdown.setValue(row.item.kind);
      dropdown.onChange((value) => {
        if (!(CLAIM_KINDS as readonly string[]).includes(value)) {
          return;
        }

        row.item.kind = value as ClaimKind;
        row.item.verification = getClaimVerification(
          row.item.kind,
          row.item.sourceReferences,
          row.item.sourceReferences.length > 0
            ? "source_cited"
            : row.item.verification
        );
        this.render();
      });
    });

    const verification = card.createEl("p", {
      text:
        "Verification: " +
        formatVerification(
          getClaimVerification(
            row.item.kind,
            row.item.sourceReferences,
            row.item.verification
          )
        )
    });
    verification.style.margin = "0.25rem 0";
    verification.style.color = "var(--text-muted)";

    if (row.item.kind === "formal_statement") {
      const leanStatus = card.createEl("p", {
        text: "Ready for Lean review"
      });
      leanStatus.style.margin = "0.25rem 0";
      leanStatus.style.color = "var(--text-muted)";
    }

    const sourcesLabel = card.createEl("label", {
      text: "Source references"
    });
    sourcesLabel.style.display = "block";
    const sources = card.createEl("textarea");
    sources.value = row.item.sourceReferences.join("\n");
    sources.rows = 2;
    sources.readOnly = isCommitted;
    if (isCommitted) {
      sources.style.color = "var(--text-muted)";
    }
    sources.setAttr(
      "placeholder",
      "One exact URL, citation, or bibliography reference per line"
    );
    sources.style.width = "100%";
    sources.style.resize = "vertical";
    sources.addEventListener("input", () => {
      row.item.sourceReferences = normalizeSourceReferences(
        sources.value.split(/\r?\n/)
      );
      row.item.verification = getClaimVerification(
        row.item.kind,
        row.item.sourceReferences,
        row.item.sourceReferences.length > 0
          ? "source_cited"
          : undefined
      );
      verification.setText(
        "Verification: " +
        formatVerification(row.item.verification)
      );
    });

    card.createEl("small", {
      text:
        "Source message references: " +
        row.item.sourceMessageIds.length
    });

    // ── Formalization section ──────────────────────────────
    const formalizationContainer = card.createDiv();
    formalizationContainer.setAttr("data-section", "formalizations");
    formalizationContainer.setAttr("data-claim-id", row.item.id);
    this.renderFormalizationsContent(formalizationContainer, row.item);
  }

  private renderFormalizationsContent(
    container: HTMLElement,
    rowItem: ClaimReviewItem
  ): void {
    const committedFormalizations =
      this.session.getFormalizationsForClaim(rowItem.id);
    const suggestionPreviews =
      this.session.getFormalizationPreviewsForSuggestion(rowItem.id);

    const totalCount =
      committedFormalizations.length + suggestionPreviews.length;

    if (totalCount === 0) {
      return;
    }

    const section = container.createDiv();
    section.style.marginTop = "0.75rem";
    section.style.padding = "0.5rem";
    section.style.border =
      "1px dashed var(--background-modifier-border)";
    section.style.borderRadius = "4px";
    section.style.backgroundColor =
      "var(--background-secondary)";

    const heading = section.createEl("strong", {
      text:
        `Formalizations (${totalCount})`
    });
    heading.style.display = "block";
    heading.style.marginBottom = "0.5rem";

    // Render committed formalizations
    for (const record of committedFormalizations) {
      // Auto-collapse committed + accepted formalizations only when
      // the Lean statement has already been checked.  Keep
      // not_checked formalizations expanded so the user sees
      // "Generate and check Lean statement" immediately after Apply.
      if (
        record.reviewStatus === "accepted" &&
        record.verificationStatus !== "not_checked" &&
        !this.manuallyExpandedFormalizations.has(record.id)
      ) {
        this.collapsedFormalizations.add(record.id);
      }
      this.renderFormalizationRecord(section, record, rowItem);
    }

    // Render ephemeral suggestion previews
    for (const preview of suggestionPreviews) {
      // Pass the preview's record; staleness is checked via
      // isFormalizationStale which looks up the preview by recordId
      this.renderFormalizationRecord(section, preview.record, rowItem);
    }
  }

  private renderFormalizationRecord(
    container: HTMLElement,
    record: Readonly<FormalizationRecord>,
    rowItem?: ClaimReviewItem
  ): void {
    const isCollapsed = this.collapsedFormalizations.has(record.id);

    // ── Collapsed view ─────────────────────────────────────
    if (isCollapsed) {
      this.renderCollapsedFormalization(container, record);
      return;
    }

    // ── Full expanded view ─────────────────────────────────
    const card = container.createDiv();
    card.style.border =
      "1px solid var(--background-modifier-border)";
    card.style.borderRadius = "4px";
    card.style.padding = "0.6rem";
    card.style.marginBottom = "0.5rem";
    card.style.backgroundColor =
      "var(--background-primary)";

    // Header: speech act + status
    const header = card.createDiv();
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.flexWrap = "wrap";
    header.style.gap = "0.4rem";
    header.style.marginBottom = "0.5rem";

    const actLabel = SPEECH_ACT_LABELS[record.speechAct] ??
      record.speechAct;
    header.createEl("strong", {
      text: actLabel
    });

    // ── Staleness indicator ──────────────────────────────────
    if (rowItem !== undefined) {
      const stale = this.session.isFormalizationStale(
        record.id,
        rowItem.text,
        rowItem.kind
      );

      if (stale === true) {
        const staleBadge = card.createDiv();
        staleBadge.style.color = "var(--text-warning)";
        staleBadge.style.fontWeight = "700";
        staleBadge.style.fontSize = "0.85em";
        staleBadge.style.marginTop = "0.3rem";
        staleBadge.setText(
          "⚠️ Stale — claim text or kind changed since formalization. " +
          "Re-formalize before applying."
        );
      }

      if (stale === false) {
        const freshBadge = card.createDiv();
        freshBadge.style.color = "var(--color-green)";
        freshBadge.style.fontSize = "0.8em";
        freshBadge.style.marginTop = "0.15rem";
        freshBadge.setText("✓ Preview matches current claim");
      }
    }

    // Three orthogonal status dimensions
    const statusLine = card.createDiv();
    statusLine.style.display = "flex";
    statusLine.style.flexWrap = "wrap";
    statusLine.style.gap = "0.3rem 1rem";
    statusLine.style.marginTop = "0.3rem";
    statusLine.style.fontSize = "0.85em";

    const analysisColor = record.analysisStatus === "needs_clarification"
      ? "var(--text-warning)"
      : "var(--text-muted)";
    statusLine.createEl("span", {
      text: "Analysis: " + record.analysisStatus.replace("_", " ")
    }).style.color = analysisColor;

    const reviewColor = record.reviewStatus === "accepted"
      ? "var(--color-green)"
      : record.reviewStatus === "rejected"
        ? "var(--text-error)"
        : "var(--text-muted)";
    statusLine.createEl("span", {
      text: "Review: " + record.reviewStatus
    }).style.color = reviewColor;

    const verifyColor = record.verificationStatus === "error"
      ? "var(--text-error)"
      : "var(--text-muted)";
    statusLine.createEl("span", {
      text: "Verification: " + record.verificationStatus.replace("_", " ")
    }).style.color = verifyColor;

    // Source refs
    if (record.sourceRefs.length > 0) {
      const sourceBlock = card.createDiv();
      sourceBlock.style.marginBottom = "0.4rem";
      sourceBlock.createEl("small", {
        text: `Sources (${record.sourceRefs.length})`
      });

      for (const ref of record.sourceRefs) {
        const refBlock = sourceBlock.createDiv();
        refBlock.style.margin = "2px 0";
        refBlock.style.padding = "0.3rem 0.6rem";
        refBlock.style.backgroundColor =
          "var(--background-secondary)";
        refBlock.style.borderRadius = "3px";
        refBlock.style.maxHeight = "80px";
        refBlock.style.overflowY = "auto";

        const refMeta = refBlock.createEl("small");
        refMeta.style.color = "var(--text-muted)";
        const rangeInfo = ref.startOffset !== undefined &&
          ref.endOffset !== undefined
          ? ` [${ref.startOffset}:${ref.endOffset}]`
          : "";
        refMeta.setText(
          "message: " + ref.messageId + rangeInfo
        );
        refMeta.style.display = "block";

        // Rendered preview for source snapshot (Markdown + LaTeX)
        const srcPreviewEl = refBlock.createDiv();
        srcPreviewEl.addClass("markdown-rendered");
        srcPreviewEl.style.padding = "0.2rem 0.4rem";
        srcPreviewEl.style.marginTop = "0.15rem";
        srcPreviewEl.style.fontSize = "0.85em";
        srcPreviewEl.style.maxHeight = "120px";
        srcPreviewEl.style.overflowY = "auto";
        this.markdownRenderer.render(
          ref.snapshot,
          srcPreviewEl,
          this.session.activeNoteSourcePath
        );
        this.registerPreviewCleanup(
          "src-" + ref.messageId,
          srcPreviewEl
        );
      }
    }

    // Objects
    if (record.objects.length > 0) {
      const objBlock = card.createDiv();
      objBlock.style.marginTop = "0.3rem";
      objBlock.createEl("small", {
        text: "Objects:"
      }).style.color = "var(--text-muted)";

      const objList = objBlock.createEl("ul");
      objList.style.margin = "2px 0";
      objList.style.paddingLeft = "1.2rem";

      for (const obj of record.objects) {
        const item = objList.createEl("li");
        const label = obj.latex !== undefined
          ? `${obj.name} ($${obj.latex}$)`
          : obj.name;
        this.renderInlineMarkdown(item, label);
      }
    }

    // Assumptions
    this.renderAssumptions(
      card,
      "Explicit assumptions",
      record.explicitAssumptions,
      false
    );
    this.renderAssumptions(
      card,
      "Implicit assumptions (AI-added) ⚠️",
      record.implicitAssumptions,
      true
    );

    // Quantifiers
    this.renderMarkdownField(card, "Quantifiers", record.quantifiers);

    // Conclusion
    this.renderMarkdownField(card, "Conclusion", record.conclusion);

    // Ambiguities
    if (record.ambiguities.length > 0) {
      const ambBlock = card.createDiv();
      ambBlock.style.marginTop = "0.3rem";
      const ambLabel = ambBlock.createEl("small");
      ambLabel.style.color = "var(--text-warning)";
      ambLabel.style.display = "block";
      ambLabel.setText("Ambiguities:");

      const ambList = ambBlock.createEl("ul");
      ambList.style.margin = "2px 0";
      ambList.style.paddingLeft = "1.2rem";

      for (const ambiguity of record.ambiguities) {
        const li = ambList.createEl("li");
        this.renderInlineMarkdown(li, ambiguity);
      }
    }

    // Missing conditions
    if (record.missingConditions.length > 0) {
      const mcBlock = card.createDiv();
      mcBlock.style.marginTop = "0.3rem";
      const mcLabel = mcBlock.createEl("small");
      mcLabel.style.color = "var(--text-warning)";
      mcLabel.style.display = "block";
      mcLabel.setText("Missing conditions:");

      const mcList = mcBlock.createEl("ul");
      mcList.style.margin = "2px 0";
      mcList.style.paddingLeft = "1.2rem";

      for (const condition of record.missingConditions) {
        const li = mcList.createEl("li");
        this.renderInlineMarkdown(li, condition);
      }
    }

    // AI Normalized Statement (immutable, rendered as Markdown)
    this.renderMarkdownField(
      card,
      "AI Normalized Statement (immutable)",
      record.aiNormalizedStatement
    );

    if (record.latexStatement !== undefined) {
      const latexMath = record.latexStatement.includes("$$")
        ? record.latexStatement
        : "$$\n" + record.latexStatement + "\n$$";
      this.renderMarkdownField(card, "LaTeX Statement", latexMath);
    }

    // Reviewed Statement (editable)
    const reviewedBlock = card.createDiv();
    reviewedBlock.style.marginTop = "0.4rem";
    reviewedBlock.createEl("label", {
      text: "Reviewed Statement (editable):"
    }).style.display = "block";

    const reviewedTextarea =
      reviewedBlock.createEl("textarea");
    reviewedTextarea.value = record.reviewedStatement;
    reviewedTextarea.rows = 3;
    reviewedTextarea.style.width = "100%";
    reviewedTextarea.style.resize = "vertical";
    reviewedTextarea.style.fontSize = "0.9em";

    let currentReviewed =
      record.reviewedStatement;

    // Rendered preview for reviewed statement
    const reviewedPreviewEl = reviewedBlock.createDiv();
    reviewedPreviewEl.addClass("markdown-rendered");
    reviewedPreviewEl.style.padding = "0.3rem 0.6rem";
    reviewedPreviewEl.style.marginTop = "0.2rem";
    reviewedPreviewEl.style.border =
      "1px solid var(--background-modifier-border)";
    reviewedPreviewEl.style.borderRadius = "3px";
    reviewedPreviewEl.style.fontSize = "0.9em";
    reviewedPreviewEl.style.maxHeight = "200px";
    reviewedPreviewEl.style.overflowY = "auto";
    reviewedPreviewEl.style.backgroundColor =
      "var(--background-primary)";

    const scheduleReviewedPreview = (): void => {
      this.schedulePreview(
        "reviewed-" + record.id,
        reviewedTextarea.value,
        reviewedPreviewEl,
        this.session.activeNoteSourcePath
      );
    };

    reviewedTextarea.addEventListener("input", () => {
      currentReviewed = reviewedTextarea.value;
      scheduleReviewedPreview();
    });

    // Initial preview
    scheduleReviewedPreview();

    // Semantic changes
    if (record.semanticChanges.length > 0) {
      const changesBlock = card.createDiv();
      changesBlock.style.marginTop = "0.4rem";
      changesBlock.createEl("small", {
        text: "Semantic Changes:"
      });

      for (const change of record.semanticChanges) {
        const changeEl = changesBlock.createDiv();
        changeEl.style.fontSize = "0.85em";
        changeEl.style.marginLeft = "0.5rem";

        const prefix = change.category === "added_assumption"
          ? "⚠️ +"
          : change.category === "removed_ambiguity"
            ? "✓"
            : change.category === "strengthened"
              ? "⬆"
              : change.category === "weakened"
                ? "⬇"
                : change.category === "added_condition"
                  ? "⚠️ +"
                  : "→";

        const changeSummary = changeEl.createEl("small");
        this.renderInlineMarkdown(
          changeSummary,
          `${prefix} [${change.category}] ` + change.description
        );

        // Rendered preview for before/after if present
        if (change.before !== undefined || change.after !== undefined) {
          const diffPreview = changeEl.createDiv();
          diffPreview.style.display = "flex";
          diffPreview.style.gap = "0.5rem";
          diffPreview.style.flexWrap = "wrap";
          diffPreview.style.marginTop = "0.15rem";

          if (change.before !== undefined) {
            const beforeBox = diffPreview.createDiv();
            beforeBox.style.flex = "1";
            beforeBox.style.minWidth = "120px";
            beforeBox.createEl("small", {
              text: "before:"
            }).style.color = "var(--text-muted)";
            const beforePreview = beforeBox.createDiv();
            beforePreview.addClass("markdown-rendered");
            beforePreview.style.padding = "0.15rem 0.4rem";
            beforePreview.style.fontSize = "0.85em";
            beforePreview.style.border =
              "1px solid var(--background-modifier-border)";
            beforePreview.style.borderRadius = "3px";
            beforePreview.style.maxHeight = "80px";
            beforePreview.style.overflowY = "auto";
            this.markdownRenderer.render(
              change.before,
              beforePreview,
              this.session.activeNoteSourcePath
            );
            this.registerPreviewCleanup(
              "change-before-" + change.description.slice(0, 20),
              beforePreview
            );
          }

          if (change.after !== undefined) {
            const afterBox = diffPreview.createDiv();
            afterBox.style.flex = "1";
            afterBox.style.minWidth = "120px";
            afterBox.createEl("small", {
              text: "after:"
            }).style.color = "var(--text-muted)";
            const afterPreview = afterBox.createDiv();
            afterPreview.addClass("markdown-rendered");
            afterPreview.style.padding = "0.15rem 0.4rem";
            afterPreview.style.fontSize = "0.85em";
            afterPreview.style.border =
              "1px solid var(--background-modifier-border)";
            afterPreview.style.borderRadius = "3px";
            afterPreview.style.maxHeight = "80px";
            afterPreview.style.overflowY = "auto";
            this.markdownRenderer.render(
              change.after,
              afterPreview,
              this.session.activeNoteSourcePath
            );
            this.registerPreviewCleanup(
              "change-after-" + change.description.slice(0, 20),
              afterPreview
            );
          }
        }
      }
    }

    // User notes
    if (record.userNotes !== undefined) {
      card.createEl("small", {
        text: "Notes: " + record.userNotes
      });
    }

    if (record.rejectionReason !== undefined) {
      const rej = card.createEl("small");
      rej.style.color = "var(--text-error)";
      rej.setText(
        "Rejection reason: " + record.rejectionReason
      );
    }

    if (record.wasEdited) {
      card.createEl("small", {
        text: "(User edited the normalized statement)"
      });
    }

    // Primary indicator and actions
    this.renderPrimaryFormalizationUI(card, record);

    // Actions
    const actions = card.createDiv();
    actions.style.display = "flex";
    actions.style.gap = "0.4rem";
    actions.style.marginTop = "0.5rem";

    // Accept is only available when not already accepted.
    // Once accepted, the record stays accepted unless the user
    // edits the reviewed statement and saves (which preserves the
    // existing review semantics — edits may be applied via Save Edits).
    if (record.reviewStatus !== "accepted") {
      const acceptBtn = actions.createEl("button", {
        text: "Accept"
      });
      acceptBtn.style.padding = "2px 8px";
      acceptBtn.addEventListener("click", () => {
        const result = this.session.applyFormalizationReview(
          record.id,
          "accepted",
          currentReviewed
        );

        if (result.ok) {
          // Accept is semantic approval only. No selection-state mutation.

          // Collapse this accepted formalization only when the Lean
          // statement has already been checked.  not_checked
          // formalizations stay expanded so the action remains visible.
          if (record.verificationStatus !== "not_checked") {
            this.collapsedFormalizations.add(record.id);
          }

          // Find the next pending formalization for scroll
          this.pendingScrollTarget = this.findNextPendingClaimId(
            record,
            rowItem
          );

          this.render();
        } else {
          this.formalizationError = result.error;
          this.render();
        }
      });
    }

    const rejectBtn = actions.createEl("button", {
      text: "Reject"
    });
    rejectBtn.style.padding = "2px 8px";
    rejectBtn.addEventListener("click", () => {
      const reason = promptForRejectionReason();

      if (reason === null) {
        return; // cancelled
      }

      const result =
        this.session.applyFormalizationReview(
          record.id,
          "rejected",
          currentReviewed,
          reason
        );

      if (result.ok) {
        // Collapse this rejected formalization
        this.collapsedFormalizations.add(record.id);
        this.render();
      } else {
        this.formalizationError = result.error;
        this.render();
      }
    });

    const saveBtn = actions.createEl("button", {
      text: "Save Edits"
    });
    saveBtn.style.padding = "2px 8px";
    saveBtn.addEventListener("click", () => {
      const wasPending = record.reviewStatus === "pending";
      const result =
        this.session.applyFormalizationReview(
          record.id,
          record.reviewStatus,
          currentReviewed,
          record.rejectionReason,
          undefined
        );

      if (result.ok) {
        // Only collapse if reviewStatus changed to accepted/rejected
        // and the Lean statement has already been checked.  Save Edits
        // while pending or not_checked keeps the card expanded.
        if (!wasPending && record.verificationStatus !== "not_checked") {
          this.collapsedFormalizations.add(record.id);
        }
        this.render();
      } else {
        this.formalizationError = result.error;
        this.render();
      }
    });

    // Lean section
    this.renderLeanSection(card, record);
  }

  /**
   * Find the claim ID of the next pending formalization after the
   * given accepted/rejected record.  Used for scroll-after-accept.
   */
  private findNextPendingClaimId(
    acceptedRecord: Readonly<FormalizationRecord>,
    rowItem?: ClaimReviewItem
  ): string | null {
    // Determine which claim row this formalization belongs to
    let currentClaimId: string | null = null;
    if (rowItem !== undefined) {
      currentClaimId = rowItem.id;
    }

    let foundCurrent = false;
    for (const row of this.rows) {
      if (foundCurrent) {
        // Check if this row has a pending formalization
        if (this.rowHasPendingFormalization(row)) {
          return row.item.id;
        }
      }

      if (row.item.id === currentClaimId) {
        foundCurrent = true;
      }
    }

    return null;
  }

  private rowHasPendingFormalization(row: ClaimReviewRow): boolean {
    const suggestionPreviews =
      this.session.getFormalizationPreviewsForSuggestion(row.item.id);

    return suggestionPreviews.some((p) => {
      const stale = this.session.isFormalizationStale(
        p.record.id,
        row.item.text,
        row.item.kind
      );
      return (
        p.record.reviewStatus === "pending" &&
        stale === false
      );
    });
  }

  /**
   * Render a collapsed summary card for an accepted/rejected formalization.
   */
  private renderCollapsedFormalization(
    container: HTMLElement,
    record: Readonly<FormalizationRecord>
  ): void {
    const card = container.createDiv();
    card.style.border =
      "1px solid var(--background-modifier-border)";
    card.style.borderRadius = "4px";
    card.style.padding = "0.5rem 0.6rem";
    card.style.marginBottom = "0.5rem";
    card.style.backgroundColor =
      "var(--background-primary)";

    // Header row: speech act + review status + expand button
    const header = card.createDiv();
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.flexWrap = "wrap";
    header.style.gap = "0.4rem";

    const actLabel = SPEECH_ACT_LABELS[record.speechAct] ??
      record.speechAct;
    const leftGroup = header.createDiv();
    leftGroup.style.display = "flex";
    leftGroup.style.alignItems = "center";
    leftGroup.style.gap = "0.5rem";

    leftGroup.createEl("strong", {
      text: actLabel
    });

    // Review status badge
    const reviewColor = record.reviewStatus === "accepted"
      ? "var(--color-green)"
      : record.reviewStatus === "rejected"
        ? "var(--text-error)"
        : "var(--text-muted)";
    const reviewIcon = record.reviewStatus === "accepted"
      ? "✓"
      : record.reviewStatus === "rejected"
        ? "✗"
        : "";
    const reviewBadge = leftGroup.createEl("span");
    reviewBadge.style.color = reviewColor;
    reviewBadge.style.fontWeight = "700";
    reviewBadge.style.fontSize = "0.85em";
    reviewBadge.setText(
      `Review: ${record.reviewStatus} ${reviewIcon}`
    );

    // Verification status
    const verifyColor = record.verificationStatus === "error"
      ? "var(--text-error)"
      : "var(--text-muted)";
    const verifyBadge = leftGroup.createEl("span");
    verifyBadge.style.color = verifyColor;
    verifyBadge.style.fontSize = "0.8em";
    verifyBadge.setText(
      "Verification: " + record.verificationStatus.replace("_", " ")
    );

    // Expand button
    const expandBtn = header.createEl("button", {
      text: "Expand"
    });
    expandBtn.style.padding = "2px 8px";
    expandBtn.style.fontSize = "0.85em";
    expandBtn.addEventListener("click", () => {
      this.collapsedFormalizations.delete(record.id);
      this.manuallyExpandedFormalizations.add(record.id);
      this.render();
    });

    // Short statement preview. This is presentation, not an editor, so it
    // must use the same Markdown/MathJax path as expanded fields.
    const previewText = record.latexStatement !== undefined
      ? ensureLatexPresentation(record.latexStatement)
      : record.aiNormalizedStatement;
    if (previewText.trim() !== "") {
      const preview = card.createDiv();
      preview.setAttr("data-rendered-formalization-preview", record.id);
      preview.style.marginTop = "0.3rem";
      preview.style.fontSize = "0.85em";
      preview.style.color = "var(--text-muted)";
      preview.style.maxHeight = "3em";
      preview.style.overflow = "hidden";
      preview.style.textOverflow = "ellipsis";
      this.renderInlineMarkdown(preview, previewText);
    }
  }

  private renderPrimaryFormalizationUI(
    card: HTMLElement,
    record: Readonly<FormalizationRecord>
  ): void {
    // Find the claim containing this formalization
    const claims = this.session.getCandidateClaims(this.candidateId);
    const claim = claims.find(
      (c) => c.formalizationIds?.includes(record.id)
    );

    if (claim === undefined) {
      return;
    }

    const isPrimary = claim.primaryFormalizationId === record.id;

    const primaryRow = card.createDiv();
    primaryRow.style.display = "flex";
    primaryRow.style.alignItems = "center";
    primaryRow.style.gap = "0.4rem";
    primaryRow.style.marginTop = "0.4rem";

    if (isPrimary) {
      const badge = primaryRow.createEl("span");
      badge.setText("★ Primary");
      badge.style.color = "#7c3aed";
      badge.style.fontWeight = "700";
      badge.style.fontSize = "0.85em";
    }

    if (!isPrimary && record.reviewStatus !== "rejected") {
      const setPrimaryBtn = primaryRow.createEl("button", {
        text: "Set as primary"
      });
      setPrimaryBtn.style.padding = "2px 8px";
      setPrimaryBtn.style.fontSize = "0.85em";
      setPrimaryBtn.addEventListener("click", () => {
        const result = this.session.setPrimaryFormalization(
          claim.id,
          record.id
        );

        if (!result.ok) {
          this.formalizationError = result.error;
        }

        this.render();
      });
    }
  }

  private renderLeanSection(
    card: HTMLElement,
    record: Readonly<FormalizationRecord>
  ): void {
    const claims = this.session.getCandidateClaims(this.candidateId);
    const claim = claims.find(
      (c) => c.formalizationIds?.includes(record.id)
    );

    if (claim === undefined) {
      return;
    }

    const isPrimary = claim.primaryFormalizationId === record.id;
    const eligibility = checkLeanEligibility(record, isPrimary);
    const artifact =
      this.session.getLeanArtifactForFormalization(record.id);

    const section = card.createDiv();
    section.style.marginTop = "0.75rem";
    section.style.padding = "0.5rem";
    section.style.border =
      "1px solid var(--background-modifier-border)";
    section.style.borderRadius = "4px";
    section.style.backgroundColor =
      "var(--background-secondary)";

    section.createEl("strong", {
      text: "Lean Statement"
    }).style.display = "block";

    // Eligibility
    if (!eligibility.eligible) {
      const reason = section.createEl("p");
      reason.style.color = "var(--text-muted)";
      reason.style.fontSize = "0.85em";
      reason.style.margin = "0.3rem 0";
      reason.setText(
        "Blocked: " + (eligibility.reason ?? "Not eligible.")
      );
      return;
    }

    // Generate button
    const generateBtn = section.createEl("button", {
      text: artifact === undefined
        ? "Generate and check Lean statement"
        : "Regenerate and check Lean statement"
    });
    generateBtn.style.padding = "4px 10px";
    generateBtn.style.marginBottom = "0.5rem";
    generateBtn.disabled = this.session.claimReviewLoading;
    generateBtn.addEventListener("click", async () => {
      const result = await this.session.generateAndRunLeanCheck(
        claim.id,
        record.id
      );

      if (!result.ok && result.blockingReason !== undefined) {
        this.formalizationError = result.blockingReason;
      } else if (!result.ok) {
        this.formalizationError = result.error;
      }

      this.render();
    });

    if (artifact === undefined) {
      return;
    }

    // Unresolved mappings warning
    const unresolvedDiags = artifact.diagnostics.filter(
      (d) => d.message.includes("Unresolved Mathlib mapping")
    );

    if (unresolvedDiags.length > 0) {
      const warn = section.createEl("p");
      warn.style.color = "var(--text-warning)";
      warn.style.fontSize = "0.85em";
      warn.style.margin = "0.3rem 0";
      warn.setText(
        "⚠️ Unresolved Mathlib mappings:\n" +
        unresolvedDiags.map((d) => d.message).join("\n")
      );
    }

    // Generated code (immutable)
    const genBlock = section.createDiv();
    genBlock.style.marginBottom = "0.5rem";
    genBlock.createEl("small", {
      text: "Generated code (immutable):"
    }).style.display = "block";

    const genCode = genBlock.createEl("textarea");
    genCode.value = artifact.generatedCode;
    genCode.rows = 6;
    genCode.readOnly = true;
    genCode.style.width = "100%";
    genCode.style.resize = "vertical";
    genCode.style.fontFamily = "var(--font-monospace)";
    genCode.style.fontSize = "0.8em";
    genCode.style.backgroundColor = "var(--background-primary)";
    genCode.style.color = "var(--text-muted)";

    // Reviewed code (editable)
    const revBlock = section.createDiv();
    revBlock.style.marginBottom = "0.5rem";
    revBlock.createEl("label", {
      text: "Reviewed code (editable):"
    }).style.display = "block";

    const revCode = revBlock.createEl("textarea");
    revCode.value = artifact.reviewedCode;
    revCode.rows = 6;
    revCode.style.width = "100%";
    revCode.style.resize = "vertical";
    revCode.style.fontFamily = "var(--font-monospace)";
    revCode.style.fontSize = "0.8em";

    revCode.addEventListener("input", () => {
      void this.session.updateLeanReviewedCode(
        artifact.id,
        revCode.value
      );
    });

    // Action buttons
    const leanActions = section.createDiv();
    leanActions.style.display = "flex";
    leanActions.style.gap = "0.4rem";
    leanActions.style.marginTop = "0.4rem";
    leanActions.style.flexWrap = "wrap";

    const checkBtn = leanActions.createEl("button", {
      text: "Run statement check"
    });
    checkBtn.style.padding = "2px 8px";
    checkBtn.disabled = this.session.claimReviewLoading;
    checkBtn.addEventListener("click", async () => {
      const result = await this.session.runLeanCheck(
        artifact.id
      );

      if (!result.ok) {
        this.formalizationError = result.error;
      }

      this.render();
    });

    const copyBtn = leanActions.createEl("button", {
      text: "Copy raw Lean code"
    });
    copyBtn.style.padding = "2px 8px";
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(
        artifact.reviewedCode
      );
    });

    // Status and diagnostics
    const statusColor = artifact.status === "statement_typechecked"
      ? "var(--color-green)"
      : artifact.status === "error"
        ? "var(--text-error)"
        : "var(--text-muted)";

    const statusEl = section.createEl("p");
    statusEl.style.margin = "0.4rem 0";
    statusEl.style.fontWeight = "600";
    statusEl.style.fontSize = "0.9em";
    statusEl.style.color = statusColor;
    statusEl.setText(
      "Status: " + artifact.status.replace("_", " ")
    );

    if (artifact.diagnostics.length > 0) {
      const diagBlock = section.createDiv();
      diagBlock.style.marginTop = "0.3rem";

      for (const diag of artifact.diagnostics) {
        const diagEl = diagBlock.createEl("p");
        diagEl.style.margin = "2px 0";
        diagEl.style.fontSize = "0.8em";
        diagEl.style.fontFamily = "var(--font-monospace)";
        diagEl.style.color = diag.severity === "error"
          ? "var(--text-error)"
          : diag.severity === "warning"
            ? "var(--text-warning)"
            : "var(--text-muted)";

        const loc = diag.line !== undefined
          ? `[${diag.line}${
              diag.column !== undefined
                ? ":" + diag.column
                : ""
            }] `
          : "";
        diagEl.setText(
          `${diag.severity.toUpperCase()} ${loc}${diag.message}`
        );
      }
    }

    // Notice
    const notice = section.createEl("p");
    notice.style.margin = "0.5rem 0 0 0";
    notice.style.fontSize = "0.8em";
    notice.style.color = "var(--text-muted)";
    notice.style.fontStyle = "italic";
    notice.setText(
      "Statement typechecked means the Lean expression is well-formed. " +
      "It does not mean the mathematical claim has been proved."
    );
  }

  /**
   * Render a small Markdown-capable field with a muted label above
   * and the content rendered through Obsidian's MarkdownRenderer.
   * No-op when content is empty.
   */
  private renderMarkdownField(
    container: HTMLElement,
    label: string,
    content: string
  ): void {
    if (content.trim() === "") {
      return;
    }

    const block = container.createDiv();
    block.style.marginTop = "0.35rem";

    const labelEl = block.createEl("small");
    labelEl.style.color = "var(--text-muted)";
    labelEl.style.display = "block";
    labelEl.setText(label + ":");

    const previewEl = block.createDiv();
    previewEl.addClass("markdown-rendered");
    previewEl.style.padding = "0.2rem 0.4rem";
    previewEl.style.marginTop = "0.1rem";
    previewEl.style.fontSize = "0.9em";
    previewEl.style.maxHeight = "150px";
    previewEl.style.overflowY = "auto";
    previewEl.style.backgroundColor =
      "var(--background-primary)";
    previewEl.style.border =
      "1px solid var(--background-modifier-border)";
    previewEl.style.borderRadius = "3px";

    this.markdownRenderer.render(
      content,
      previewEl,
      this.session.activeNoteSourcePath
    );
    this.registerPreviewCleanup(
      "field-" + label + "-" + Math.random().toString(36).slice(2, 6),
      previewEl
    );
  }

  /**
   * Render an inline Markdown-capable element (short text, math).
   * Suitable for assumption text, ambiguity items, etc.
   */
  private renderInlineMarkdown(
    container: HTMLElement,
    content: string
  ): void {
    if (content.trim() === "") {
      return;
    }

    const previewEl = container.createSpan();
    previewEl.addClass("markdown-rendered");
    previewEl.style.display = "inline-block";
    this.markdownRenderer.render(
      content,
      previewEl,
      this.session.activeNoteSourcePath
    );
    this.registerPreviewCleanup(
      "inline-" + Math.random().toString(36).slice(2, 8),
      previewEl
    );
  }

  private renderAssumptions(
    container: HTMLElement,
    label: string,
    assumptions: readonly FormalizationAssumption[],
    isImplicit: boolean
  ): void {
    if (assumptions.length === 0) {
      return;
    }

    const block = container.createDiv();
    block.style.marginTop = "0.3rem";
    const labelEl = block.createEl("small");
    labelEl.setText(label + ":");
    if (isImplicit) {
      labelEl.style.color = "var(--text-warning)";
    }

    const list = block.createEl("ul");
    list.style.margin = "2px 0";
    list.style.paddingLeft = "1.2rem";

    for (const a of assumptions) {
      const li = list.createEl("li");
      this.renderInlineMarkdown(li, a.text);
    }
  }

  private registerPreviewCleanup(key: string, element: HTMLElement): void {
    const oldCleanup = this.previewCleanups.get(key);
    if (oldCleanup !== undefined) {
      oldCleanup();
    }
    this.previewCleanups.set(
      key,
      makeReadOnlyTextSelectable(element)
    );
  }

  private schedulePreview(
    key: string,
    markdown: string,
    containerEl: HTMLElement,
    sourcePath: string
  ): void {
    const existing = this.previewTimers.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    this.previewTimers.set(
      key,
      setTimeout(() => {
        this.previewTimers.delete(key);
        if (!containerEl.isConnected || this.closed) {
          return;
        }
        containerEl.empty();
        this.markdownRenderer.render(
          markdown,
          containerEl,
          sourcePath
        );
        this.registerPreviewCleanup(key, containerEl);
      }, 200)
    );
  }

  private renderReadOnlyPreview(
    markdown: string,
    containerEl: HTMLElement,
    label: string,
    sourcePath: string
  ): void {
    const previewBlock = containerEl.createDiv();
    previewBlock.style.marginTop = "0.2rem";
    previewBlock.createEl("small", {
      text: label
    }).style.color = "var(--text-muted)";

    const previewEl = previewBlock.createDiv();
    previewEl.addClass("markdown-rendered");
    previewEl.style.padding = "0.3rem 0.6rem";
    previewEl.style.border =
      "1px solid var(--background-modifier-border)";
    previewEl.style.borderRadius = "3px";
    previewEl.style.fontSize = "0.9em";
    previewEl.style.maxHeight = "200px";
    previewEl.style.overflowY = "auto";
    previewEl.style.backgroundColor =
      "var(--background-primary)";
    const previewKey = "readonly-" + label + "-" +
      Math.random().toString(36).slice(2, 6);
    this.markdownRenderer.render(markdown, previewEl, sourcePath);
    this.registerPreviewCleanup(previewKey, previewEl);
  }

  private renderFooter(container: HTMLElement): void {
    const actions = container.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "0.5rem";


    const cancelButton = actions.createEl("button", {
      text: "Cancel"
    });
    cancelButton.addEventListener("click", () => this.close());

    const applyButton = actions.createEl("button", {
      text: "Apply claims"
    });
    applyButton.addClass("mod-cta");
    applyButton.disabled = this.loading;
    applyButton.addEventListener("click", () => {
      this.error = "";
      this.formalizationError = "";
      this.successMessage = "";
      this.pendingScrollTarget = null;

      // ── Gate: count formal claims that still need review ──
      const blockedCount = this.countBlockedFormalClaims();
      if (blockedCount > 0) {
        this.error =
          `${blockedCount} formal claim${blockedCount !== 1 ? "s" : ""} still need${blockedCount === 1 ? "s" : ""} review before Apply.`;
        this.render();
        return;
      }

      const allItems = this.rows
        .filter((row) => !this.committedIds.has(row.item.id))
        .map((row) => row.item);

      if (allItems.length === 0) {
        this.error = "No claims to apply.";
        this.render();
        return;
      }

      // ── Diagnostic: enter Session ──────────────────────────
      console.log(JSON.stringify({
        event: "review-claims-apply-enter",
        claimIds: allItems.map((item) => item.id),
        claimKinds: allItems.map((item) => item.kind)
      }));

      let result: ReturnType<typeof this.session.applyReviewedClaims>;
      try {
        result = this.session.applyReviewedClaims(
          this.candidateId,
          allItems
        );
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        console.error(error);
        this.error = `Apply crashed before returning: ${message}`;
        this.render();
        return;
      }

      // ── Diagnostic: Session returned ───────────────────────
      console.log(JSON.stringify({
        event: "review-claims-apply-return",
        ok: result.ok,
        appliedCount: "appliedCount" in result ? result.appliedCount : undefined,
        warning: "warning" in result ? (result as any).warning ?? null : undefined,
        offendingClaimId: "offendingClaimId" in result ? (result as any).offendingClaimId ?? null : undefined
      }));

      if (!result.ok) {
        this.error = result.error;

        // Use the precise offending claim ID from the defensive guard
        // and scroll the claims list to reveal it.
        if (result.offendingClaimId !== undefined) {
          this.pendingScrollTarget = result.offendingClaimId;
        }

        this.render();
        return;
      }

      // A warning means the claims were committed, but the managed Markdown
      // block could not be updated safely. Keep the warning visible without
      // discarding the successful Apply UI transition.
      if (result.warning !== undefined) {
        this.error = result.warning;
      }

      // Mark applied claims as committed
      for (const item of allItems) {
        this.committedIds.add(item.id);
        // Collapse accepted formalizations for applied claims,
        // but only when already Lean-checked.  Keep not_checked
        // expanded so "Generate and check Lean statement" is
        // visible immediately after Apply.
        const previews =
          this.session.getFormalizationPreviewsForSuggestion(item.id);
        for (const p of previews) {
          if (
            p.record.reviewStatus === "accepted" &&
            p.record.verificationStatus !== "not_checked"
          ) {
            this.collapsedFormalizations.add(p.record.id);
          }
        }

        // ── Reconcile stale Accept collapse state ───────────────
        // Accept unconditionally adds the record ID to the collapsed
        // set.  Materialization preserves the same record ID, so an
        // old Accept collapse entry can survive into the committed
        // state and hide the Lean section even when the formalization
        // is not_checked.
        //
        // After Apply, use the committed formalizations (not previews,
        // which materialization may have already removed) and
        // explicitly clear collapse for any not_checked accepted
        // record so the Lean action is visible.
        const committed =
          this.session.getFormalizationsForClaim(item.id);
        for (const record of committed) {
          if (
            record.reviewStatus === "accepted" &&
            record.verificationStatus === "not_checked"
          ) {
            this.collapsedFormalizations.delete(record.id);
          }
        }
      }

      // Apply succeeded — the workflow is complete.  Close the modal.
      // Bookkeeping (committedIds, collapse reconciliation) is already
      // done above, so the session state is committed.
      // Non-fatal warnings do not prevent close.
      this.close();
    });
  }
}

function ensureLatexPresentation(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.includes("$") ||
    trimmed.includes("\\(") ||
    trimmed.includes("\\[")
  ) {
    return trimmed;
  }
  return "$" + trimmed + "$";
}

/** Reveal a claim by moving only the designated claims-list scroll surface. */
function revealWithinScrollContainer(
  container: HTMLElement,
  target: HTMLElement
): void {
  const viewportHeight = container.clientHeight;
  if (viewportHeight <= 0) {
    return;
  }

  const viewportTop = container.scrollTop;
  const viewportBottom = viewportTop + viewportHeight;
  const targetTop = target.offsetTop;
  const targetBottom = targetTop + target.offsetHeight;

  if (targetTop < viewportTop) {
    container.scrollTop = targetTop;
  } else if (targetBottom > viewportBottom) {
    container.scrollTop = Math.max(0, targetBottom - viewportHeight);
  }
}

function formatVerification(value: string): string {
  return value.replaceAll("_", " ");
}

function promptForRejectionReason(): string | null {
  // Use Obsidian's native prompt
  const reason = globalThis.prompt?.(
    "Rejection reason (required):"
  );

  if (reason === null || reason === undefined) {
    return null;
  }

  if (reason.trim() === "") {
    return null;
  }

  return reason.trim();
}
