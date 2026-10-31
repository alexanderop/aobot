import type { ConversationId } from "@aobot/domain";
import { ConversationView } from "../features/chat/public.ts";

/** The E0-1 page: one conversation. Its id lives in the URL so a reload reopens it. */
export function App(props: { readonly conversationId: ConversationId }) {
  return <ConversationView conversationId={props.conversationId} />;
}
