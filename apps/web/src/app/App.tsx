import { type BotId, type BotSummary, type ConversationSummary, SessionState } from "@aobot/domain";
import { type Array, Option } from "effect";
import { useEffect } from "react";
import { AuditPage } from "../features/audit/public.ts";
import { Sidebar, useBots } from "../features/bots/public.ts";
import { ConversationList, ConversationView, useConversation } from "../features/chat/public.ts";
import { LiveScreen } from "../features/screen/public.ts";
import {
  type OpenSession,
  PersonBar,
  SignInScreen,
  useSession,
} from "../features/session/public.ts";
import "./app.css";
import { forgetPageMemory } from "./selection-atoms.ts";
import { botLink, Choice, type Selection, withSelection } from "./selection.ts";
import { useSelection } from "./use-selection.ts";

/** Where the audit page is. Every other path is the messenger. */
const auditPath = "/audit";

/** One conversation, with the Bots' shared screen beside it. */
function Workspace(props: { readonly selection: Selection }) {
  const { selection } = props;
  const { usesComputer } = useConversation(selection.conversation, selection.bot);

  return (
    <div className="workspace">
      <ConversationView
        key={selection.conversation}
        conversationId={selection.conversation}
        botId={selection.bot}
      />
      <LiveScreen usesComputer={usesComputer} />
    </div>
  );
}

/** A link to `bot`, so it can be opened in another tab or copied. */
function linkTo(bot: BotId): string {
  return botLink(new URL(window.location.href), bot).href;
}

/** `conversation` as the selection that opens it. */
function selectionOf(conversation: ConversationSummary): Selection {
  return { bot: conversation.botId, conversation: conversation.conversationId };
}

/** A link to `conversation`, so it can be opened in another tab or copied. */
function conversationLink(conversation: ConversationSummary): string {
  return withSelection(new URL(window.location.href), selectionOf(conversation)).href;
}

/**
The sidebar of Bots and the person's conversations, and the conversation open beside it, which the URL
keeps across reloads.
*/
function Messenger(props: {
  readonly session: OpenSession;
  readonly bots: Array.NonEmptyReadonlyArray<BotSummary>;
  readonly selection: Selection;
  readonly choose: (choice: Choice) => void;
}) {
  const { bots, selection, choose } = props;
  const selectedBot = bots.find((bot) => bot.id === selection.bot) ?? bots[0];

  return (
    <div className="app">
      <div className="app__side">
        <Sidebar
          bots={bots}
          selected={selection.bot}
          linkTo={linkTo}
          onPick={(bot) => choose(Choice.Bot({ bot }))}
        >
          <ConversationList
            bots={bots}
            selected={selection.conversation}
            selectedBot={selectedBot}
            linkTo={conversationLink}
            onOpen={(conversation) =>
              choose(Choice.Conversation({ selection: selectionOf(conversation) }))
            }
            onNew={() => choose(Choice.New({ bot: selection.bot }))}
          />
        </Sidebar>
        <a className="app__audit-link" href={auditPath}>
          Audit trail
        </a>
        <PersonBar session={props.session} />
      </div>
      <Workspace selection={props.selection} />
    </div>
  );
}

/** What the page shows until the server has said what it needs. */
function Connecting() {
  return (
    <p className="app__connecting" role="status">
      Connecting…
    </p>
  );
}

/** The messenger once the server has said which Bots there are. */
function Chat(props: { readonly session: OpenSession }) {
  const bots = useBots();
  const [selection, choose] = useSelection();

  return Option.match(Option.all({ bots, selection }), {
    onNone: Connecting,
    onSome: (ready) => <Messenger {...ready} session={props.session} choose={choose} />,
  });
}

/** The audit page, naming each Bot as `bots.yaml` does once the server has said. */
function Audit() {
  const bots = useBots();

  return <AuditPage bots={Option.getOrElse(bots, () => [])} />;
}

/**
The sign-in screen, which forgets the conversations open on this browser: after a sign-out, an expired
session or a removal, the next person to sign in here may be someone else.
*/
function SignedOut() {
  useEffect(forgetPageMemory, []);

  return <SignInScreen />;
}

/**
The page: the audit trail at `/audit`, the messenger everywhere else, once someone is signed in. Nothing
that opens an RPC socket mounts before the server said who the page is open for, so a signed-out page
never knocks on a socket it would be refused.
*/
export function App() {
  return Option.match(useSession(), {
    onNone: Connecting,
    onSome: (session) =>
      SessionState.guards.SignedOut(session) ? (
        <SignedOut />
      ) : window.location.pathname === auditPath ? (
        <Audit />
      ) : (
        <Chat session={session} />
      ),
  });
}
