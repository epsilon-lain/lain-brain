# Structural Conflict Diagnostics

## Why conflicts exist

Personal semantic systems evolve. A relationship that was useful earlier may
become suspicious after a later, explicitly confirmed structural change. Lain
Brain preserves both structures and records a review item instead of silently
choosing which meaning is correct.

## Detection

Detection is deterministic and read-only. It consumes current `ConceptNode`
relationships, confirmed `SemanticDelta` history, and current concept
revisions. It does not call an LLM, rewrite a concept, delete a relationship,
or authorize additional propagation.

The v0 rule registry is deliberately conservative:

- `explicitly_distinct_from` plus an exact equivalence-like relationship
  (`equivalent_to` or `same_as`) is a hard structural conflict.
- a confirmed relationship removal whose exact edge is still active is an
  integrity anomaly;
- duplicate symmetric `explicitly_distinct_from` edges are an integrity
  anomaly;
- `analogous_to` plus `explicitly_distinct_from` is not a hard conflict;
- association, dependency, containment, and example relations do not imply
  equivalence.

The public Chat relationship set is unchanged. Equivalence-like names are used
only by the diagnostic taxonomy so existing or future explicit relationships
can be inspected without expanding Chat generation authority.

## Hard conflict and tension

A hard conflict means two active structures cannot safely be treated as the
same intended semantics without clarification. A structural tension may be
worth review while still allowing both relations to coexist. The v0 detector
prefers false negatives: it does not emit a tension merely because two concepts
are related, and it never promotes analogy to equivalence.

## Authority

A diagnostic is not a semantic decision. Open conflict records may be linked
to the existing pending-decision inbox, but neither the record nor that link
changes personal meaning. Only an explicit maintenance or Chat Semantic Delta
confirmation can change a `ConceptNode`.

## Resolution and dismissal

Use existing reviewed maintenance operations to remove or change a conflicting
relationship. A later diagnostic pass marks an obsolete conflict as
`superseded`; historical evidence remains available.

Dismissal means the user reviewed the diagnostic and does not currently
consider it a problem. It does not delete evidence, relationships, revisions,
or Semantic Deltas. Identical evidence keeps the same stable conflict ID and is
not immediately recreated. Materially new relation or Semantic Delta evidence
may create a new record.

## History and explainability

Each record stores the deterministic rule ID, stable concept IDs, exact active
relationship IDs and types, relevant revisions, matching Semantic Delta IDs,
and detector provenance. The maintenance workspace presents these fields as
readable labels rather than raw JSON.

`explicitly_distinct_from` is treated as symmetric for identity and
deduplication. Directional relations such as `depends_on`, `derived_from`,
`example_of`, and `part_of` retain their direction.

## Scaling and propagation

After a confirmed origin update enters the existing bounded propagation queue,
the coordinator inspects only conflicts touching the directly affected concept
IDs. Diagnostic persistence is fail-open: it cannot roll back valid
user-authoritative meaning or block safe independent propagation. Conflict
detection grants no new write or propagation authority.

The v0 milestone does not perform fuzzy inference, global ontology reasoning,
automatic resolution, concept merging, contextual relation logic, or ordinary
language ambiguity inference.
