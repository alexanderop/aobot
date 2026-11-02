import type { BotId } from "@aobot/domain";
import type { ToolCall } from "./conversation-state.ts";
import { useToolCallRenderer } from "./use-tool-call-renderer.tsx";

/** One tool call of `bot` in the transcript: a grey card on the Bot's side, drawn by the tool's renderer. */
export function ToolCallCard(props: { readonly call: ToolCall; readonly bot: BotId }) {
  const Renderer = useToolCallRenderer()(props.call.name);

  return (
    <div
      className="tool-call"
      data-tool={props.call.name}
      data-status={props.call.status._tag.toLowerCase()}
    >
      <Renderer call={props.call} bot={props.bot} />
    </div>
  );
}
