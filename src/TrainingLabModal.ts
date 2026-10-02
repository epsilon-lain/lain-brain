import { Modal, Notice, TFolder, type App } from "obsidian";
import {
  TRAINING_ROUND_MAX_BYTES, TrainingLabRepository, emptyTrainingLab,
  exportTrainingObjects, inspectTrainingRun, type TrainingLabState
} from "./TrainingLab";

/** Deliberately synthetic. Loading it only fills the editor; importing is explicit. */
export function trainingLabExample(): string {
  const definition = {
    op: "add", left: { op: "scale", factor: "2", body: { op: "x" } },
    right: { op: "const", value: "1" }
  };
  return JSON.stringify({
    schemaVersion: 1, kind: "instrument", runId: "example-affine", round: 1,
    recordedAt: "2026-10-01T00:00:00.000Z",
    student: { model: "synthetic-example-not-trained", parameterCount: 1, checkpointSha256: "0".repeat(64) },
    dataset: { trainSha256: "1".repeat(64), evalSha256: "2".repeat(64) },
    config: { mode: "teacher_free", device: "synthetic-example", seed: 0 },
    measurements: { steps: 1, trainLoss: 0, trainSeconds: 0 }, predictions: [],
    candidates: [{ id: "double-plus-one", label: "2x + 1", definition,
      reference: { taskId: "affine-001", split: "train", definition } }]
  }, null, 2);
}

export class TrainingLabModal extends Modal {
  private state: TrainingLabState = emptyTrainingLab();
  private draft = "";
  private draftFile = "";
  private runId = "";
  private status = "";
  private failed = false;
  private busy = false;
  private loaded = false;

  constructor(app: App, private readonly repository: TrainingLabRepository) { super(app); }
  onOpen(): void { this.render(); void this.perform(async () => this.reload(), "正在读取训练历史…"); }
  onClose(): void { this.contentEl.empty(); }

  private async reload(): Promise<void> {
    this.state = await this.repository.load();
    this.loaded = true;
    this.chooseRun();
    this.status = "历史已载入。请选择 round-001.json 等完整轮次文件。";
  }
  private chooseRun(): void {
    if (!this.state.rounds.some((r) => r.runId === this.runId)) {
      this.runId = this.state.rounds[this.state.rounds.length - 1]?.runId ?? "";
    }
  }
  private async perform(work: () => Promise<void>, pending = "正在处理…"): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.failed = false;
    this.status = pending;
    this.render();
    try { await work(); }
    catch (error) {
      this.failed = true;
      this.status = `操作失败：${error instanceof Error ? error.message : String(error)}`;
      new Notice(this.status, 10000);
    }
    finally { this.busy = false; this.render(); }
  }
  private button(parent: HTMLElement, label: string, action: () => void, needsLoad = true): void {
    const control = parent.createEl("button", { text: label });
    control.disabled = this.busy || (needsLoad && !this.loaded);
    control.addEventListener("click", action);
  }
  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.style.maxHeight = "80vh";
    el.style.overflowY = "auto";
    this.setTitle("Training Lab · 训练实验区");
    el.createEl("p", { text: "外部自动训练器可以同步轮次，并读取 Brain 验证后的对象和反馈继续训练。手动导入也仍然可用。" });
    el.createEl("p", { text: "当前支持有理数仿射表达式。训练在外部 Python 进程中运行；这里不会启动 GPU 或调用付费模型。实验对象独立保存。" });
    const actions = el.createDiv();
    actions.style.display = "flex";
    actions.style.gap = "0.5rem";
    actions.style.flexWrap = "wrap";
    this.button(actions, "选择本地 JSON", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return;
        void this.perform(async () => {
          if (file.size > TRAINING_ROUND_MAX_BYTES) throw new Error("每轮 JSON 不得超过 2 MiB。");
          this.draft = await file.text();
          this.draftFile = file.name;
          this.status = `已载入 ${file.name}；请点击「导入并验证这一轮」保存。`;
        }, "正在读取所选 JSON 文件…");
      });
      input.click();
    }, false);
    this.button(actions, "载入合成示例", () => {
      this.draft = trainingLabExample();
      this.draftFile = "合成示例";
      this.failed = false;
      this.status = "这是 instrument 合成示例，没有进行模型训练。";
      this.render();
    }, false);
    this.button(actions, "刷新历史", () => void this.perform(async () => this.reload()), false);

    // Feedback precedes the large editor so failures stay visible on small screens.
    const status = el.createEl("p", { text: this.status || "尚未导入训练轮次。" });
    status.setAttribute("role", this.failed ? "alert" : "status");
    status.setAttribute("aria-live", this.failed ? "assertive" : "polite");
    status.style.padding = "0.75rem";
    status.style.background = "var(--background-secondary)";
    status.style.whiteSpace = "pre-wrap";
    if (this.failed) status.style.color = "var(--text-error)";
    if (this.draftFile) el.createEl("p", { text: `当前内容：${this.draftFile}` });

    const editor = el.createEl("textarea");
    editor.value = this.draft;
    editor.placeholder = "粘贴训练器生成的轮次 JSON，或选择本地文件";
    editor.setAttribute("aria-label", "训练轮次 JSON");
    editor.style.width = "100%";
    editor.style.minHeight = "12rem";
    editor.style.marginTop = "0.75rem";
    editor.style.fontFamily = "var(--font-monospace)";
    editor.disabled = this.busy;
    editor.addEventListener("input", () => { this.draft = editor.value; this.draftFile = "手动编辑的 JSON"; });
    this.button(el, "导入并验证这一轮", () => void this.perform(async () => {
      if (!this.draft.trim()) throw new Error("请先选择 round-001.json，或粘贴完整轮次 JSON。");
      let value: unknown;
      try { value = JSON.parse(this.draft); }
      catch { throw new Error("JSON 格式不完整或有语法错误，请重新选择训练器输出的 round-001.json。"); }
      if (value !== null && typeof value === "object" && !Array.isArray(value) &&
          !("schemaVersion" in value) && ("loss" in value || "nextTokenAccuracy" in value || "evaluatedTokens" in value)) {
        throw new Error("选中的是评估摘要。请选择 round-001.json / round-002.json；before.json 和 evaluation-*.json 不能作为轮次导入。");
      }
      this.state = await this.repository.importRound(this.draft);
      this.loaded = true;
      const saved = this.state.rounds[this.state.rounds.length - 1]!;
      this.runId = saved.runId;
      this.status = `导入成功：${saved.runId} · 第 ${saved.round} 轮已保存。候选状态由本地重新计算。`;
      new Notice(this.status);
    }, "正在验证并保存这一轮…"));

    const runIds = [...new Set(this.state.rounds.map((r) => r.runId))];
    if (!runIds.length) return;
    const select = el.createEl("select");
    select.setAttribute("aria-label", "实验运行");
    select.disabled = this.busy;
    for (const runId of runIds) select.createEl("option", { text: runId, value: runId });
    select.value = this.runId;
    select.addEventListener("change", () => { this.runId = select.value; this.render(); });
    const inspected = inspectTrainingRun(this.state, this.runId);
    el.createEl("p", { text: `${inspected.rounds.length} 轮 · ${inspected.objects.length} 个已接纳实验对象` });
    this.button(el, "导出对象库供下一轮训练", () => void this.perform(async () => {
      // Refresh first: another lab window may have imported another round.
      await this.reload();
      const objects = exportTrainingObjects(this.state, this.runId);
      await this.saveExport(`objects-${this.runId}`, objects);
    }));
    this.button(el, "导出完整历史备份", () => void this.perform(async () => {
      await this.reload();
      await this.saveExport("training-history", JSON.stringify(this.state, null, 2));
    }));
    for (const round of [...inspected.rounds].reverse()) {
      const card = el.createDiv();
      card.style.borderTop = "1px solid var(--background-modifier-border)";
      card.style.marginTop = "1rem";
      card.createEl("h4", { text: `第 ${round.source.round} 轮 · ${round.source.kind === "instrument" ? "合成仪器测试" : "训练器报告"}` });
      const m = round.source.measurements;
      card.createEl("p", { text: `${round.source.config.mode} · ${round.source.student.model} · ${round.source.student.parameterCount} 参数` });
      card.createEl("p", { text: `训练器报告：累计 ${m.steps} 步；loss ${m.trainLoss}；累计训练 ${m.trainSeconds}s；峰值显存 ${m.peakVramMb ?? "未报告"} MiB；评测正确率 ${m.evalAccuracy ?? "未报告"}。Brain 开销尚未计入。` });
      card.createEl("p", { text: `checkpoint SHA256: ${round.source.student.checkpointSha256}` });
      for (const result of round.verifications) {
        const details = card.createEl("details");
        details.createEl("summary", { text: `${result.candidateId} · ${result.verification} · ${result.acceptance}` });
        details.createEl("p", { text: result.message });
        const candidate = round.source.candidates.find((c) => c.id === result.candidateId)!;
        details.createEl("p", { text: candidate.teacher ? `老师（导入报告）：${candidate.teacher.model} · ${candidate.teacher.decision} · ${candidate.teacher.rationale}` : "无老师评语。" });
        const data = details.createEl("pre", { text: JSON.stringify(candidate, null, 2) });
        data.style.whiteSpace = "pre-wrap";
      }
      if (round.source.predictions.length) {
        const details = card.createEl("details");
        details.createEl("summary", { text: "查看预测、目标和数据划分" });
        const data = details.createEl("pre", { text: JSON.stringify(round.source.predictions, null, 2) });
        data.style.whiteSpace = "pre-wrap";
      }
    }
  }

  private async saveExport(prefix: string, source: string): Promise<void> {
    const folder = "Lain Brain Training Exports";
    const existing = this.app.vault.getAbstractFileByPath(folder);
    if (existing !== null && !(existing instanceof TFolder)) throw new Error("导出目录被同名文件占用。");
    if (existing === null) await this.app.vault.createFolder(folder);
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    let path = `${folder}/${prefix}-${stamp}.json`;
    for (let suffix = 1; this.app.vault.getAbstractFileByPath(path) !== null; suffix++) {
      path = `${folder}/${prefix}-${stamp}-${suffix}.json`;
    }
    await this.app.vault.create(path, source);
    this.status = `已导出：${path}`;
    new Notice(this.status);
  }
}
