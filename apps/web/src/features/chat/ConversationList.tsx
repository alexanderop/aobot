import type { BotSummary, ConversationId, ConversationSummary } from "@aobot/domain";
import { Option } from "effect";
import { useId } from "react";
import { isPlainClick } from "../../shared/plain-click.ts";
import { BotAvatar } from "../bots/public.ts";
import "./conversation-list.css";
import { useConversationList } from "./use-conversation.ts";

/**
The person's conversations under a heading, the one written to last first: each with its Bot, the start
of its last message and a dot while the Bot has written since the person last had it open. New starts a
conversation with the Bot open beside it.
*/
export function ConversationList(props: {
  readonly bots: ReadonlyArray<BotSummary>;
  readonly selected: ConversationId;
  readonly selectedBot: BotSummary;
  /** Where a conversation's link leads, for a click that opens it elsewhere. */
  readonly linkTo: (conversation: ConversationSummary) => string;
  readonly onOpen: (conversation: ConversationSummary) => void;
  readonly onNew: () => void;
}) {
  const heading = useId();
  const list = useConversationList();

  const nameOf = (conversation: ConversationSummary) =>
    props.bots.find((bot) => bot.id === conversation.botId)?.name ?? conversation.botId;

  return (
    <div className="conversation-list" role="group" aria-labelledby={heading}>
      <div className="conversation-list__head">
        <h2 id={heading} className="conversation-list__heading">
          Conversations
        </h2>
        <button
          type="button"
          className="conversation-list__new"
          aria-label={`New conversation with ${props.selectedBot.name}`}
          onClick={props.onNew}
        >
          New
        </button>
      </div>
      {Option.match(list, {
        onNone: () => null,
        onSome: (conversations) =>
          conversations.length === 0 ? (
            <p className="conversation-list__empty">No conversations yet.</p>
          ) : (
            <ul className="conversation-list__rows">
              {conversations.map((conversation) => (
                <li key={conversation.conversationId}>
                  <a
                    href={props.linkTo(conversation)}
                    className="conversation-list__row"
                    aria-current={
                      conversation.conversationId === props.selected ? "page" : undefined
                    }
                    data-unread={conversation.unread}
                    onClick={(event) => {
                      if (!isPlainClick(event)) return;

                      event.preventDefault();
                      props.onOpen(conversation);
                    }}
                  >
                    <BotAvatar bot={conversation.botId} size={32} />
                    <span className="conversation-list__label">
                      <span className="conversation-list__name">{nameOf(conversation)}</span>
                      <span className="conversation-list__preview">{conversation.preview}</span>
                    </span>
                    {conversation.unread ? (
                      <span className="conversation-list__unread" aria-label="Unread" />
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
          ),
      })}
    </div>
  );
}
