# Reproduction and review

## Offline checks (recommended first)

Extract the submission source and open a terminal in its repository root.

`python track_2b/src/verify_evidence.py` checks each original evidence archive against the recorded SHA256, every enclosed manifest entry, sealed JSON hashes and the successful trace's raw-record references. It also confirms the reported denominators and negative results. No requests are sent.

`python track_2b/src/show_recorded_trace.py` prints the unchanged 435-rule example from the frozen replication, including original reflection and replacement text and the two later questions' three conditions. It does not generate fresh output.

`python track_2b/src/replay_policy_gradients.py` reconstructs a private temporary audit layout from the archived source and evidence, runs the included independent NumPy audit, and removes the temporary layout afterwards. The audit regenerates all 128 RNG samples, gradients, Adam moments and final weights. Python must have NumPy installed. No credential or network is required. Successful replay is numerical/record verification, not a new model experiment.

## Fresh API runs (optional, separate from archive verification)

The exact original runners are inside the evidence archives. `Lain-Zip-Frozen-Replication-Review-20261014.zip` includes `source/replicate_fixed.py`, `source/Lain-Zip-Apertus-API-Test.py`, `source/display_math.py` and `source/analyze_fixed.py`. Place them together in a fresh directory. Running `replicate_fixed.py --preflight` performs the frozen offline checks; running the script without that flag asks for a private key through non-echoing terminal stdin and uses the recorded CSCS endpoint/model. Verify the model's availability with the provider before a fresh run. This sends paid or quota-bearing API requests.

Do not paste credentials into source, notebooks committed to git, screenshots or submitted recordings. Use a separate output directory for a fresh run. Resumes use sealed committed responses; uncertain interrupted requests are recorded, not silently counted as exactly-once. API model weights and serving versions are not guaranteed identical to the archived run. See the embedded protocols for caps, temperatures and prompts.

The generic API runtime in the existing public v25 branch is a separate older five-episode diagnostic; it is not the frozen six-episode replication. Do not equate their criteria or outputs.

## License and publication

The upstream Lain Brain repository currently has an MIT license. A copy is included at `track_2b/src/UPSTREAM-MIT-LICENSE.txt` for attribution. Refer to the repository and third-party model/source terms when redistributing; the model weights are not bundled. The source preserves third-party notices; model weights are not bundled. See README-project.md and Checkpoint-Export.md for the original workspace dependency and export instructions.
