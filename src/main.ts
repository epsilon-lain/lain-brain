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
import {
  LainBrainSession
} from "./LainBrainSession";
import type {
  LainBrainLargeViewMode
} from "./LainBrainSession";
import { LainBrainSettingTab } from "./LainBrainSettingTab";
import {
  LainBrainSettings,
  migrateLainBrainSettings
} from "./settings";
import { getActiveImageProvider } from "./ProviderProfiles";
import { LainBrainNamingModal } from "./LainBrainNamingModal";
import {
  applyPersonalNames,
  NamingOnboardingSession,
  resetPersonalNames
} from "./PersonalNaming";

export default class LainBrainPlugin extends Plugin {
  settings: LainBrainSettings = migrateLainBrainSettings(undefined);
  session!: LainBrainSession;
  private readonly namingOnboarding =
    new NamingOnboardingSession();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.session = new LainBrainSession(
      this.app,
      () => this.settings.deepSeekApiKey,
      () => getActiveImageProvider(
        this.settings.imageProviderProfiles,
        this.settings.activeImageProviderId
      )
    );
    this.session.setPersonalNamingProvider(() => this.settings);
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
        () => this.openLargeLainBrain("chat"),
        () => this.openLargeLainBrain("candidate"),
        () => this.requestNamingOnboarding()
      )
    );

    this.registerView(
      VIEW_TYPE_LAIN_BRAIN_LARGE,
      (leaf) => new LainBrainLargeView(
        leaf,
        this.session,
        () => this.closeLargeLainBrain(leaf),
        () => this.openLainBrain(),
        () => this.requestNamingOnboarding()
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
    this.settings = migrateLainBrainSettings(
      await this.loadData()
    );
    await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  requestNamingOnboarding(): void {
    if (
      !this.namingOnboarding.begin(
        this.settings.hasCompletedNamingOnboarding
      )
    ) {
      return;
    }

    this.openNamingModal(true);
  }

  openNamingPersonalization(): void {
    this.openNamingModal(false);
  }

  async updatePersonalNames(
    userName: string,
    brainName: string
  ): Promise<string | null> {
    const error = applyPersonalNames(
      this.settings,
      userName,
      brainName
    );

    if (error !== null) {
      return error;
    }

    await this.saveSettings();
    this.session.notifyPersonalNamingChanged();
    return null;
  }

  async resetNames(): Promise<void> {
    resetPersonalNames(this.settings);
    this.namingOnboarding.reset();
    await this.saveSettings();
    this.session.notifyPersonalNamingChanged();
  }

  private openNamingModal(onboarding: boolean): void {
    new LainBrainNamingModal(
      this.app,
      this.settings.userDisplayName,
      this.settings.brainDisplayName,
      async (userName, brainName) => {
        const error = await this.updatePersonalNames(
          userName,
          brainName
        );

        if (error === null && onboarding) {
          this.namingOnboarding.finish();
        }

        return error;
      },
      () => {
        if (onboarding) {
          this.namingOnboarding.skip();
        }
      }
    ).open();
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

  private async openLargeLainBrain(
    mode: LainBrainLargeViewMode
  ): Promise<void> {
    if (mode === "candidate") {
      if (!this.session.showCandidateNote()) {
        return;
      }
    } else {
      this.session.showLargeChat();
      await this.session.refreshActiveNoteContext();
    }

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
