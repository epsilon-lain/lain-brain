# Model card: Lain ZIP local adapters

## Identity and architecture

Base snapshot: `swiss-ai/Apertus-v1.1-0.5B-Instruct`, architecture `apertus`, 438,349,352 parameters. Historical base tensor SHA256 reported in the run metadata: `b7fda2f3e6a47bc00de20f88f38ab52fb2d1df68bf9b4c0016a99dd4d2aa8b3d`.

The original `MathWriterAdapter` freezes the base and adds independent rank-8, alpha-16 low-rank deltas to q/v projections in its final four attention layers. A projection output is augmented by `(alpha/rank) * B(A(x))`. Delta A is Kaiming-initialized and B starts at zero. The custom checkpoint contains only `ModuleDict` delta tensors, not a complete model and not a PEFT `adapter_config.json` package.

The relevant archived files are approximately 427,440 bytes each. Their presence and actual file hashes in this public branch remain pending. The export script computes hashes from the original bytes. A tensor-state digest in an experiment summary is distinct from SHA256 of a safetensors file.

## Components intended for release

| Component | Checkpoint | Reported effective parameter-changing updates | Use |
| --- | --- | ---: | --- |
| v15 mathematical writer | `zip-math-long-362b296b/committed/step-0192/writer.safetensors` | 192 | Mathematical response generation with the original base |
| Scale-course writer | `zip-scale-curve-309e8004/reward-on-scale-writer-final.safetensors` | 377 | Earlier rewarded rule-application course; separate trained state |
| v24 meta adapter | `zip-conditional-final-a1afc8a6/committed/step-0128/meta.safetensors` | 96 | Constrained property/memory decisions within the original stacked pipeline |
| v24 editor adapter | `zip-conditional-final-a1afc8a6/committed/step-0128/editor.safetensors` | **0** | Unchanged initial editor; not evidence of learned repair |

The v24 stack also uses frozen source mathematical, repair and prior-reflection adapters. Export binding metadata and the directly referenced dependencies before claiming that all components for historical inference are available. The single-adapter loader is insufficient for reproducing that stack.

## Evaluation scope

The historical review distinguishes training counts, periodic paired evaluation, final-snapshot evaluation, fixture tests, and externally checked method-selection probability. In v15, managed successful-route probability improved by 19.39 percentage points over 24 periodic evaluation objects across milestones, while the final checkpoint's four-object managed comparison improved by 0.67 points. Neither number is a public benchmark accuracy.

Summary context helped some rounds and harmed others. Six successive v7 courses have a descriptive same-head mean context effect of +0.75 points. No broad mathematical generalization, independent mathematical-principle discovery, reliable self-correction, or autonomous memory retrieval is established.

## Intended use and limitations

Research and inspection of a small, bounded algebra-learning pipeline. Mathematical outputs require independent verification. The models can produce false equalities, incomplete formats, unjustified withdrawals and ineffective notes. Host-supplied candidate routes, structural guards and exact polynomial verification are part of the experimental setup and must not be attributed to autonomous student reasoning.

Model availability: source and documentation published first; original checkpoint bytes pending transfer. Base weights and tokenizer are not redistributed. Follow the original model's license and attribution terms; no independent model-license grant is asserted here.
