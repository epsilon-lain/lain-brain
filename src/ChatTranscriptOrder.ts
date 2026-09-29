import type { LainBrainTranscriptMessage } from "./LainBrainSession";
import type { ChatSpaceSegment } from "./ChatSpace";

export type ChatTranscriptOrderItem =
  | { readonly kind: "message"; readonly message: LainBrainTranscriptMessage }
  | { readonly kind: "thinking" }
  | { readonly kind: "chat_space"; readonly segments: readonly ChatSpaceSegment[] }
  | { readonly kind: "candidate_loading" };

export function buildChatTranscriptOrder(
  messages: readonly LainBrainTranscriptMessage[],
  chatSpaceSegments: readonly ChatSpaceSegment[],
  loadingMode: "chat" | null,
  candidateLoading: boolean
): ChatTranscriptOrderItem[] {
  const items: ChatTranscriptOrderItem[] = messages.map((message) => ({
    kind: "message",
    message
  }));
  if (loadingMode === "chat") {
    items.push({ kind: "thinking" });
  }
  if (chatSpaceSegments.length > 0) {
    items.push({ kind: "chat_space", segments: chatSpaceSegments });
  }
  if (candidateLoading) {
    items.push({ kind: "candidate_loading" });
  }
  return items;
}
