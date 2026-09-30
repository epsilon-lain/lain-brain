# Lain Brain — Nebius × NVIDIA Personal AI milestone

Lain Brain helps a person preserve their own meanings across conversations and use those meanings when working with AI and tools. This milestone connects the existing reviewed semantic workflow to NVIDIA Nemotron on Nebius Token Factory.

This is an integration milestone, not a claim of complete understanding, guaranteed alignment, an always-on cloud assistant, or a finished competition submission.

## Runtime integration

Select **Settings → Lain Brain → Text AI → Text provider → Nebius Token Factory · NVIDIA Nemotron**. Enter your Token Factory API key locally. The default NVIDIA model is:

```text
nvidia/nemotron-3-super-120b-a12b
```

The runtime endpoint is:

```text
https://api.tokenfactory.us-central1.nebius.com/v1/chat/completions
```

This endpoint/model pair follows the [official Nebius Nemotron Super cookbook](https://github.com/nebius/token-factory-cookbook/blob/main/models/nemotron/nemotron3-super-120B.md). Availability in the entrant's account still needs a live check. Other NVIDIA model IDs may be entered; the model's availability and license must be checked before using it for submission. The `nvidia/` prefix alone is not license evidence.

The selected text provider serves foreground chat, semantic interpretation, bounded semantic-change proposals, reviewed note drafting, macro definition/intent processing, and formalization translation. Images retain their separate explicitly selected provider. Voice transcription retains AssemblyAI. No cloud VM or serverless deployment is provisioned by this change.

Existing settings continue to select DeepSeek until the user chooses Nebius. Selecting Nebius never borrows a DeepSeek key or silently falls back to DeepSeek. Each captured chat turn and its queued semantic analyses retain the same provider configuration even if settings change while the request is in flight.

## Personal authority and data

Nemotron proposes; the user reviews. Model output does not itself authorize a ConceptNode definition change. Existing explicit review, evidence validation, revision checks, and bounded propagation remain in place. Rejecting a proposal does not write the proposed meaning to the Vault.

Normal chat can send conversation and relevant note context to the selected provider. The optional semantic-delta request uses at most three recent eligible text-only turns; it excludes active-note content, attachments, PDFs and whole-Vault content. The separate existing semantic-interpretation analysis can use conversation history. This integration does not make remote inference local or guarantee perfect semantic fidelity.

API keys are saved in plugin settings locally; they are not encrypted by this implementation. Do not include local `data.json` in shared Vaults, screenshots, code repositories or demo builds. Request receipts include only provider/model, endpoint, completion time, optional response ID and token counts; they are session-local and omit prompts and credentials. **Last successful text request** in settings shows the latest receipt after reopening settings. It can describe a supplemental request, not necessarily the foreground answer.

## Build and verify

```bash
npm ci
npm run test:nebius
npm test
npm run build
```

Install `main.js` and `manifest.json` into a test Vault's `.obsidian/plugins/lain-brain/` directory. Reload Obsidian, select Nebius, then send a text message.

`test:nebius` uses a mock transport. It verifies routing, settings migration, blocked missing credentials, no fallback, safe errors, secret-free receipts, preserved semantic evidence, in-flight provider selection, and a Session path where a proposal remains reviewable without Vault writes. It does **not** demonstrate a successful live Nebius request or model quality.

For a real provider check, set `NEBIUS_API_KEY` locally using your usual secure environment setup and run:

```bash
npm run nebius:smoke
```

The check sends two small synthetic requests, may consume credits, and prints only receipts and a parsed semantic-analysis outcome. It exits 2 without a key, 1 on failure or an unusable synthetic proposal, and 0 on successful requests plus a usable proposal. It does not modify a Vault and does not replace desktop testing.

## Demonstration to record

1. In a disposable Vault, select Nebius and the default Nemotron model. Show a successful runtime receipt without showing the key.
2. Explain a personal concept: “When I say Brain, I mean my personal semantic system for communicating with AI and tools.” Show the AI response and the proposed definition with exact user evidence.
3. Edit the proposed meaning and explicitly confirm it. Inspect the saved concept and revision. Rejection should also be demonstrable without modifying the definition.
4. Start a fresh conversation and ask Brain to help draft a project explanation using that concept. Inspect the activated concept context and the actual answer. This step must be tested before claiming cross-session fidelity.
5. Define and review a reusable editing macro; demonstrate its operation and recovery in Chat Space. These existing bounded editing actions are the first tool example. Broader external-tool execution remains future work.

Use synthetic or intentionally shareable notes. Record the application actually running; keep the public YouTube video below three minutes and provide English narration or translations.

## Submission requirements and remaining work

Checked against the [official rules](https://nebiusglobalaihackathon.devpost.com/rules) on 2026-09-30:

| Requirement | How this milestone addresses it / remaining work |
| --- | --- |
| Runtime on Nebius + at least one NVIDIA open source model | Implemented Token Factory runtime path with the official Nemotron Super model; live account/API verification pending. |
| Personal AI track | Existing persistent concept memory, user-controlled meanings and reviewed reusable macros support this track. Demonstrate a coherent daily workflow; persistent always-on operation is not implemented here. |
| Working install and test access | Build/install instructions are supplied. Desktop verification and a judge-accessible test build still need completion. Access must remain free for judges through the judging period. |
| Public licensed source | Repository includes MIT. Publish the reviewed competition branch/build and ensure all required assets are available. |
| Significant updates for a pre-existing project | Describe and date the actual semantic workflow and Nebius integration improvements made during the submission period; do not describe older features as newly implemented. |
| Description, video and English materials | Prepare the final description, actual demo recording and English testing instructions. |
| Feedback on sponsor technology | Record actual runtime experience and limitations after live tests; mock tests are not sponsor feedback. |

Submission deadline: **2026-10-31 01:00 Asia/Shanghai** (2026-10-30 10:00 PDT). The rules currently list judging through 2026-12-15. Check organizer updates before final submission.

## Validation performed for this change

Base: `0d3bab1` on `codex/voice-intent-jev-integration`.

- Production build and TypeScript checks: passed.
- All 86 test scripts listed in `npm test` were executed individually so existing failures did not hide later checks: **84 passed, 2 failed**.
- The two failures are `test:brain-migration` (unsupported frontmatter expected to fail but prepared) and `test:brain-migration-workspace-modal` (cancel after migration expected to preserve original Markdown). Both failures were reproduced on the unchanged base commit. They were not fixed by the provider integration and remain open.
- New `test:nebius`: passed with mock transport, including actual Session routing and unconfirmed proposal write protection.
- Live smoke check: **not run**; no `NEBIUS_API_KEY` was available (expected exit code 2).
- Obsidian desktop deployment, cross-session live demo and actual Nemotron quality evaluation: pending.

Production `main.js` SHA256: `48adc6da564a646043c7e04420d76901102be37ddc52aec1c2489bd654f97092`.
