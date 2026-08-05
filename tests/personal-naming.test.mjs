import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/PersonalNaming";
      export { migrateLainBrainSettings } from "./src/settings";
      export { LainBrainSession } from "./src/LainBrainSession";
      export { LainBrainNamingModal } from "./src/LainBrainNamingModal";
    `,
    resolveDir: process.cwd(),
    sourcefile: "personal-naming-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  write: false,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian",
        namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: `
          class MockElement {
            constructor() {
              this.children = [];
              this.settings = [];
              this.style = {};
              this.text = "";
            }
            empty() { this.children = []; this.settings = []; }
            setText(value) { this.text = value; }
            createEl(_tag, options = {}) {
              const child = new MockElement();
              child.text = options.text || "";
              this.children.push(child);
              return child;
            }
            createDiv() { return this.createEl("div"); }
            addEventListener() {}
            addClass() {}
          }
          class Modal {
            constructor(app) {
              this.app = app;
              this.titleEl = new MockElement();
              this.contentEl = new MockElement();
            }
            close() { this.closed = true; }
            open() { this.onOpen?.(); }
          }
          class Setting {
            constructor(container) {
              this.container = container;
              container.settings.push(this);
            }
            setName(value) { this.name = value; return this; }
            addText(callback) {
              const control = {
                inputEl: {},
                setValue(value) { this.value = value; return this; },
                onChange(handler) { this.change = handler; return this; }
              };
              callback(control);
              this.textControl = control;
              return this;
            }
          }
          exports.Modal = Modal;
          exports.Setting = Setting;
          exports.normalizePath = (value) => value.replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");
          exports.requestUrl = async () => { throw new Error("Unexpected request"); };
        `
      }));
    }
  }]
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console,
  crypto: { randomUUID: () => "test-id" },
  setTimeout,
  clearTimeout
});
const {
  applyPersonalNames,
  DEFAULT_BRAIN_DISPLAY_NAME,
  DEFAULT_USER_DISPLAY_NAME,
  getPersonalizedWorkspaceTitle,
  LainBrainNamingModal,
  LainBrainSession,
  migrateLainBrainSettings,
  NamingOnboardingSession,
  resetPersonalNames,
  validateDisplayName
} = module.exports;

const onboarding = new NamingOnboardingSession();
assert.equal(onboarding.begin(false), true);
assert.equal(onboarding.begin(false), false);
onboarding.skip();
assert.equal(onboarding.begin(false), false);
const reloadedOnboarding = new NamingOnboardingSession();
assert.equal(reloadedOnboarding.begin(true), false);

const modal = new LainBrainNamingModal(
  {},
  "You",
  "Brain",
  async () => null,
  () => {}
);
modal.onOpen();
assert.equal(modal.titleEl.text, "Welcome to Lain Brain");
assert.ok(modal.contentEl.settings.some(
  (setting) => setting.name === "What should I call you?"
));
assert.ok(modal.contentEl.settings.some(
  (setting) => setting.name === "What should I call your brain?"
));
assert.ok(modal.contentEl.children.some(
  (child) => child.children.some(
    (button) => button.text === "Start building"
  )
));
assert.ok(modal.contentEl.children.some(
  (child) => child.children.some(
    (button) => button.text === "Skip for now"
  )
));

for (const invalid of [
  "",
  "   ",
  "bad>name",
  "line\nbreak",
  "control\u0001name",
  "x".repeat(33)
]) {
  assert.equal(validateDisplayName(invalid, "Your name").ok, false);
}

const persisted = migrateLainBrainSettings(undefined);
assert.equal(persisted.userDisplayName, DEFAULT_USER_DISPLAY_NAME);
assert.equal(persisted.brainDisplayName, DEFAULT_BRAIN_DISPLAY_NAME);
assert.equal(persisted.hasCompletedNamingOnboarding, false);
assert.equal(getPersonalizedWorkspaceTitle(persisted), "Lain Brain");
assert.equal(applyPersonalNames(persisted, "  lain  ", " mirai "), null);
assert.equal(persisted.userDisplayName, "lain");
assert.equal(persisted.brainDisplayName, "mirai");
assert.equal(persisted.hasCompletedNamingOnboarding, true);

const reloaded = migrateLainBrainSettings(
  JSON.parse(JSON.stringify(persisted))
);
assert.equal(reloaded.userDisplayName, "lain");
assert.equal(reloaded.brainDisplayName, "mirai");
assert.equal(reloaded.hasCompletedNamingOnboarding, true);
assert.equal(getPersonalizedWorkspaceTitle(reloaded), "lain mirai");

let vaultWrites = 0;
const app = {
  vault: {
    cachedRead: async () => "",
    getMarkdownFiles: () => [],
    getFileByPath: () => null,
    getAbstractFileByPath: () => null,
    create: async () => { vaultWrites += 1; },
    createFolder: async () => { vaultWrites += 1; },
    modify: async () => { vaultWrites += 1; },
    trash: async () => { vaultWrites += 1; }
  },
  metadataCache: { getFirstLinkpathDest: () => null },
  workspace: { getLeaf: () => ({ openFile: async () => {} }) }
};
const session = new LainBrainSession(app, () => "");
let notifications = 0;
session.subscribe(() => { notifications += 1; });
session.setPersonalNamingProvider(() => reloaded);
assert.equal(session.userDisplayName, "lain");
assert.equal(session.brainDisplayName, "mirai");
assert.equal(session.workspaceTitle, "lain mirai");
session.notifyPersonalNamingChanged();
assert.ok(notifications >= 2);
assert.equal(vaultWrites, 0);

const sidebarSource = fs.readFileSync(
  "src/LainBrainView.ts",
  "utf8"
);
const largeSource = fs.readFileSync(
  "src/LainBrainLargeView.ts",
  "utf8"
);
const panelSource = fs.readFileSync(
  "src/LainBrainChatPanel.ts",
  "utf8"
);
assert.match(sidebarSource, /this\.session\.workspaceTitle/);
assert.match(largeSource, /this\.session\.workspaceTitle/);
assert.match(panelSource, /this\.session\.userDisplayName/);
assert.match(panelSource, /this\.session\.brainDisplayName/);
assert.doesNotMatch(
  panelSource,
  /const prefix = role === "user" \? "lain" : "brain"/
);

resetPersonalNames(reloaded);
assert.equal(reloaded.userDisplayName, "You");
assert.equal(reloaded.brainDisplayName, "Brain");
assert.equal(reloaded.hasCompletedNamingOnboarding, false);

console.log(JSON.stringify({
  firstOpenModal: "PASS",
  persistenceAcrossReload: "PASS",
  sidebarAndLargeHeaders: "PASS",
  personalizedPrefixes: "PASS",
  invalidNamesRejected: "PASS",
  skipOncePerSession: "PASS",
  vaultWrites,
  result: "PASS"
}, null, 2));
