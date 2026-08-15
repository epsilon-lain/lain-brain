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
import type { LeanExecutionMode } from "./settings";
import { validateDisplayName } from "./PersonalNaming";
import { SpawnLeanRunner, runWslCommandLadder } from "./LeanRunner";
import type { LeanRunnerConfig, WslLadderResults } from "./LeanRunner";
import type LainBrainPlugin from "./main";

export class LainBrainSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: LainBrainPlugin) {
    super(app, plugin);
  }

  private buildRunnerConfig(): LeanRunnerConfig {
    return {
      mode: this.plugin.settings.leanExecutionMode,
      projectRoot: this.plugin.settings.leanProjectRoot,
      executable: this.plugin.settings.leanExecutable,
      args: this.plugin.settings.leanArgs,
      timeoutSeconds: this.plugin.settings.leanTimeoutSeconds,
      wslExecutable: this.plugin.settings.wslExecutable,
      wslDistribution: this.plugin.settings.wslDistribution,
      wslProjectRoot: this.plugin.settings.wslProjectRoot
    };
  }

  private updateRunner(): void {
    this.plugin.session.setLeanRunner(
      new SpawnLeanRunner(this.buildRunnerConfig())
    );
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
      .setName("Detect semantic changes in chat")
      .setDesc(
        "After a successful normal text reply, send at most three recent " +
        "text-only turns to the configured DeepSeek provider to look for " +
        "one possible semantic change. Analysis is non-authoritative, " +
        "never includes attachments or Vault contents, and can be disabled."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.chatSemanticDeltaAnalysisEnabled)
          .onChange(async (value) => {
            this.plugin.settings.chatSemanticDeltaAnalysisEnabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Lean Environment")
      .setHeading();

    new Setting(containerEl)
      .setName("Execution mode")
      .setDesc(
        "Use WSL mode when Obsidian runs on Windows but Lean is " +
        "installed inside WSL."
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("native", "Native");
        dropdown.addOption("wsl", "WSL");
        dropdown
          .setValue(this.plugin.settings.leanExecutionMode)
          .onChange(async (value) => {
            this.plugin.settings.leanExecutionMode =
              value === "wsl" ? "wsl" : "native";
            await this.plugin.saveSettings();
            this.updateRunner();
            this.display();
          });
      });

    if (this.plugin.settings.leanExecutionMode === "wsl") {
      new Setting(containerEl)
        .setName("WSL executable")
        .setDesc("WSL launcher. Default: wsl.exe")
        .addText((text) => {
          text
            .setValue(this.plugin.settings.wslExecutable)
            .onChange(async (value) => {
              this.plugin.settings.wslExecutable =
                value.trim() || "wsl.exe";
              await this.plugin.saveSettings();
              this.updateRunner();
            });
        });

      new Setting(containerEl)
        .setName("WSL distribution")
        .setDesc(
          "WSL distribution name. Leave empty to use the default " +
          "distribution."
        )
        .addText((text) => {
          text
            .setValue(this.plugin.settings.wslDistribution)
            .onChange(async (value) => {
              this.plugin.settings.wslDistribution =
                value.trim();
              await this.plugin.saveSettings();
              this.updateRunner();
            });
        });

      new Setting(containerEl)
        .setName("WSL project root")
        .setDesc(
          "WSL-side path to the Lean project, e.g. " +
          "/mnt/c/Users/.../lain_lean"
        )
        .addText((text) => {
          text
            .setValue(this.plugin.settings.wslProjectRoot)
            .onChange(async (value) => {
              this.plugin.settings.wslProjectRoot =
                value.trim();
              await this.plugin.saveSettings();
              this.updateRunner();
            });
        });

      new Setting(containerEl)
        .setName("Lean executable (in WSL)")
        .setDesc(
          "Executable inside WSL. When Lean was installed through elan, " +
          "use an absolute path such as /root/.elan/bin/lake"
        )
        .addText((text) => {
          text
            .setValue(this.plugin.settings.leanExecutable)
            .onChange(async (value) => {
              this.plugin.settings.leanExecutable =
                value.trim() || "lake";
              await this.plugin.saveSettings();
              this.updateRunner();
            });
        });

      new Setting(containerEl)
        .setName("Lean arguments (in WSL)")
        .setDesc(
          "Arguments passed before the .lean file path. " +
          "Separate with spaces. Default: env lean"
        )
        .addText((text) => {
          text
            .setValue(this.plugin.settings.leanArgs.join(" "))
            .onChange(async (value) => {
              this.plugin.settings.leanArgs = value
                .trim()
                .split(/\s+/)
                .filter((s) => s !== "");
              if (this.plugin.settings.leanArgs.length === 0) {
                this.plugin.settings.leanArgs = ["env", "lean"];
              }
              await this.plugin.saveSettings();
              this.updateRunner();
            });
        });
    } else {
      new Setting(containerEl)
        .setName("Lean project root")
        .setDesc(
          "Absolute path to the Lean project directory containing lakefile.lean. " +
          "Leave empty to use the plugin's working directory."
        )
        .addText((text) => {
          text
            .setValue(this.plugin.settings.leanProjectRoot)
            .onChange(async (value) => {
              this.plugin.settings.leanProjectRoot = value.trim();
              await this.plugin.saveSettings();
              this.updateRunner();
            });
        });

      new Setting(containerEl)
        .setName("Lean executable")
        .setDesc("Executable name or path. Default: lake")
        .addText((text) => {
          text
            .setValue(this.plugin.settings.leanExecutable)
            .onChange(async (value) => {
              this.plugin.settings.leanExecutable =
                value.trim() || "lake";
              await this.plugin.saveSettings();
              this.updateRunner();
            });
        });

      new Setting(containerEl)
        .setName("Lean arguments")
        .setDesc(
          "Arguments passed before the .lean file path. " +
          "Separate with spaces. Default: env lean"
        )
        .addText((text) => {
          text
            .setValue(this.plugin.settings.leanArgs.join(" "))
            .onChange(async (value) => {
              this.plugin.settings.leanArgs = value
                .trim()
                .split(/\s+/)
                .filter((s) => s !== "");
              if (this.plugin.settings.leanArgs.length === 0) {
                this.plugin.settings.leanArgs = ["env", "lean"];
              }
              await this.plugin.saveSettings();
              this.updateRunner();
            });
        });
    }

    new Setting(containerEl)
      .setName("Timeout (seconds)")
      .setDesc("Maximum time per Lean check. Default: 30")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "300";
        text
          .setValue(String(this.plugin.settings.leanTimeoutSeconds))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            this.plugin.settings.leanTimeoutSeconds =
              Number.isFinite(parsed) &&
              parsed >= 1 &&
              parsed <= 300
                ? parsed
                : 30;
            await this.plugin.saveSettings();
            this.updateRunner();
          });
      });

    const testResultEl = containerEl.createDiv();
    testResultEl.style.margin = "0.25rem 0 0 0";
    testResultEl.style.padding = "0";
    testResultEl.style.minHeight = "0";

    new Setting(containerEl)
      .setName("Test Lean environment")
      .setDesc(
        "Runs a minimal `#check (1+1)` to verify your Lean setup. " +
        "Does not change any formalization status."
      )
      .addButton((button) => {
        button
          .setButtonText("Test Lean environment")
          .onClick(async () => {
            // Clear previous result
            testResultEl.empty();

            // Show progress
            const progressEl = testResultEl.createEl("p");
            progressEl.style.margin = "0";
            progressEl.style.fontStyle = "italic";
            progressEl.setText(
              "Testing Lean environment..."
            );

            button.setButtonText("Testing...");
            button.setDisabled(true);

            try {
              const runner = this.plugin.session.getLeanRunner();
              if (runner === null) {
                testResultEl.empty();
                const errEl = testResultEl.createEl("p");
                errEl.style.color = "var(--text-error)";
                errEl.style.margin = "0";
                errEl.setText(
                  "No Lean runner is configured."
                );
                return;
              }

              const testCode = [
                "import Mathlib.Data.Real.Basic",
                "",
                "set_option autoImplicit false",
                "",
                "#check (∀ value : ℝ, value + 0 = value)"
              ].join("\n");

              const result = await runner.check({
                code: testCode
              });

              // Replace progress with result
              testResultEl.empty();

              if (result.status === "statement_typechecked") {
                const okEl = testResultEl.createEl("p");
                okEl.style.color = "var(--color-green)";
                okEl.style.margin = "0";
                okEl.style.fontWeight = "600";
                okEl.setText(
                  "✓ Lean environment is working correctly."
                );

                if (result.stderr.trim() !== "") {
                  addOutputDetails(
                    testResultEl,
                    "Stderr output (warnings)",
                    result.stderr
                  );
                }
                if (result.debug !== undefined) {
                  addProcessDebug(testResultEl, result.debug);
                }
              } else {
                const failHeading = testResultEl.createEl("p");
                failHeading.style.color = "var(--text-error)";
                failHeading.style.margin = "0 0 0.25rem 0";
                failHeading.style.fontWeight = "600";

                // Determine classification
                const isSpawnError = result.diagnostics.some(
                  (d) => d.message.includes("failed to start")
                );
                const isTimeout = result.diagnostics.some(
                  (d) => d.message.includes("timed out")
                );

                let label = "Non-zero exit";
                if (isSpawnError) label = "Spawn error";
                else if (isTimeout) label = "Timeout";

                failHeading.setText(
                  "✗ Lean environment test failed (" +
                  label + ")"
                );

                // Exit code
                if (
                  result.exitCode !== undefined &&
                  result.exitCode !== -1
                ) {
                  const codeEl = testResultEl.createEl("p");
                  codeEl.style.margin = "0.1rem 0";
                  codeEl.style.fontSize = "0.85em";
                  codeEl.style.fontFamily =
                    "var(--font-monospace)";
                  codeEl.setText(
                    "Exit code: " + result.exitCode
                  );
                }

                // Diagnostics
                for (const diag of result.diagnostics) {
                  const diagEl = testResultEl.createEl("p");
                  diagEl.style.margin = "0.1rem 0";
                  diagEl.style.fontSize = "0.85em";
                  diagEl.style.fontFamily =
                    "var(--font-monospace)";
                  diagEl.style.color =
                    diag.severity === "error"
                      ? "var(--text-error)"
                      : diag.severity === "warning"
                        ? "var(--text-warning)"
                        : "var(--text-muted)";
                  diagEl.setText(
                    "[" + diag.severity + "] " +
                    diag.message
                  );
                }

                // Show stdout/stderr separately (collapsed)
                if (result.stdout.trim() !== "") {
                  addOutputDetails(
                    testResultEl,
                    "Stdout",
                    result.stdout
                  );
                }
                if (result.stderr.trim() !== "") {
                  addOutputDetails(
                    testResultEl,
                    "Stderr",
                    result.stderr
                  );
                }
                if (result.debug !== undefined) {
                  addProcessDebug(testResultEl, result.debug);
                }
              }

              // ── WSL command ladder (only in WSL mode) ──────────
              if (
                this.plugin.settings.leanExecutionMode ===
                "wsl"
              ) {
                try {
                  const ladderResults =
                    await runWslCommandLadder(
                      this.buildRunnerConfig()
                    );
                  renderWslCommandLadder(
                    testResultEl,
                    ladderResults
                  );
                } catch (diagErr) {
                  const diagErrEl =
                    testResultEl.createEl("p");
                  diagErrEl.style.color =
                    "var(--text-error)";
                  diagErrEl.style.margin = "0";
                  diagErrEl.style.fontSize = "0.85em";
                  diagErrEl.style.fontFamily =
                    "var(--font-monospace)";
                  diagErrEl.setText(
                    "WSL ladder error: " +
                    (diagErr instanceof Error
                      ? diagErr.message
                      : String(diagErr))
                  );
                }
              }
            } catch (err) {
              testResultEl.empty();
              const errEl = testResultEl.createEl("p");
              errEl.style.color = "var(--text-error)";
              errEl.style.margin = "0";
              errEl.style.fontFamily = "var(--font-monospace)";
              errEl.style.fontSize = "0.85em";
              errEl.setText(
                "Unexpected error: " +
                (err instanceof Error
                  ? err.message
                  : String(err))
              );
            } finally {
              button.setButtonText("Test Lean environment");
              button.setDisabled(false);
            }
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

function addProcessDebug(
  container: HTMLElement,
  debug: {
    sawExit: boolean;
    sawClose: boolean;
    exitCode?: number;
    exitSignal?: string;
    elapsedMs: number;
    usedExitFallback: boolean;
  }
): void {
  const details = container.createEl("details");
  details.style.marginTop = "0.25rem";
  details.style.fontSize = "0.8em";

  const summary = details.createEl("summary", {
    text: "Process debug"
  });
  summary.style.cursor = "pointer";

  const pre = details.createEl("pre");
  pre.style.margin = "0.2rem 0";
  pre.style.fontSize = "0.85em";
  pre.style.fontFamily = "var(--font-monospace)";

  const lines = [
    "sawExit: " + String(debug.sawExit),
    "sawClose: " + String(debug.sawClose),
    "exitCode: " + (debug.exitCode ?? "?") +
      (debug.sawExit ? "" : " (never observed)"),
    "exitSignal: " + (debug.exitSignal ?? "none"),
    "elapsedMs: " + String(debug.elapsedMs),
    "usedExitFallback: " + String(debug.usedExitFallback)
  ];

  pre.setText(lines.join("\n"));
}

function addOutputDetails(
  container: HTMLElement,
  label: string,
  content: string
): void {
  const details = container.createEl("details");
  details.style.marginTop = "0.2rem";
  details.style.fontSize = "0.8em";

  const summary = details.createEl("summary", { text: label });
  summary.style.cursor = "pointer";

  const pre = details.createEl("pre");
  pre.style.margin = "0.2rem 0";
  pre.style.maxHeight = "200px";
  pre.style.overflowY = "auto";
  pre.style.fontSize = "0.85em";
  pre.style.fontFamily = "var(--font-monospace)";
  pre.style.whiteSpace = "pre-wrap";
  pre.setText(content.trim());
}

function renderWslCommandLadder(
  container: HTMLElement,
  results: WslLadderResults
): void {
  const details = container.createEl("details");
  details.style.marginTop = "0.5rem";
  details.style.fontSize = "0.8em";
  details.open = true;

  const summary = details.createEl("summary", {
    text: "WSL command ladder"
  });
  summary.style.cursor = "pointer";

  // ── interpretation banner ─────────────────────────────────────────
  const banner = details.createEl("p");
  banner.style.margin = "0.3rem 0";
  banner.style.fontWeight = "600";
  banner.style.fontSize = "0.9em";

  const allTimeout = results.results.every(
    (r) => r.status === "timeout"
  );
  const anySuccess = results.results.some(
    (r) => r.status === "success"
  );

  if (allTimeout) {
    banner.style.color = "var(--text-error)";
    banner.setText(results.interpretation);
  } else if (anySuccess) {
    banner.style.color = "var(--color-green)";
    banner.setText(results.interpretation);
  } else {
    banner.style.color = "var(--text-warning)";
    banner.setText(results.interpretation);
  }

  // ── per-rung table ────────────────────────────────────────────────
  const pre = details.createEl("pre");
  pre.style.margin = "0.2rem 0";
  pre.style.maxHeight = "400px";
  pre.style.overflowY = "auto";
  pre.style.fontSize = "0.82em";
  pre.style.fontFamily = "var(--font-monospace)";
  pre.style.whiteSpace = "pre-wrap";

  const lines: string[] = [];

  for (const r of results.results) {
    const statusMark =
      r.status === "success"
        ? "OK"
        : r.status === "timeout"
          ? "TIMEOUT"
          : r.status === "spawn_error"
            ? "SPAWN_ERR"
            : "EXIT_ERR";

    lines.push(
      r.label +
        "  " +
        statusMark +
        "  exit=" +
        String(r.exitCode) +
        "  " +
        String(r.elapsedMs) +
        "ms"
    );
    lines.push("  cmd: " + r.command);
    lines.push(
      "  sawExit=" +
        String(r.sawExit) +
        "  sawClose=" +
        String(r.sawClose)
    );

    if (r.stdout.trim() !== "") {
      const outLine = r.stdout.trim().split("\n")[0];
      if (outLine !== undefined) {
        lines.push(
          "  stdout: " + outLine.slice(0, 100)
        );
      }
    }

    if (r.stderr.trim() !== "") {
      const errLine = r.stderr.trim().split("\n")[0];
      if (errLine !== undefined) {
        lines.push(
          "  stderr: " + errLine.slice(0, 100)
        );
      }
      if (r.stderrHexFirstBytes !== "") {
        lines.push(
          "  stderr hex: " + r.stderrHexFirstBytes
        );
        lines.push(
          "  stderr UTF-16LE? " +
            String(r.stderrLooksUtf16LE)
        );
      }
    }

    lines.push("");
  }

  pre.setText(lines.join("\n"));
}
