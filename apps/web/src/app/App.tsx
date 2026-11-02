import type { BotId, BotSummary } from "@aobot/domain";
import { type Array, Option } from "effect";
import { Sidebar, useBots } from "../features/bots/public.ts";
import { ConversationView, useConversation } from "../features/chat/public.ts";
import { LiveScreen } from "../features/screen/public.ts";
import "./app.css";
import { botLink, type Selection } from "./selection.ts";
import { useSelection } from "./use-selection.ts";

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
      <Sidebar
        bots={props.bots}
        selected={props.selection.bot}
        linkTo={linkTo}
        onPick={props.pick}
      />
      <Workspace selection={props.selection} />
    </div>
  );
}

/** The page: the messenger once the server has said which Bots there are. */
export function App() {
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
