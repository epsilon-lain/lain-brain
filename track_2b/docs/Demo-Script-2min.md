# Two-minute demo script

The official Track 2B limit is two minutes. Aim for 1:45-1:55 including transitions. This replaces the earlier suggested three-minute script.

Keep `RECORDED EVIDENCE - NO LIVE INFERENCE` visible. The following narration is approximately 207 words; rehearse below the two-minute limit.

## 0:00-0:15 - Problem

"An AI agent can remember an error as easily as useful knowledge. Lain ZIP investigates whether an Apertus agent can challenge an inherited note, save a checked replacement and reuse it."

## 0:15-0:55 - Original trace

Run `python track_2b/src/show_recorded_trace.py` from the repository root.

"This is archived model output, not live inference. The old rule says 435 times v times v equals 435 squared. At the fixed input zero, the model checks ZERO against POSITIVE and chooses RETRACT. It independently writes 435 times v squared. An exact polynomial audit validates the expression; the note is saved and read back. On the later multiplied query, the old note produces a wrong coefficient, while the revised note produces 870 times z squared."

## 0:55-1:20 - Evaluation

Show the report's replication table.

"Three of four wrong-rule episodes met our strict two-follow-up criterion. Mathematical content was correct on twelve of twelve no-note responses, ten of twelve old-note responses and twelve of twelve revised-note responses. The repaired errors repeat one task, so this demonstrates removing harmful memory, not a gain beyond the no-note baseline."

## 1:20-1:40 - Learning limitation

Show the report's controller table.

"A separate controller completed 128 real updates, but learned to withdraw and abstain everywhere. That failure is included: useful repair must improve task solving, not merely reward withdrawal."

## 1:40-1:55 - Verification

Show the completed output of `python track_2b/src/verify_evidence.py`.

"The evidence and offline verifier preserve original outputs, note versions and failures. Our next experiment will balance useful retention and revision before training."

Do not include private credentials in the recording. A 110-second English-captioned evidence walkthrough has been generated separately. It has no narration and is not a live screen recording. Its public video-host URL is still pending. This script is available if the entrant wants to add their own voiceover.
