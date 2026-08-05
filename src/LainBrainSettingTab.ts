import {
  App,
  Modal,
  PluginSettingTab,
  Setting
} from "obsidian";
import type { DropdownComponent } from "obsidian";
import {
  canAnalyzeImages,
  createCustomProviderProfile,
  validateProviderProfile
} from "./ProviderProfiles";
import type { ProviderProfile } from "./ProviderProfiles";
import { removeCustomProviderProfile } from "./settings";
import { validateDisplayName } from "./PersonalNaming";
import type LainBrainPlugin from "./main";

export class LainBrainSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: LainBrainPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    let activeDropdown: DropdownComponent | undefined;

    const refreshActiveDropdown = (): void => {
      if (activeDropdown === undefined) {
        return;
      }

      const select = activeDropdown.selectEl;
      select.empty();
      select.createEl("option", {
        text: "Disabled",
        value: ""
      });

      for (const profile of this.plugin.settings.imageProviderProfiles) {
        if (canAnalyzeImages(profile)) {
          select.createEl("option", {
            text: profile.displayName,
            value: profile.id
          });
        }
      }

      const activeId = this.plugin.settings.activeImageProviderId;
      select.value = activeId !== null &&
        Array.from(select.options).some((option) => option.value === activeId)
        ? activeId
        : "";
    };

    containerEl.empty();

    new Setting(containerEl)
      .setName("Personal names")
      .setHeading();

    new Setting(containerEl)
      .setName("Your name")
      .setDesc("Used for your chat prefix.")
      .addText((text) => {
        const setting = text.inputEl.closest(
          ".setting-item"
        ) as HTMLElement | null;
        text.inputEl.maxLength = 32;
        text
          .setValue(this.plugin.settings.userDisplayName)
          .onChange(async (value) => {
            const validation =
              validateDisplayName(value, "Your name");

            if (!validation.ok) {
              setting?.querySelector(
                ".setting-item-description"
              )?.setText(validation.error);
              return;
            }

            await this.plugin.updatePersonalNames(
              validation.value,
              this.plugin.settings.brainDisplayName
            );
            setting?.querySelector(
              ".setting-item-description"
            )?.setText("Used for your chat prefix.");
          });
      });

    new Setting(containerEl)
      .setName("Brain name")
      .setDesc("Used for assistant messages.")
      .addText((text) => {
        const setting = text.inputEl.closest(
          ".setting-item"
        ) as HTMLElement | null;
        text.inputEl.maxLength = 32;
        text
          .setValue(this.plugin.settings.brainDisplayName)
          .onChange(async (value) => {
            const validation =
              validateDisplayName(value, "Brain name");

            if (!validation.ok) {
              setting?.querySelector(
                ".setting-item-description"
              )?.setText(validation.error);
              return;
            }

            await this.plugin.updatePersonalNames(
              this.plugin.settings.userDisplayName,
              validation.value
            );
            setting?.querySelector(
              ".setting-item-description"
            )?.setText("Used for assistant messages.");
          });
      });

    new Setting(containerEl)
      .setName("Personalize names")
      .setDesc("Open the naming dialog.")
      .addButton((button) => {
        button
          .setButtonText("Personalize names")
          .onClick(() => {
            this.plugin.openNamingPersonalization();
          });
      });

    new Setting(containerEl)
      .setName("Reset names")
      .setDesc("Restore You and Brain.")
      .addButton((button) => {
        button.setButtonText("Reset names").onClick(async () => {
          if (!await confirmResetNames(this.app)) {
            return;
          }

          await this.plugin.resetNames();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("DeepSeek API key")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.deepSeekApiKey)
          .onChange(async (value) => {
            this.plugin.settings.deepSeekApiKey = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Image Providers")
      .setHeading();

    containerEl.createEl("p", {
      text:
        "Attached images are sent only to the active image provider when you press Send."
    });

    new Setting(containerEl)
      .setName("Active image provider")
      .setDesc("Select which configured provider analyzes attached images.")
      .addDropdown((dropdown) => {
        activeDropdown = dropdown;
        dropdown.onChange(async (value) => {
          this.plugin.settings.activeImageProviderId =
            value === "" ? null : value;
          await this.plugin.saveSettings();
        });
        refreshActiveDropdown();
      });

    const openAI = this.plugin.settings.imageProviderProfiles.find(
      (profile) => profile.builtInKind === "openai"
    );
    const qwen = this.plugin.settings.imageProviderProfiles.find(
      (profile) => profile.builtInKind === "qwen"
    );

    if (openAI !== undefined) {
      this.renderBuiltInProvider(
        containerEl,
        openAI,
        "OpenAI Vision preset",
        "OpenAI Responses API: https://api.openai.com/v1/responses",
        "gpt-5.6",
        refreshActiveDropdown
      );
    }

    if (qwen !== undefined) {
      this.renderBuiltInProvider(
        containerEl,
        qwen,
        "Qwen Vision preset",
        "OpenAI-compatible endpoint: https://dashscope.aliyuncs.com/compatible-mode/v1",
        "Vision-capable Qwen model",
        refreshActiveDropdown
      );
    }

    new Setting(containerEl)
      .setName("Custom OpenAI-compatible Vision providers")
      .setHeading();

    for (const profile of this.plugin.settings.imageProviderProfiles) {
      if (profile.builtInKind === undefined) {
        this.renderCustomProvider(
          containerEl,
          profile,
          refreshActiveDropdown
        );
      }
    }

    new Setting(containerEl)
      .setName("Add custom provider")
      .setDesc("New providers are not selected automatically.")
      .addButton((button) => {
        button.setButtonText("Add Provider").onClick(async () => {
          this.plugin.settings.imageProviderProfiles.push(
            createCustomProviderProfile()
          );
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  private renderBuiltInProvider(
    container: HTMLElement,
    profile: ProviderProfile,
    heading: string,
    description: string,
    modelPlaceholder: string,
    refreshActiveDropdown: () => void
  ): void {
    new Setting(container)
      .setName(heading)
      .setDesc(description)
      .setHeading();

    new Setting(container)
      .setName("API key")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(profile.apiKey).onChange(async (value) => {
          profile.apiKey = value;
          await this.plugin.saveSettings();
          refreshActiveDropdown();
        });
      });

    new Setting(container)
      .setName("Model")
      .addText((text) => {
        text
          .setPlaceholder(modelPlaceholder)
          .setValue(profile.model)
          .onChange(async (value) => {
            profile.model = value;
            await this.plugin.saveSettings();
            refreshActiveDropdown();
          });
      });
  }

  private renderCustomProvider(
    container: HTMLElement,
    profile: ProviderProfile,
    refreshActiveDropdown: () => void
  ): void {
    const card = container.createDiv();
    card.style.padding = "0.5rem";
    card.style.marginBottom = "0.75rem";
    card.style.border = "1px solid var(--background-modifier-border)";
    card.style.borderRadius = "4px";

    const heading = card.createEl("h4", {
      text: profile.displayName || "Custom provider"
    });
    heading.style.marginTop = "0";
    const validation = card.createEl("small");
    validation.style.display = "block";
    validation.style.color = "var(--text-error)";

    const update = async (): Promise<void> => {
      heading.setText(profile.displayName || "Custom provider");
      validation.setText(validateProviderProfile(profile) ?? "");
      await this.plugin.saveSettings();
      refreshActiveDropdown();
    };

    new Setting(card)
      .setName("Provider name")
      .addText((text) => {
        text.setValue(profile.displayName).onChange(async (value) => {
          profile.displayName = value;
          await update();
        });
      });

    new Setting(card)
      .setName("Base URL")
      .setDesc("HTTPS only. /chat/completions is appended when sending.")
      .addText((text) => {
        text.setValue(profile.baseUrl).onChange(async (value) => {
          profile.baseUrl = value;
          await update();
        });
      });

    new Setting(card)
      .setName("API key")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(profile.apiKey).onChange(async (value) => {
          profile.apiKey = value;
          await update();
        });
      });

    new Setting(card)
      .setName("Model")
      .addText((text) => {
        text.setValue(profile.model).onChange(async (value) => {
          profile.model = value;
          await update();
        });
      });

    new Setting(card)
      .setName("Supports image input")
      .addToggle((toggle) => {
        toggle
          .setValue(profile.capabilities.supportsImages)
          .onChange(async (value) => {
            profile.capabilities.supportsImages = value;
            await update();
          });
      });

    new Setting(card)
      .setName("Remove provider")
      .addButton((button) => {
        button.setButtonText("Remove").onClick(async () => {
          removeCustomProviderProfile(
            this.plugin.settings,
            profile.id
          );

          await this.plugin.saveSettings();
          this.display();
        });
      });

    validation.setText(validateProviderProfile(profile) ?? "");
  }
}
function confirmResetNames(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let settled = false;

    const settle = (confirmed: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(confirmed);
      modal.close();
    };

    modal.onOpen = (): void => {
      modal.titleEl.setText("Reset names?");
      modal.contentEl.createEl("p", {
        text:
          "This restores You and Brain and shows naming onboarding the next time Lain Brain is opened."
      });

      const actions = modal.contentEl.createDiv();
      actions.style.display = "flex";
      actions.style.justifyContent = "flex-end";
      actions.style.gap = "0.5rem";

      const cancelButton = actions.createEl("button", {
        text: "Cancel"
      });
      cancelButton.addEventListener("click", () => {
        settle(false);
      });

      const resetButton = actions.createEl("button", {
        text: "Reset names"
      });
      resetButton.addClass("mod-warning");
      resetButton.addEventListener("click", () => {
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
