import { Plugin, WorkspaceLeaf } from "obsidian";
import {
  LainBrainView,
  VIEW_TYPE_LAIN_BRAIN
} from "./LainBrainView";
import { LainBrainSettingTab } from "./LainBrainSettingTab";
import {
  DEFAULT_SETTINGS,
  LainBrainSettings
} from "./settings";

export default class LainBrainPlugin extends Plugin {
  settings: LainBrainSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_LAIN_BRAIN,
      (leaf) => new LainBrainView(
        leaf,
        () => this.settings.deepSeekApiKey
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

  onunload(): void {
    this.app.workspace.detachLeavesOfType(
      VIEW_TYPE_LAIN_BRAIN
    );
  }
}
