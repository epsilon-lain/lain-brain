import {
  App,
  PluginSettingTab,
  Setting
} from "obsidian";
import type LainBrainPlugin from "./main";

export class LainBrainSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: LainBrainPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

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
  }
}
