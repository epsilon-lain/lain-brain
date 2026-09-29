# Lain Brain voice-agent demo

Lain Brain lets someone think aloud in an editable Chat Space. Speech becomes
numbered segments. A user-defined macro can edit those segments without sending
the command to the Brain. `recover` restores the latest edit; `ka` deliberately
sends the current Chat Space. The Brain answers in text and can read the answer
aloud using the device's text-to-speech voice.

## Set up

1. Install and enable the plugin in Obsidian. In Lain Brain settings, enter
   AssemblyAI and DeepSeek API keys. Do not put keys in a recording or repository.
2. Enable live voice input and **Read Brain answers aloud**. Wear headphones so
   the microphone does not capture the playback.
3. Open Lain Brain's Chat Space and start its microphone. Confirm that the
   status says it is listening before speaking.
4. In **Define Macro**, describe the action in ordinary language, for example:
   “当我单独说删除第几行到第几行时，删除 Chat Space 里包含首尾的那些行，并允许 recover 恢复。”
   Check that the preview has two variable integer line numbers and a range
   deletion action, then save it. The macro must be enabled.
5. Define and enable a second macro: “当我说 recover 时，恢复最近一次 Chat Space
   操作。” Confirm its preview shows **Restore last step**. Only `ka` is built in;
   `recover` needs this definition before it can be spoken as a command.

## Record one continuous take

| Scene | Say or do | Show on screen |
| --- | --- | --- |
| Capture | Say three short thoughts with brief pauses, such as “苹果”、“香蕉”、“我想比较它们”。 | Three numbered Chat Space segments appear. |
| Edit | Say “删除第二行到第三行”。 | The last two segments disappear; the command itself does not become a segment. |
| Recover | Say “recover”。 | The two segments return in their previous order. |
| Decide | Say “ka”。 | The Chat Space is submitted once; a Brain answer appears and is read aloud. |
| Interrupt | While the answer is reading, say “我要说话。还有一个问题”。 | Playback stops; the words after the stop phrase remain available as a new turn. |

The voice commands operate on **Chat Space segments**, not on lines in a Vault
note. An uncertain or failed macro decision leaves the original transcription
as ordinary text, which can be edited or submitted later. Recognition varies
with the microphone, language, and network; if a take misrecognizes a command,
show the actual text and use `recover` where an action already happened.

## Import a recording (optional)

From the paperclip menu choose **Import recording** and pick a local audio or
video file (MP3, WAV, M4A, MP4, MOV, or WebM). The file is transcribed with the
same AssemblyAI key used for live voice. **A video file is transcribed from its
audio track only — Lain Brain does not analyze the picture, slides, or
handwriting.** The Chat Space shows the file name and upload/transcription
status; when it says **Recording ready**, type a question and press Enter. The
recording transcript is attached as the context for that request, not inserted
into Chat Space and not interpreted as voice commands. An empty or failed
transcription blocks the request, shows a readable error, and keeps the
question for retry.

## What the demo proves

- AssemblyAI streams and finalizes speech turns into an editable workspace.
- A natural-language macro definition is previewed, saved, and used with
  variable line numbers. DeepSeek interprets the final turn against enabled
  macro descriptions; the plugin validates parameters and executes the action.
- Submission is deliberate. `recover` restores the most recent supported local
  operation. A sent external network request itself cannot be withdrawn.
- Imported audio/video is transcribed from its audio track only and becomes a
  pending Chat Space attachment, not a Vault note.
- Brain output remains text even if speech synthesis is unavailable. Read-aloud
  uses the device's installed voice and is enabled separately.

The final video should show the real Obsidian window and live microphone input.
Capture a clean take after testing once without recording; avoid exposing API
keys or settings values in the video.
