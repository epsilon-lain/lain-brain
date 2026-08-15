# Semantic Delta and Background Propagation v0

Semantic Delta v0 lets a user confirm one important change to their own
concept model, then lets Lain Brain perform a narrow class of deterministic,
non-authoritative maintenance in the background. The user reviews causes and
personal decisions; the system handles mechanical consequences. Uncertain
consequences remain pending rather than being guessed.

## Domain model

`ProposedSemanticDelta` describes the principal semantic difference between
two consecutive revisions of one `ConceptNode`. The current kinds are limited
to personal-definition creation or redefinition, ambiguity resolution, alias
changes, and relationship changes. Its authority is always `proposed`.

`ConfirmedSemanticDelta` is created only by `confirmSemanticDelta()` with an
explicit confirmation marker, confirmation ID, interaction reference, exact
user evidence, and confirmation timestamp. It retains the stable delta ID,
source concept and revisions, old and new values, reason, and provenance. Its
authority is `user_confirmed`, but only for the exact payload confirmed.
Proposal confidence never grants authority.

`PropagationPlan` is a pure, deterministic, read-only result. It records the
source delta, affected concepts, why each concept was selected, permitted
automatic operations, pending decisions, skipped concepts, visited IDs,
limits, and truncation. Planning performs no Vault writes.

`PendingSemanticDecision` records an unresolved consequence with a stable ID,
originating delta, affected concepts, evidence, candidate actions, revision
context, and one of `pending`, `resolved`, `dismissed`, or `superseded`.

`SemanticDeltaState` is versioned plugin state containing confirmed deltas,
propagation jobs, pending decisions, and structured reports. This avoids
adding event files to the Vault while keeping the JSON state inspectable. A
future schema change must add an explicit migration rather than guessing.

## Proposal and confirmation boundary

The current maintenance workspace computes at most one principal proposal from
the already-reviewed old and prepared concept revisions. Preview and Cancel do
not persist a delta or write a concept. `Confirm Update` is the explicit user
action that confirms the proposed delta.

The durable delta and its `awaiting_origin_write` job are saved before the
origin concept is written. If that save fails, the concept is not written. The
origin write still uses the existing exact Markdown, stable-ID, and expected-
revision checks. Only after that succeeds is propagation queued.

The domain API is suitable for a later chat proposal surface, but normal chat
does not currently propose, confirm, persist, or propagate deltas.

## Dependency discovery

Planning uses only explicit structure:

- relationships whose stable target concept ID is the changed concept;
- generated interpretations with an explicit concept/revision dependency or
  exact `concept:<id>` source reference;
- unresolved relationship alternatives that exactly identify the stable ID or
  exact current label.

Same titles alone are not dependencies. There is no embedding search, fuzzy
semantic lookup, lexical similarity scan, or autonomous belief inference.
Traversal is breadth-first and deterministic, tracks visited stable IDs, and
is bounded by depth and concept count.

## Propagation authorization

Confirmation grants a narrow allow-list:

- refresh a cached relationship display label while preserving its target ID;
- mark an explicitly dependent generated interpretation stale;
- refresh that generated entry's dependency revision;
- create pending decisions;
- record propagation provenance.

It does **not** authorize changing another concept's personal definition,
resolving its ambiguity, merging concepts, deleting user evidence, promoting
AI or external text to user meaning, or inventing new beliefs. Lower-authority
derived data may react mechanically to a confirmed user change; authority may
not amplify across the graph.

## Multi-wave behavior

The bounded planner can discover `A -> B -> C` across explicit adjacency.
Derived maintenance in B remains mechanical metadata and never becomes a new
user-authoritative fact. If C would require a change to personal meaning, the
wave records a pending decision instead. Cycles terminate through the visited
ID set, and no-op operations create no revision.

## Background queue

`SemanticPropagationCoordinator` owns an explicit queue independent of chat
and semantic-shadow queues. Defaults are:

- maximum traversal depth: 2;
- maximum affected concepts: 50;
- maximum Vault writes per job: 25.

Jobs move through `awaiting_origin_write`, `queued`, `planning`, `propagating`,
and a terminal status of `completed`, `completed_with_pending_decisions`, or
`failed`. There is no recursive asynchronous cascade and no per-node modal or
notification.

On plugin reload, jobs interrupted while awaiting the origin-state transition,
planning, or propagating are conservatively re-queued. Before any downstream
work, the coordinator reloads the index and verifies that exactly one source
concept exists at the delta's resulting revision. A crash before the origin
write therefore fails safely instead of propagating an uncommitted delta.

## Idempotency, concurrency, and Vault safety

Delta IDs are deterministic over semantic identity rather than timestamps.
Recording the same confirmed delta twice creates one job. Replanning an
already-applied label refresh or stale marker yields a no-op, so replay does
not create duplicate revisions.

Before each background write, the coordinator reloads the exact concept note
and verifies stable concept ID, expected revision, and exact original Markdown.
It then uses the existing `persistConfirmedConceptUpdate()` boundary and
Obsidian Vault API. A newer user edit is never overwritten; the operation is
skipped and becomes a pending decision. A failed write leaves the prior file
unchanged and is recorded in the propagation report.

Planning and proposals write nothing. Confirmed origin writes remain direct
reviewed writes. Background writes are limited to the authorized derived
fields above. Pending-decision status changes are plugin-state updates, not
concept-content rewrites.

## History and reversibility foundation

Every propagated concept revision records
`Mechanical propagation from SemanticDelta <id>` in its immutable history.
The propagation report records affected, applied, skipped, pending, failed,
and truncated work. Together with the delta's confirmation provenance and
previous concept snapshots, this answers why a change happened and identifies
the revisions required for a future compensating-update workflow. v0 does not
perform destructive rollback.

## Pending decision inbox

The domain supports listing unresolved decisions globally or by affected
concept, and explicitly resolving, dismissing, or superseding them. The Concept
Maintenance Workspace shows pending decisions for the open concept and offers
small explicit Resolve and Dismiss actions. It never opens one modal per
propagation consequence.

## Diagnostics

Read-only diagnostics report orphan deltas, incomplete or failed propagation,
and concept history that references an unknown delta. Diagnostics never repair
or write data automatically.

## Scaling model and current limits

User review effort should scale with meaningful semantic decisions and
unresolved ambiguity, not with the raw number of mechanically affected nodes.

v0 intentionally does not include chat-first proposal UI, LLM-based delta
detection, regeneration of stale AI prose, automatic changes to downstream
personal meaning, semantic merging, automatic rollback, notifications,
embeddings, a database, or distributed transactions. Plugin state migration is
conservative: malformed or future-version Semantic Delta state is ignored
rather than inferred.
