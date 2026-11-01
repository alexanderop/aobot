import type { ConversationId } from "@aobot/domain";
import { ConversationView, useConversation } from "../features/chat/public.ts";
import { LiveScreen } from "../features/screen/public.ts";
import "./app.css";

/** One conversation, with the Bot's screen beside it. Its id lives in the URL so a reload reopens it. */
export function App(props: { readonly conversationId: ConversationId }) {
  const { showsScreen } = useConversation(props.conversationId);

  return (
    <div className="workspace">
      <ConversationView conversationId={props.conversationId} />
      <LiveScreen open={showsScreen} />
    </div>
  );
}
