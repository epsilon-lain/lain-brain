import { requestDeepSeek } from "./DeepSeekClient";
import {
  parseChatSemanticDeltaAnalysisJson,
  type ChatSemanticDeltaAnalyzer
} from "./ChatSemanticDelta";

export function createChatSemanticDeltaAnalysisSystemPrompt(): string {
  return [
    "You detect at most one principal durable semantic change in a bounded Lain Brain conversation.",
    "Most conversations contain no such change. Prefer no_meaningful_change when uncertain.",
    "Do not summarize the conversation. Do not infer private beliefs beyond explicit user evidence.",
    "Questions, jokes, emotions, excitement, self-deprecation, tentative analogies, and assistant-only wording are not durable user structure by themselves.",
    "A strong candidate is an explicit user redefinition, correction, durable typed relationship, relationship removal, concept distinction, or resolution of an existing ambiguity.",
    "Structural relations matter, but topical co-occurrence never establishes a relation. Preserve direction and the exact relation type.",
    "analogous_to is not equivalence; depends_on is not a subtype relation; example_of is not identity.",
    "An explicit correction of the assistant ranks above a nearby casual observation. Emotional or self-deprecating wrappers do not erase an explicit semantic core.",
    "Return at most one change. If two materially comparable changes exist, return ambiguous_change.",
    "Supported changeKind values are personal_definition, relationship_confirmed, relationship_removed, concept_distinction, and ambiguity_resolved. Unknown categories must return no_meaningful_change or ambiguous_change.",
    "Allowed relationType values are depends_on, example_of, derived_from, analogous_to, related_to, and part_of.",
    "Same labels do not imply the same concept. Never propose a concept merge.",
    "Never claim confirmation. Never use assistant text as user evidence.",
    "Evidence quotes must be exact substrings of the referenced user messages.",
    "Return strict JSON only, with one of these shapes:",
    '{"outcome":"no_meaningful_change"}',
    '{"outcome":"ambiguous_change","reason":"short reason"}',
    '{"outcome":"possible_principal_change","changeKind":"personal_definition","conceptQuery":"concise concept label","proposedMeaning":"concise proposed meaning","reason":"why this is principal","confidence":0.0,"explicitness":"explicit","tentative":false,"evidence":[{"messageId":"message-id","quote":"exact user quote"}]}',
    '{"outcome":"possible_principal_change","changeKind":"relationship_confirmed","sourceConceptQuery":"A","targetConceptQuery":"B","relationType":"depends_on","reason":"why this is principal","confidence":0.0,"explicitness":"explicit","tentative":false,"evidence":[{"messageId":"message-id","quote":"exact user quote"}]}',
    '{"outcome":"possible_principal_change","changeKind":"relationship_removed","sourceConceptQuery":"A","targetConceptQuery":"B","relationType":"depends_on","reason":"why this is principal","confidence":0.0,"explicitness":"explicit","tentative":false,"evidence":[{"messageId":"message-id","quote":"exact user quote"}]}',
    '{"outcome":"possible_principal_change","changeKind":"concept_distinction","sourceConceptQuery":"A","targetConceptQuery":"B","distinctionText":"concise distinction","reason":"why this correction is principal","confidence":0.0,"explicitness":"explicit","tentative":false,"evidence":[{"messageId":"message-id","quote":"exact user quote"}]}',
    '{"outcome":"possible_principal_change","changeKind":"ambiguity_resolved","sourceConceptQuery":"concept containing the ambiguity","selectedConceptQuery":"selected concept","ambiguityLabel":"original ambiguous label","reason":"why this is principal","confidence":0.0,"explicitness":"explicit","tentative":false,"evidence":[{"messageId":"message-id","quote":"exact user quote"}]}',
    "Confidence is proposal-only and never grants authority."
  ].join("\n");
}

export const analyzeChatSemanticDelta: ChatSemanticDeltaAnalyzer = async (
  apiKey,
  request
) => {
  const transcript = request.conversation.map((message) =>
    `[${message.id}] ${message.role}> ${message.content}`
  ).join("\n\n");
  const raw = await requestDeepSeek(apiKey, [
    { role: "system", content: createChatSemanticDeltaAnalysisSystemPrompt() },
    {
      role: "user",
      content: [
        `Current user message ID: ${request.currentUserMessageId}`,
        "Bounded recent conversation:",
        transcript
      ].join("\n\n")
    }
  ]);
  return parseChatSemanticDeltaAnalysisJson(raw, request);
};
