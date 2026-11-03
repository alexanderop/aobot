import type { BotId, BotSummary, ConversationId, ConversationSummary } from "@aobot/domain";
import { Option } from "effect";
import { useId } from "react";
import { isPlainClick } from "../../shared/plain-click.ts";
import "../../shared/side-list.css";
import { BotAvatar } from "../bots/public.ts";
import "./conversation-list.css";
import { useConversationList } from "./use-conversation.ts";

/**
The person's conversations under a heading, the one written to last first: each with its Bot, the start
of its last message and a dot while the Bot has written since the person last had it open. New starts a
conversation with `newWith`, the Bot open beside it.
*/
export function ConversationList(props: {
  readonly bots: ReadonlyArray<BotSummary>;
  readonly selected: ConversationId;
  readonly newWith: BotId;
  /** Where a conversation's link leads, for a click that opens it elsewhere. */
  readonly linkTo: (conversation: ConversationSummary) => string;
  readonly onOpen: (conversation: ConversationSummary) => void;
  readonly onNew: () => void;
}) {
  const heading = useId();
  const list = useConversationList();

  const nameOf = (bot: BotId) => props.bots.find(({ id }) => id === bot)?.name ?? bot;

  return (
    <nav className="conversation-list" aria-labelledby={heading}>
      <div className="conversation-list__head">
        <h2 id={heading} className="side-heading">
          Conversations
        </h2>
        <button
          type="button"
          className="conversation-list__new"
          aria-label={`New conversation with ${nameOf(props.newWith)}`}
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
            <ul className="side-list">
              {conversations.map((conversation) => (
                <li key={conversation.conversationId}>
                  <a
                    href={props.linkTo(conversation)}
                    className="side-row"
                    aria-current={
                      conversation.conversationId === props.selected ? "page" : undefined
                    }
                    onClick={(event) => {
                      if (!isPlainClick(event)) return;

                      event.preventDefault();
                      props.onOpen(conversation);
                    }}
                  >
                    <BotAvatar bot={conversation.botId} size={32} />
                    <span className="side-row__label">
                      <span className="side-row__text">{nameOf(conversation.botId)}</span>
                      <span className="side-row__text conversation-list__preview">
                        {conversation.preview}
                      </span>
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
    </nav>
  );
}
