# Video script

Recorded-evidence walkthrough with Microsoft en-US-JennyNeural synthetic English narration (-8% rate), three actual prototype views, and burned-in sentence subtitles. The prototype is displaying recorded evidence, not live model inference.

## 1. Can an AI revise what it remembers? (12.01 seconds)

This is Lain ZIP, a research prototype using Apertus. It asks a practical question: when an agent remembers an error, can it check and revise that memory?

## 2. Start with a real inherited error. (12.13 seconds)

Here is an actual archived error. At the fixed input v equals zero, separate Apertus calls identify zero on the left and a positive value on the right.

## 3. Withdraw. Rewrite. Check. Save. (12.58 seconds)

The model retracts the note and writes a replacement. An exact polynomial auditor checks the expression. We preserve the original and save the checked revision.

## 4. Does the saved revision help later? (11.98 seconds)

On the later task, the old note leads to a wrong answer. The revised note restores the correct answer. The no note baseline was already correct.

## 5. Report the complete pilot. (14.55 seconds)

The frozen pilot completes three of four strict repair workflows. This is a narrow result. Two repaired errors repeat one task, and a newer test also shows a false withdrawal.

## 6. Local training shows bounded progress. (14.65 seconds)

Separate local training changes a small adapter. Periodic route success mass improves, but the final checkpoint advantage is small. These probabilities are not measured answer accuracy.

## 7. Learning memory use is still unfinished. (13.52 seconds)

Four selector batches favor training, while written summaries have mixed effects. A separate controller learns only withdrawal. We report that failure alongside the progress.

## 8. Run it. Inspect it. Reproduce it. (14.36 seconds)

The public submission includes a runnable prototype, raw evidence, training source and seven adapters. Inspect the records, reproduce the checks, and help test useful memory revision.