# Lain Brain

Lain Brain is an Obsidian plugin for reviewed, AI-assisted knowledge modeling. It combines conversational exploration with an explicit review workflow: AI output remains a proposal until you choose to edit, organize, create, rename, repair, or delete a note.

> **Public alpha:** Lain Brain is under active development. Review generated content carefully and back up your Vault before using write or cleanup actions.

## Key features

- **Contextual chat** — Hold multi-turn conversations with DeepSeek while optionally using the active Markdown note as background context.
- **Candidate notes** — Organize a conversation into one or more in-memory Markdown drafts, then edit and preview each draft before creating a Vault note.
- **Markdown and LaTeX** — Render Obsidian Markdown and mathematical notation, including matrices, aligned equations, cases, fractions, integrals, and other standard LaTeX constructs.
- **Local selection edits** — Discuss a selected range from a candidate draft, review the proposed replacement, and apply only that range after conflict checks.
- **Parent/child knowledge groups** — Review and create grouped parent indexes with explicit child links, without silently overwriting existing files.
- **Safe cleanup tools** — Review proposed note-name and broken-link repairs before approving individual changes. Deleted plugin-created notes are moved to Obsidian Trash.
- **Optional image-provider architecture** — Attach an image for transient analysis through an explicitly selected, configured vision provider. Text-only chat continues to use DeepSeek.
- **Personal naming** — Choose the names shown for you and the assistant in the terminal-style chat interface.

Lain Brain does not execute terminal commands. Its terminal appearance is only a chat interface.

## Requirements

- Obsidian 1.0.0 or later
- Node.js 18 or later and npm, when building from source
- A DeepSeek API key for text chat
- An API key for an optional configured image provider only if image analysis is used

## Manual installation

Lain Brain is not yet distributed through the Obsidian Community Plugins catalog.

1. Obtain **main.js** and **manifest.json** from a trusted release, or build them from source as described below.
2. Create this folder inside your Vault:

       <your-vault>/.obsidian/plugins/lain-brain/

3. Copy **main.js** and **manifest.json** into that folder.
4. Restart Obsidian, or reload the app.
5. Open **Settings → Community plugins**, enable community plugins if necessary, and enable **Lain Brain**.
6. Open **Settings → Lain Brain** to configure the DeepSeek API key, optional image providers, and display names.

## Build from source

Clone or download this repository, open a terminal in its parent directory, and run:

    cd lain-brain
    npm ci
    npm test
    npm run build

The production build writes **main.js** in the project root. For manual installation, copy the generated **main.js** and the tracked **manifest.json** into **<your-vault>/.obsidian/plugins/lain-brain/**.

Development mode is available with:

    npm run dev

## Reviewed workflow

1. Open the Lain Brain sidebar or large chat workspace.
2. Discuss a topic and review the assistant's response.
3. Organize the conversation into candidate notes.
4. Edit and preview the candidate Markdown and LaTeX locally.
5. Optionally review selection-level replacements.
6. Explicitly confirm **Create Note** or **Create Group** before Lain Brain writes new notes to the Vault.
7. Review each cleanup proposal before selecting and confirming a change.

## Privacy and data handling

- API keys are stored in the local Obsidian plugin settings (**data.json**). They are not hardcoded, printed, or intentionally logged by Lain Brain.
- Text sent for chat is transmitted to DeepSeek. Active-note content is included only as conversational context when applicable.
- Images are sent only after an image is attached, an enabled image provider is selected, and the user confirms the first send to that provider during the session. Image data is transient and is not written to plugin settings, candidate notes, or the Vault by the image workflow.
- Candidate notes remain in the current in-memory session until the user explicitly creates a note or group.
- Vault writes require an explicit user action and confirmation. Cleanup tools are review-first, and existing files are not silently overwritten.
- Lain Brain does not perform background uploads.

Review the privacy terms of DeepSeek and any optional image provider you configure. Provider requests leave your device and are governed by that provider's policies.

## Alpha limitations

- Lain Brain does not automatically learn facts, train a model, or update model weights from your Vault.
- It does not continuously index the Vault or upload notes in the background.
- AI output can be incomplete, incorrect, or misleading. Candidate-note review is a safety boundary, not a guarantee of factual accuracy.
- Candidate and conversation state is currently session-oriented and may not survive an Obsidian restart unless a note is explicitly created.
- Existing notes are not automatically synchronized after a created candidate is edited.
- Back up your Vault before using alpha software, especially before approving rename, link-cleanup, group-creation, or Trash actions.

## Development checks

Before preparing a release:

    npm test
    npm run build

Every public release must include the manual-installation artifacts **main.js** and **manifest.json**. Source maps, local plugin settings, Vault configuration, credentials, and test Vaults must remain untracked.

## License

Lain Brain is available under the [MIT License](LICENSE).
