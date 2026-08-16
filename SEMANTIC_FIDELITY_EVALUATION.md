# Semantic Fidelity Evaluation

## 1. Research question

Does access to a user's Personal Brain improve preservation of that user's
intended mathematical meaning during formalization?

## 2. Hypothesis

Personal Brain context reduces semantic drift, especially when personal
definitions differ from public/default meanings and when terms are
overloaded. This hypothesis is explicitly falsifiable.

## 3. Why instrument-validation first

Before making empirical claims, the evaluation must be able to represent and
aggregate improvement, no difference, and regression without hardwiring a
positive conclusion. This milestone builds that instrument.

## 4. Plain LLM condition

Same source text, same provider/model/settings, normal formalization
instructions, and **no** Personal Brain semantic context.

## 5. Personal Brain condition

Same source text, same task instructions, plus the existing bounded relevant
Brain context and stable concept identity.

## 6. Manipulated variable

Availability of Personal Brain semantic context. Every other aspect of the
prompt is intended to stay as similar as practical.

## 7. Fixture design

Human-authored cases cover quantifiers, implication/equivalence, subset vs
equality, membership vs subset, analogy, personal definitions, overloaded
terms, missing assumptions, proof sketches, domain scope, and legitimate
ambiguity. Synthetic Brain fixtures keep real Vault data out of automated
runs.

## 8. Ground-truth representation

Expected concept bindings, quantifier, relations, allowed added assumptions,
expected missing conditions, ambiguity policy, and expected speech act are
stored as structured fields. No model self-grading is used.

## 9. Component metrics

- concept binding accuracy and wrong/unresolved counts;
- quantifier preservation;
- relation preservation and violations;
- assumption precision and unsupported added assumptions;
- ambiguity handling;
- structured correction-burden proxy;
- semantic violation count.

## 10. Composite score

Not implemented. Component metrics are the primary output. If a composite is
added later, it must be deterministic, bounded, documented, and decomposable.

## 11. Correction-burden proxy

Counts structured units that would need correction: wrong/unresolved
bindings, quantifier drift, relation violations, unsupported assumptions,
unidentified missing conditions, speech-act mismatch, and ambiguity errors.
It is not literal user time.

## 12. Ambiguity treatment

Preserving legitimate ambiguity is scored as better than invented certainty.
Explicit states distinguish correct preservation, incorrect collapse,
unnecessary introduction, and correct unique resolution.

## 13. Paired comparison

`compareConditions` reports improved / worsened / unchanged /
not-applicable per component for one paired case.

## 14. Aggregation

Aggregates valid/invalid counts, component counts, mean/median correction
burden, and paired deltas per condition.

## 15. Lean success is not semantic fidelity

A semantically wrong proposition can typecheck. Deterministic fixtures and
metrics treat `statement_typechecked` as a secondary outcome only.

## 16. Mocked vs live

`npm test` and `npm run eval:semantic-fidelity` are deterministic and mocked.
Live runs require a separate explicit invocation and configured DeepSeek key.

## 17. Repeated runs

The result schema stores run ID and index; repeated-run policy is left to a
future live experiment rather than hardcoded here.

## 18. Privacy

No telemetry, no uploads, no API keys in reports, no real Vault ingestion,
no cloud, no background experiments.

## 19. Threats to validity

Synthetic fixtures may not generalize; prompt differences may confound the
Brain effect; one model/provider may not generalize; small case sets have
high uncertainty; manual ground truth may contain bias; Personal Brain
quality varies; real review behavior differs; and Lean typechecking does not
establish semantic intent.

## 20. Conservative interpretation

This milestone demonstrates that the instrument can represent and aggregate
outcomes. It is not empirical evidence that Personal Brain improves semantic
fidelity.

## 21. Running deterministic evaluation

```text
npm run test:semantic-fidelity-evaluation
npm run eval:semantic-fidelity
```

## 22. Future live evaluation

Live runs should use synthetic Brain fixtures first, an explicit
`eval:semantic-fidelity:live`-style command, configurable runs-per-condition,
and no automatic API spending.

