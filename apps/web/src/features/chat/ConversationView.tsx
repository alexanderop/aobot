import type { ConversationId } from "@aobot/domain";
import { ConversationPanel } from "./ConversationPanel.tsx";
import { useConversation } from "./use-conversation.ts";

/** One conversation with a Bot, read live from its atoms. */
export function ConversationView(props: { readonly conversationId: ConversationId }) {
  return <ConversationPanel conversation={useConversation(props.conversationId)} />;
}
