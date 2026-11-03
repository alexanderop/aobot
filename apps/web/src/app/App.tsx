import { type BotId, type BotSummary, SessionState } from "@aobot/domain";
import { type Array, Option } from "effect";
import { AuditPage } from "../features/audit/public.ts";
import { Sidebar, useBots } from "../features/bots/public.ts";
import { ConversationView, useConversation } from "../features/chat/public.ts";
import { LiveScreen } from "../features/screen/public.ts";
import { PersonBar, SignInScreen, useSession } from "../features/session/public.ts";
import "./app.css";
import { botLink, type Selection } from "./selection.ts";
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

/** The sidebar of Bots and the conversation with the one picked, which the URL keeps across reloads. */
function Messenger(props: {
  readonly session: SessionState;
  readonly bots: Array.NonEmptyReadonlyArray<BotSummary>;
  readonly selection: Selection;
  readonly pick: (bot: BotId) => void;
}) {
  return (
    <div className="app">
      <div className="app__side">
        <Sidebar
          bots={props.bots}
          selected={props.selection.bot}
          linkTo={linkTo}
          onPick={props.pick}
        />
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
function Chat(props: { readonly session: SessionState }) {
  const bots = useBots();
  const [selection, pick] = useSelection();

  return Option.match(Option.all({ bots, selection }), {
    onNone: Connecting,
    onSome: (ready) => <Messenger {...ready} session={props.session} pick={pick} />,
  });
}

/** The audit page, naming each Bot as `bots.yaml` does once the server has said. */
function Audit() {
  const bots = useBots();

  return <AuditPage bots={Option.getOrElse(bots, () => [])} />;
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
        <SignInScreen />
      ) : window.location.pathname === auditPath ? (
        <Audit />
      ) : (
        <Chat session={session} />
      ),
  });
}
