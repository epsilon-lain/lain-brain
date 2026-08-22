# Experiment 04R Human Review

## Verdict

EXPERIMENT 04R HUMAN REVIEW: APPROVED

LIVE EXECUTION AUTHORIZATION: PENDING RUNNER REVIEW

## Background

Experiment 04 was blocked before any live provider request because human review
found answer-bearing semantic context in several rich-context treatments.

Experiment 04R is a new frozen revision designed to remove that confound while
preserving the original research question.

Experiment 04 provider/network requests remained zero.

## Machine review

- TypeScript check: PASS
- Instrument tests: PASS
- Freeze tests: PASS
- Offline dry run: PASS
- Preflight: PASS
- Answer-bearing-context audit: PASS
- Provider-visible forbidden-fragment guard: PASS
- Evaluator-metadata isolation: PASS
- Prompt leakage checks: PASS
- Deterministic rerun: PASS
- Provider/network requests: 0

## Human fixture review

| Fixture | Verdict |
| --- | --- |
| harbor-private-meaning | PASS |
| lantern-private-meaning | PASS |
| compass-private-meaning | PASS |
| field-overload | PASS |
| proof-overload | PASS |
| bridge-ambiguity | PASS |
| normal-operator-missing-assumption | PASS |
| modus-ponens-precision | PASS |
| delta-control | PASS WITH LIMITATION |
| boundary-definition | PASS |
| spectral-proof-sketch | PASS |
| compass-revision | PASS WITH LIMITATION |

## Accepted limitations

### delta-control

The provider-visible Personal Brain definition remains semantically related to
changes between two revisions. This is accepted as legitimate private concept
knowledge.

The scored temporal claim — that the delta is marked before comparison — must
still be inferred from the source text and is not supplied by the treatment.

### compass-revision

The provider-visible stable concept ID contains the revision marker `@2`.

This provides weak revision metadata, but does not state that the revision is
current, correct, superseding, or that it selects reversible steps.

The source itself explicitly states the current contrast ("now ... not ...").
This residual cue is therefore accepted as a documented limitation rather than
a blocking answer leak.

## Freeze identity

- Definition SHA-256:
  `55711fa7ea44fb3979f618d04c7964d19214cef29525debdd28894a355899d5d`
- Fixture-table SHA-256:
  `128909ec3b740496671415cc3989228ec30b4bbf89724806f3930163b428b9d5`
- Treatment-manifest SHA-256:
  `2603e22d59fcc609b1cfc0fa2ade5e9839843b517ee836a2da2ae6b636b7d265`
- Common-prompt SHA-256:
  `979ed816c0c7b5c771b7f5545b091a33aa9b634dfca7d1b9379bee3969484ea4`
- Response-schema SHA-256:
  `7f31d0cd9f8f50f4e0918db5ab737725fa1933d9e6fd17120815622ef3c2f29e`
- Audit-manifest SHA-256:
  `0eab2e7097c76da5443a42c0565324163bf02d2f0c396958683516f2382879db`

## Ratification

The experiment design and the documented limitations above were presented for
human review and accepted.

Experiment 04R may proceed to LIVE RUNNER REVIEW.

This document does NOT by itself authorize a provider request.

A live execution path must first be independently inspected to verify that:

1. provider-visible request bytes are exactly those represented by the frozen
   Experiment 04R design;
2. freeze/preflight verification occurs before any request;
3. no hidden evaluator metadata becomes provider-visible;
4. no automatic retry changes the preregistered trial population;
5. failures are recorded without imputation;
6. no Experiment 04 artifact is mutated.

Until that review passes:

LIVE EXECUTION AUTHORIZATION: PENDING RUNNER REVIEW
