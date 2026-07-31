import {
  Plugin,
  WorkspaceLeaf
} from "obsidian";
import {
  LainBrainView,
  VIEW_TYPE_LAIN_BRAIN
} from "./LainBrainView";
import {
  LainBrainLargeView,
  VIEW_TYPE_LAIN_BRAIN_LARGE
} from "./LainBrainLargeView";
import { LainBrainSession } from "./LainBrainSession";
import { LainBrainSettingTab } from "./LainBrainSettingTab";
import {
  DEFAULT_SETTINGS,
  LainBrainSettings
} from "./settings";

export default class LainBrainPlugin extends Plugin {
  settings: LainBrainSettings = { ...DEFAULT_SETTINGS };
  session!: LainBrainSession;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.session = new LainBrainSession(
      this.app,
      () => this.settings.deepSeekApiKey
    );
    await this.session.setActiveFile(
      this.app.workspace.getActiveFile()
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file !== null) {
          void this.session.setActiveFile(file);
        }
      })
    );

    this.registerView(
      VIEW_TYPE_LAIN_BRAIN,
      (leaf) => new LainBrainView(
        leaf,
        this.session,
        () => this.openLargeLainBrain()
      )
    );

    this.registerView(
      VIEW_TYPE_LAIN_BRAIN_LARGE,
      (leaf) => new LainBrainLargeView(
        leaf,
        this.session,
        () => this.closeLargeLainBrain(leaf)
      )
    );

    this.addSettingTab(
      new LainBrainSettingTab(this.app, this)
    );

    this.addCommand({
      id: "open-lain-brain",
      name: "Open Lain Brain",
      callback: async () => {
        await this.openLainBrain();
      }
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async openLainBrain(): Promise<void> {
    const existingLeaves =
      this.app.workspace.getLeavesOfType(
        VIEW_TYPE_LAIN_BRAIN
      );

    let leaf: WorkspaceLeaf | null =
      existingLeaves[0] ?? null;

    if (leaf === null) {
      leaf = this.app.workspace.getRightLeaf(false);

      if (leaf === null) {
        return;
      }

      await leaf.setViewState({
        type: VIEW_TYPE_LAIN_BRAIN,
        active: true
      });
    }

    await this.app.workspace.revealLeaf(leaf);
  }

  private async openLargeLainBrain(): Promise<void> {
    await this.session.refreshActiveNoteContext();

    const existingLeaves =
      this.app.workspace.getLeavesOfType(
        VIEW_TYPE_LAIN_BRAIN_LARGE
      );
    let leaf = existingLeaves[0];

    if (leaf === undefined) {
      leaf = this.app.workspace.getLeaf("tab");

      await leaf.setViewState({
        type: VIEW_TYPE_LAIN_BRAIN_LARGE,
        active: true
      });
    }

    await this.app.workspace.revealLeaf(leaf);
  }

  private async closeLargeLainBrain(
    leaf: WorkspaceLeaf
  ): Promise<void> {
    leaf.detach();
    await this.openLainBrain();
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(
      VIEW_TYPE_LAIN_BRAIN
    );
    this.app.workspace.detachLeavesOfType(
      VIEW_TYPE_LAIN_BRAIN_LARGE
    );
  }
}
