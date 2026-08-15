# Chat-First Semantic Delta v1

Chat-first Semantic Delta lets ordinary conversation remain ordinary while
quietly detecting at most one possible durable change to the user's personal
concept model. Detection is supplemental and non-authoritative:

```text
normal conversation
  -> optional bounded semantic analysis
  -> optional principal-change proposal
  -> explicit user review and confirmation
  -> confirmed SemanticDelta
  -> checked origin ConceptNode update
  -> existing background propagation coordinator
```

Most messages produce no proposal. A question, joke, emotion, tentative
analogy, or assistant-authored explanation is not durable user structure.
Version 1 supports five typed proposal categories:

- personal-definition creation or redefinition;
- a confirmed typed relationship (`depends_on`, `example_of`, `derived_from`,
  `analogous_to`, `related_to`, or `part_of`);
- removal of one exactly matching typed relationship;
- a first-class `explicitly_distinct_from` relation;
- resolution of one existing meaning or interpretation ambiguity.

Core-emphasis changes remain unsupported because the current model has no
narrow representation for them. Unsupported model categories are rejected,
not coerced into a nearby type.

## Privacy and control

The feature is controlled by **Detect semantic changes in chat** in Lain Brain
settings and can be disabled at any time. When enabled, after a successful
normal text-chat answer it may make one additional request to the already
configured DeepSeek provider.

That request contains no more than the three most recent eligible text-only
turns (six ordered user/assistant messages). It does not include API keys,
attachments, images, PDF contents, active-note contents, whole-Vault contents,
unrelated notes, hidden metadata, or the local concept index. Image and PDF
turns are ineligible. If the setting is disabled or no DeepSeek key is
configured, no semantic-change request is scheduled.

Concept lookup happens locally only after validated analysis identifies a
concise label. No additional external provider, analytics service, or semantic
database is used.

## Authority and evidence

Model output is parsed as strict JSON and remains a proposal. Confidence is
proposal metadata only. It never creates authority. Each proposal must point
to exact user-authored message text using existing KnowledgeProtocol
provenance; assistant text cannot become user evidence.

The proposal card adapts to the category and shows source and target concepts,
the exact relation or ambiguity, reviewed wording, reason, and exact evidence.
The user can resolve an ambiguous participant and correct a supported relation
type before confirmation. Opening, ignoring, editing, selecting, or rejecting
the card performs no Vault write and creates no SemanticDelta. Edited text is
recorded as new explicit `user_edit` provenance rather than being attributed
to an earlier message.

Only **Confirm** crosses the authority boundary. It revalidates the stable
concept IDs and expected revisions, persists the confirmed delta, performs the
existing exact checked source-ConceptNode write, and then hands the delta to
the existing propagation coordinator. A missing structural participant may be
created only inside this confirmed operation. If a later step fails, only a
file created by that same operation is moved to Obsidian Trash as rollback;
pre-existing notes are never rollback targets. The source concept is the
deterministic origin, including for distinctions, so the event is not duplicated
onto both nodes.

Confirmation authorizes only the displayed structural change. It cannot merge
concepts, rewrite either personal definition, create inferred relationships,
or resolve unrelated ambiguity. Relationship removal deletes only the exact
relation-type and stable-target-ID match; immutable revision history preserves
the prior edge. Ambiguity resolution closes only one exact existing unresolved
meaning/conflict item and records the selected stable concept identity.

## Identity, ambiguity, and lifecycle

Known concepts resolve through the existing read-only ConceptIndex. Stable IDs
win over titles and aliases. Ambiguous title/alias matches require a user
selection; no arbitrary match or merge is allowed. A missing concept is shown
as a reviewed new-concept proposal and is never created before confirmation.

Structural proposal fingerprints include category, both participant
identities/revisions, relation type or distinction wording, and source message
IDs. Confirmed, rejected, superseded, and expired proposals do not immediately
reappear without materially new evidence. Moving
the conversation on expires the active proposal, so an unrelated later
"yes" cannot confirm stale meaning. A bare confirmation is accepted only for
one active, unambiguous proposal.

## Principal selection and propagation boundary

The analyzer returns at most one principal change. Explicit corrections of an
assistant misunderstanding rank above casual observations; genuinely competing
changes return ambiguity rather than multiple cards. Exact user evidence is
mandatory. Assistant prose, self-deprecating framing, and unrelated nearby
text cannot become user authority.

A semantic relationship is not automatically a propagation dependency. The
existing propagation planner recognizes only its existing narrow dependency
relations (`depends_on`, `derived_from`, and `defined_by`). An analogy,
distinction, example, or generic relation does not become a causal edge.
Automatic propagation permissions remain unchanged and cannot rewrite a
downstream personal definition; unsafe consequences remain pending decisions.

## Responsiveness and failure isolation

The normal assistant response is produced first. Semantic-change analysis runs
on a separate serialized, fire-and-forget queue and never blocks foreground
chat. Parsing, analysis, and local concept-discovery failures are fail-open:
the normal answer remains visible and no Brain mutation occurs. Confirmation
write failures are reported in the proposal card and do not enqueue
propagation after a failed origin write.

## Current limitations

- Only one principal change can be proposed per completed text turn.
- Core-emphasis annotations are deliberately deferred.
- Relation selection is limited to the supported typed vocabulary; arbitrary
  ontologies and automatic concept merging are out of scope.
- There is no persisted "Not now" state; the lightweight actions are Confirm,
  Edit, and Not a change.
- Proposals are session-local. Confirmed deltas and ConceptNode revisions use
  the existing durable persistence architecture.
