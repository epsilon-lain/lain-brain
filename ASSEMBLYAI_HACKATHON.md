# AssemblyAI Voice Agent Hackathon

## Submission concept

**Lain Brain Voice — speak an informal thought, preserve its wording, and send
it through the same semantic-memory and formalization pipeline as typed input.**

The differentiator is not speech-to-text by itself. Voice is an additional I/O
modality for an existing personal semantic system: the transcript remains
editable before it enters memory, and the established Lain Brain pipeline
handles contextual senses, semantic changes, candidate concepts, mathematical
formalization, and Lean proof workspaces.

## Demo path

1. Open an Obsidian vault with Lain Brain installed.
2. Configure the AssemblyAI API key in Lain Brain settings.
3. Open the large Lain Brain chat view.
4. Press the microphone icon.
5. Speak a mixed Mandarin/English mathematical thought.
6. Show the live transcript appearing in the existing draft field.
7. Stop recording and show the final formatted transcript.
8. Send it and show the normal Brain response and downstream semantic tools.

## Architecture

```text
Microphone
  -> Web Audio mono samples
  -> 16 kHz PCM16 resampler
  -> AssemblyAI Universal-3.5 Pro Streaming
  -> partial/final Turn reducer
  -> existing Lain Brain chat draft
  -> semantic memory / formalization / Lean workflows
```

## Security and privacy boundary

- The long-lived AssemblyAI API key stays in local Obsidian plugin data.
- The plugin requests a one-use temporary streaming token before each session.
- The WebSocket receives the temporary token, not the long-lived key.
- Audio tracks and Web Audio nodes are released on stop, failure, or panel
  destruction.
- Stop sends AssemblyAI's `Terminate` message so the session finalizes and
  does not remain billable until automatic expiry.
- A voice transcript is editable before the user deliberately sends it into
  Lain Brain memory.

## Required submission assets

- [ ] Deployed/installable release artifact
- [ ] Public GitHub repository and setup instructions
- [ ] 2–3 minute demo video
- [ ] Architecture diagram or screenshot
- [ ] Clear disclosure that AssemblyAI powers streaming transcription
- [ ] One Mandarin/English code-switching example
- [ ] One failure/recovery example (permission denied or connection failure)
- [ ] Devpost/lablab project description
- [ ] Product feedback for AssemblyAI
