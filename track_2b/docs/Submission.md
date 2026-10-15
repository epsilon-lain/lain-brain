# Lain ZIP: Checkable and Revisable Memory for Apertus

Suggested track: Apertus Adoption - Own Project (2B).
These are paste-ready project texts, not an assertion that the current official form uses these exact fields.

## One-line pitch

An auditable memory workflow for Apertus agents that checks inherited rules, revises erroneous notes, and measures whether later use actually improves.

## Short description

Lain ZIP turns external AI memory into inspectable, revisable records. Apertus checks a designed counterexample, decides whether to withdraw a saved rule, independently writes a replacement, and reuses the version saved to disk. Exact polynomial audits validate formal replacements while raw reflection text remains available for human review. A limited frozen replication demonstrated inherited-note repair; a separate trained controller exposed collapse toward abstention. Both successful traces and failed learning outcomes are included with reproducible evidence.

## Problem and inspiration

A retrieved note can help an AI agent, but a wrong note can also amplify a mistake across future tasks. I wanted to investigate memory as something an agent can inspect and revise, rather than treat as permanently authoritative. ZIP is my name for a reusable knowledge record; it is not a claim of a new neural architecture.

## What it does

The current prototype preserves model outputs before grading, tracks note versions, uses fixed counterexamples to challenge formal rules, records actual KEEP/RETRACT decisions, and admits model-written replacements only after an exact mathematical check. Revised notes are saved and read back before later queries. Matched no-note, old-note and revised-note conditions separate mathematical content from output-format compliance. A second experimental component trains an external memory-operation controller from actual subsequent-answer rewards.

## How it was built

I directed the project and experiment design, using AI coding assistance for implementation, debugging and documentation. Earlier local experiments used an Apertus 0.5B student. This submission's directly archived API experiments use Apertus v1.5 8B and 70B through CSCS. Python handles request receipts, immutable raw records, scoped polynomial checking and memory transactions. NumPy implements a small sampled REINFORCE/Adam controller. The 70B model writes the formal replacements; the host validates them rather than filling in missing answers. The API model weights remain frozen.

## Results and accomplishments

In a frozen 70B replication with five rule units and six episodes, all four wrong-rule episodes produced withdrawals and independently verified replacements. Three of four met the predeclared strict two-follow-up workflow. Correct-note controls had zero mistaken withdrawals across two episodes. Mathematical content was correct on 12/12 no-note, 10/12 old-note and 12/12 revised-note responses. The two repaired failures repeated one underlying task, and revised notes did not beat the no-memory content baseline.

The separate outcome-learning pilot completed 128 real external-controller updates. Its utility improved relative to an initially uniform policy, but it selected RETRACT for every held-out context, giving eight abstentions and no correct answers. It matched constant withdrawal rather than learning useful conditional repair. An additional feedback-note exploration scored 0/6 versus 1/6 for the original formula-note comparison. These failures are retained because they identify the next design requirements.

## Challenges and lessons

Correct mathematical notation can fail a narrow parser; human-readable reasoning can fail a categorical output interface. We preserved the original failures and documented narrowly scoped notation and implementation corrections. We also learned that rewarding later outcomes is insufficient if the realized training distribution rewards only withdrawal. A memory learner must demonstrate preserving useful knowledge as well as removing harmful knowledge.

## Value, cost and feasibility

The target use is scientific or educational agents whose formal notes can be checked and revised with provenance. The implemented pilot is small and inspectable, using open Apertus models with local audit code and a lightweight controller. Archived review is offline; live reruns require an API credential. Currency cost, scalable throughput and self-hosted deployment remain unbenchmarked. The demonstrated inference endpoint is hosted by CSCS in Switzerland; we do not claim a completed sovereign production deployment.

## What comes next

Ensure that actual training examples support KEEP, OVERWRITE and RETRACT before applying gradients; train note writing separately; compare against equal-budget retries and fixed operations on unseen definitions and multiple seeds. A stronger result would improve correct answers while protecting valid notes, rather than merely increasing abstention.

## Links to paste

Project repository: https://github.com/epsilon-lain/lain-brain
Existing API experiment branch: https://github.com/epsilon-lain/lain-brain/tree/codex/zip-conditional-v24-20261014
Report, evidence bundle and video: attach or upload the corresponding files/recording from this dossier. The template-compatible source is prepared locally. Public upload to the proposed codex/hack-apertus-submission-20261015 branch is pending explicit authorization of the destination and raw-record payload; it has not been published. The 110-second English-captioned evidence walkthrough is supplied separately. Upload it to a publicly viewable video host and paste that URL; a local MP4 path is not a public video URL.

## Submission logistics (verified 14 October 2026)

The official Devpost overview lists the deadline as 16 October 2026, 12:00 CEST (18:00 Asia/Shanghai), and directs submissions to https://hackapertus.ch/online-hack/submissions rather than Devpost. Track-specific details are delegated to the Getting Started Guide. Update, 15 October 2026: the entrant supplied the actual form, and the official Track 2B README was read through GitHub. The PDF limit is six pages without references, the video limit is two minutes, and the public repository must preserve the track_2b layout and run end-to-end using Docker via make run. The source includes the required track_2b layout, Docker entry point, six-page report and English-captioned 110-second video. Check docs/Validation.json for what has actually executed. The original 0.5B checkpoint must still be exported from the training Notebook before publishing that model.

Source: https://hackapertus.devpost.com/ and https://hackapertus.devpost.com/rules
