import type { BotId, BotSummary } from "@aobot/domain";
import { type Array, Option } from "effect";
import { AuditPage } from "../features/audit/public.ts";
import { Sidebar, useBots } from "../features/bots/public.ts";
import { ConversationView, useConversation } from "../features/chat/public.ts";
import { LiveScreen } from "../features/screen/public.ts";
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
      </div>
      <Workspace selection={props.selection} />
    </div>
  );
}

/** The messenger once the server has said which Bots there are. */
function Chat() {
  const bots = useBots();
  const [selection, pick] = useSelection();

  return Option.match(Option.all({ bots, selection }), {
    onNone: () => (
      <p className="app__connecting" role="status">
        Connecting…
      </p>
    ),
    onSome: (ready) => <Messenger {...ready} pick={pick} />,
  });
}

/** The audit page, naming each Bot as `bots.yaml` does once the server has said. */
function Audit() {
  const bots = useBots();

  return <AuditPage bots={Option.getOrElse(bots, () => [])} />;
}

/** The page: the audit trail at `/audit`, the messenger everywhere else. */
export function App() {
  return window.location.pathname === auditPath ? <Audit /> : <Chat />;
}
