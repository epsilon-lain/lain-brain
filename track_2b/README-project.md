# Lain ZIP: Checkable and Revisable Memory for Apertus

Team: **Lain Brain**, solo project by **epsilon-lain**, with AI-assisted development. Track 2B. The official challenge description remains in `README.md`; this file describes the implementation.

## Run the prototype

From the repository root (or from `track_2b/`):

```bash
make run
```

Open **http://localhost:7860**. This builds a Docker container and starts the English browser interface. Without credentials it displays the original recorded Apertus trace and honest frozen evaluation results. The interface explicitly labels archived evidence. It does not fabricate a new inference run.

For new live inference, set the three official configuration variables in your shell, then run `make run`:

```bash
export LLM_NAME=swiss-ai/Apertus-v1.5-70B
export LLM_BASE_URL=https://api.inference.cscs.ch/v1
read -rsp 'Private CSCS key: ' LLM_API_KEY; echo
export LLM_API_KEY
make run
```

Choose the wrong 435 rule or the correct-note 315 control. The live button makes at most seven requests per run, saves each raw response before scoring, records the actual model decision, admits only a polynomial-checked model-written replacement, reloads it, and compares no/old/new note results on a later query. New inference is shown separately from recorded evaluation. No model weights are trained by this interface. Provider availability, token usage and accuracy may change.

The Docker host port binds only to localhost. Credentials stay in server memory and are not returned to the browser or saved to records. Runtime records are written to the bind-mounted `track_2b/outputs/` folder. A pending interrupted request may have reached the provider; no exactly-once guarantee is made.

## Without Docker

Python 3.12, standard library only:

```bash
python track_2b/src/app.py
make test audit
make replay
```

The separate 128-step policy-gradient audit needs NumPy:

```bash
python -m pip install numpy
python track_2b/src/replay_policy_gradients.py
```

## Models and training

- Working prototype: frozen Apertus v1.5 70B API inference; the archived diagnostic additionally used v1.5 8B.
- Historical local student: Apertus v1.1 0.5B Instruct. Seven original adapter files, the v15/v24 training runtime, loading instructions and checkpoint provenance are published in [`../experiments/zip/hack-apertus-2026/`](../experiments/zip/hack-apertus-2026/). The local training runtime expects compatible Apertus base weights and historical source inputs; it is separate from the Docker prototype.
- External memory controller: 128 real NumPy parameter updates, fully archived and replayable. It collapsed to withdrawal/abstention; no correctness gain is claimed.
- Seven local adapter files are included in the companion directory. Base model weights and tokenizer must be supplied separately. `verify_adapters.py` checks the released files and source bindings without PyTorch.

## Results

Frozen 70B replication: five rule units, six episodes; 4/4 wrong-rule withdrawals and verified replacements; 3/4 strict two-follow-up closed loops; 0/2 mistaken withdrawals of correct rules. Content correctness: no note 12/12, old note 10/12, revised note 12/12. The two repaired failures repeat one task; the no-note baseline was already content-correct. See `LainBrain_Report.pdf` and all original evidence in `data/evidence/`.

## Validation status

The [GitHub Actions Docker check passed](https://github.com/epsilon-lain/lain-brain/actions/runs/38736814313): 11 tests, both evidence audits, container build, in-container audit and HTTP request to the running container. See `docs/Validation.json`. Base-model inference for the released local adapters was not rerun here.

## Publication

The `track_2b/` scaffold and Docker entry point derive from the official HackApertus template. This submission is published on branch `codex/hack-apertus-model-training-20261015` of `epsilon-lain/lain-brain`; the repository also retains the earlier Lain Brain project. Use this branch URL when reviewing the submission.

No prerecorded video is a claim of live inference, model training progress or a peer-reviewed result. The video supplied alongside this source is a captioned recorded-evidence walkthrough.

## Separate implementation smoke on 15 October

Two new API runs generated 14 actual responses. The 435 case withdrew and admitted a correct replacement. The correct 315 control also withdrew despite no grounded conflict: a false withdrawal, retained as a failure. See data/prototype-smoke/analysis.json and its original sealed results. These are not added to the frozen 63-response evaluation. The smoke exposed a display-field confusion between final-expression correctness and full-output acceptance; a separate corrected analysis and future runtime fields distinguish them without altering the originals.

## Report and video

- [Six-page technical report](LainBrain_Report.pdf) and [Markdown source](technical_report.md).
- [114-second narrated evidence walkthrough](docs/video/Lain-ZIP-Demo.mp4), [captions](docs/video/Lain-ZIP-Demo.srt), and [script](docs/video/SCRIPT.md). The English voice is synthetic; all displayed mathematical outputs come from recorded evidence.

Local training: four eight-object selector batches favor the trained selector. A 192-update writer has a positive periodic route-mass aggregate but only +0.67 percentage points on four final managed-route objects. Six consecutive summary courses have mixed effects (+0.75 pp descriptive mean). These are limited pilot metrics, not a general learning claim; see the report for denominators and controls.
