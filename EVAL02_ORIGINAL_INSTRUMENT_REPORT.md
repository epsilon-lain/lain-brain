# EVAL02 Original Instrument Report

This is the result under the pre-existing frozen Evaluation 01/02 instrument.
The original generated Markdown is preserved unchanged at:

`evaluation-results/semantic-fidelity-live-1786896465176.md`

## Original v1 summary

```text
Execution mode: live
Fixture cases: 8
Valid plain results: 8
Valid Brain results: 8

| Metric | Plain LLM | Personal Brain |
| --- | ---: | ---: |
| Quantifier drift | 0 | 0 |
| Relation violations | 0 | 0 |
| Unsupported assumptions | 22 | 22 |
| Semantic violations | 23 | 23 |
| Ambiguity errors | 0 | 0 |
| Mean correction burden | 3.25 | 3.25 |
| Median correction burden | 4.00 | 3.50 |

- personal-definition: correction unchanged, violations unchanged, bindings unchanged
- overloaded-term: correction unchanged, violations unchanged, bindings unchanged
- universal: correction reduced, violations reduced, bindings not_applicable
- implication: correction increased, violations increased, bindings not_applicable
- ambiguity: correction reduced, violations reduced, bindings not_applicable
- missing-assumption: correction unchanged, violations unchanged, bindings not_applicable
- proof-sketch: correction unchanged, violations unchanged, bindings not_applicable
- no-advantage: correction unchanged, violations unchanged, bindings not_applicable
```

The v1 aggregation appears to use one result per case/condition rather than
all 47 completed repeated trials. This report is archival and must not be
rewritten.

