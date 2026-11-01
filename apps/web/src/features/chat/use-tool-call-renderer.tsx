import { Option, Schema } from "effect";
import type { ReactNode } from "react";
import { ToolCallStatus } from "./conversation-state.ts";
import type { ToolCall } from "./conversation-state.ts";

/** Draws one tool call in each of its states. */
export type ToolCallRenderer = (props: { readonly call: ToolCall }) => ReactNode;

const decodeNavigateArgs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
);

function Result(props: { readonly summary: string; readonly text: string }) {
  return (
    <details className="tool-call__details">
      <summary className="tool-call__summary">{props.summary}</summary>
      <pre className="tool-call__result">{props.text}</pre>
    </details>
  );
}

function NavigateCall({ call }: { readonly call: ToolCall }) {
  const url = Option.match(decodeNavigateArgs(call.args), {
    onNone: () => "a page",
    onSome: (args) => args.url,
  });

  return (
    <p className="tool-call__title">
      {ToolCallStatus.$match(call.status, {
        Running: () => `Opening ${url}…`,
        Done: () => `Opened ${url}`,
        Unfinished: () => `Did not finish opening ${url}`,
      })}
    </p>
  );
}

function SnapshotCall({ call }: { readonly call: ToolCall }) {
  return ToolCallStatus.$match(call.status, {
    Running: () => <p className="tool-call__title">Reading the page…</p>,
    Done: ({ result }) => (
      <>
        <p className="tool-call__title">Read the page</p>
        <Result summary="What it read" text={result} />
      </>
    ),
    Unfinished: () => <p className="tool-call__title">Did not finish reading the page</p>,
  });
}

function DefaultCall({ call }: { readonly call: ToolCall }) {
  return (
    <>
      <p className="tool-call__title">
        {ToolCallStatus.$match(call.status, {
          Running: () => `Running ${call.name}…`,
          Done: () => `Ran ${call.name}`,
          Unfinished: () => `Did not finish ${call.name}`,
        })}
      </p>
      {call.args === "" || call.args === "{}" ? null : (
        <code className="tool-call__args">{call.args}</code>
      )}
      {ToolCallStatus.$is("Done")(call.status) ? (
        <Result summary="Result" text={call.status.result} />
      ) : null}
    </>
  );
}

/** The gateway tools the transcript knows how to draw. Any other tool gets {@link DefaultCall}. */
const renderers: ReadonlyMap<string, ToolCallRenderer> = new Map([
  ["navigate", NavigateCall],
  ["snapshot", SnapshotCall],
]);

function rendererFor(name: string): ToolCallRenderer {
  return renderers.get(name) ?? DefaultCall;
}

/** The registry from tool name to the component that draws it, shaped like CopilotKit's `useRenderToolCall`. */
export function useToolCallRenderer(): (name: string) => ToolCallRenderer {
  return rendererFor;
}
