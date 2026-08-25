# EVAL02 Forensic Analysis

## Immutable inputs
- JSON SHA-256: `6a0252d64fc77c910b818efd122dd45916394072ea9fe7ffbb21d575265d0ca5`
- Markdown SHA-256: `c3a8d59d46f4004a84ff04a017ac919f5232c51d045a3765121ce69cd067e0e9`

## Integrity
- Planned: 48
- Completed: 47
- Failed: 1
- Missing trial: `semantic-fidelity-live-1786896465176:proof-sketch:plain_llm:2` (Live trial failed.)
- Plain completed: 23
- Brain completed: 24

## Repeated-run-aware component metrics

| Metric | Plain LLM | Personal Brain |
| --- | ---: | ---: |
| Completed runs | 23 | 24 |
| Quantifier drift | 0 | 0 |
| Relation violations | 0 | 0 |
| Unsupported assumptions | 65 | 71 |
| Ambiguity errors | 0 | 0 |
| Speech-act mismatches | 2 | 3 |
| Semantic violations | 67 | 74 |
| Mean correction burden | 3.30 | 3.21 |
| Median correction burden | 4.00 | 3.00 |
| Verified binding correct | 0 | 6 |
| Model-invented/wrong bindings | 3 | 0 |
| Unresolved bindings | 3 | 0 |

## Case trend taxonomy
- personal-definition: mixed
- overloaded-term: brain_improved
- universal: mixed
- implication: mixed
- ambiguity: mixed
- missing-assumption: unchanged_both_same
- proof-sketch: mixed
- no-advantage: mixed

This is a post-hoc, repeated-run-aware reanalysis. It is NOT a pre-registered claim.