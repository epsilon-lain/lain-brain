# EVAL02 Post-Hoc Reanalysis

> POST-HOC REANALYSIS
> NOT PRE-REGISTERED

This reanalysis uses all completed repeated trials (47/48) and applies a
verified binding normalization: a concept binding counts as correct only when
its stable ID matches the fixture ground truth after removing `@revision`
suffixes. Model-invented arbitrary `conceptId` strings are not trusted merely
because the model labeled them `resolved`.

## v1 vs v2

### Completed runs

| Instrument | Plain | Brain |
| --- | ---: | ---: |
| v1 (one result per case) | 8 | 8 |
| v2 (all completed trials) | 23 | 24 |

### Component metrics

| Metric | v1 Plain | v1 Brain | v2 Plain | v2 Brain |
| --- | ---: | ---: | ---: | ---: |
| Quantifier drift | 0 | 0 | 0 | 0 |
| Relation violations | 0 | 0 | 0 | 0 |
| Unsupported assumptions | 22 | 22 | 65 | 71 |
| Semantic violations | 23 | 23 | 67 | 74 |
| Ambiguity errors | 0 | 0 | 0 | 0 |
| Speech-act mismatches | not reported | not reported | 2 | 3 |
| Mean correction burden | 3.25 | 3.25 | 3.30 | 3.21 |
| Median correction burden | 4.00 | 3.50 | 4.00 | 3.00 |
| Verified binding correct | not reported | not reported | 0 | 6 |
| Model-invented/wrong bindings | not reported | not reported | 3 | 0 |
| Unresolved bindings | not reported | not reported | 3 | 0 |

## Differences and what they mean

1. v1 reported only 8 valid results per condition; v2 exposes 23/24 completed
   runs. The original report therefore collapsed repeated runs by case.

2. Unsupported-assumption and semantic-violation totals differ only because
   v2 sums across runs. The original v1 comparison was approximately equal
   between conditions; v2 confirms the same near-equality but with Brain
   slightly higher on total unsupported assumptions and violations in the raw
   completed-run set.

3. The most important v2 change is concept-binding visibility. Brain condition
   produced 6 verified stable-ID bindings; plain produced 0. This was invisible
   in v1 because bindings were reported as `unchanged` at the case level.

4. The missing trial remains visible and is not imputed. The missing trial is:
   `proof-sketch:plain_llm:2`.

5. Brain's apparent identity-grounding advantage does not imply overall
   superiority: Brain also accumulated more unsupported assumptions in the
   repeated-run view.

## Interpretation

This is a descriptive reanalysis of one small synthetic experiment. It is not
evidence of general Personal Brain effectiveness.

