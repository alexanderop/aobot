import { Option, Schema } from "effect";
import type { ReactNode } from "react";
import { ToolCallStatus } from "./conversation-state.ts";
import type { ToolCall } from "./conversation-state.ts";

/** Draws one tool call in each of its states. */
export type ToolCallRenderer = (props: { readonly call: ToolCall }) => ReactNode;

const decodeNavigateArgs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
);

const decodeRefArgs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ ref: Schema.String })),
);

const decodeRunArgs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ command: Schema.String })),
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
        Failed: () => `Could not open ${url}`,
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
    Failed: () => <p className="tool-call__title">Could not read the page</p>,
    Unfinished: () => <p className="tool-call__title">Did not finish reading the page</p>,
  });
}

/** What a click or type card says in each state, given the element's ref. */
interface ActionWords {
  readonly running: (ref: string) => string;
  readonly done: (ref: string) => string;
  readonly failed: (ref: string) => string;
  readonly unfinished: (ref: string) => string;
}

/** A call that acts on one element by its ref: what it did, then the page it answered with, or why not. */
function refCall(words: ActionWords): ToolCallRenderer {
  return function RefCall({ call }) {
    const ref = Option.match(decodeRefArgs(call.args), {
      onNone: () => "an element",
      onSome: (args) => args.ref,
    });

    return ToolCallStatus.$match(call.status, {
      Running: () => <p className="tool-call__title">{words.running(ref)}</p>,
      Done: ({ result }) => (
        <>
          <p className="tool-call__title">{words.done(ref)}</p>
          <Result summary="The page after" text={result} />
        </>
      ),
      Failed: ({ result }) => (
        <>
          <p className="tool-call__title">{words.failed(ref)}</p>
          <Result summary="Why" text={result} />
        </>
      ),
      Unfinished: () => <p className="tool-call__title">{words.unfinished(ref)}</p>,
    });
  };
}

const ClickCall = refCall({
  running: (ref) => `Clicking ${ref}…`,
  done: (ref) => `Clicked ${ref}`,
  failed: (ref) => `Could not click ${ref}`,
  unfinished: (ref) => `Did not finish clicking ${ref}`,
});

const TypeCall = refCall({
  running: (ref) => `Typing into ${ref}…`,
  done: (ref) => `Typed into ${ref}`,
  failed: (ref) => `Could not type into ${ref}`,
  unfinished: (ref) => `Did not finish typing into ${ref}`,
});

/** A shell command: what ran, then how it ended and what it printed, or why it did not run. */
function RunCall({ call }: { readonly call: ToolCall }) {
  const command = Option.match(decodeRunArgs(call.args), {
    onNone: () => null,
    onSome: (args) => <code className="tool-call__args">{args.command}</code>,
  });

  return ToolCallStatus.$match(call.status, {
    Running: () => (
      <>
        <p className="tool-call__title">Running a command…</p>
        {command}
      </>
    ),
    Done: ({ result }) => (
      <>
        <p className="tool-call__title">Ran a command</p>
        {command}
        <Result summary="What it printed" text={result} />
      </>
    ),
    Failed: ({ result }) => (
      <>
        <p className="tool-call__title">Could not run a command</p>
        {command}
        <Result summary="Why" text={result} />
      </>
    ),
    Unfinished: () => (
      <>
        <p className="tool-call__title">Did not finish a command</p>
        {command}
      </>
    ),
  });
}

function DefaultCall({ call }: { readonly call: ToolCall }) {
  return (
    <>
      <p className="tool-call__title">
        {ToolCallStatus.$match(call.status, {
          Running: () => `Running ${call.name}…`,
          Done: () => `Ran ${call.name}`,
          Failed: () => `${call.name} failed`,
          Unfinished: () => `Did not finish ${call.name}`,
        })}
      </p>
      {call.args === "" || call.args === "{}" ? null : (
        <code className="tool-call__args">{call.args}</code>
      )}
      {ToolCallStatus.$match(call.status, {
        Done: ({ result }) => <Result summary="Result" text={result} />,
        Failed: ({ result }) => <Result summary="Why" text={result} />,
        Running: () => null,
        Unfinished: () => null,
      })}
    </>
  );
}

/** The gateway tools the transcript knows how to draw. Any other tool gets {@link DefaultCall}. */
const renderers: ReadonlyMap<string, ToolCallRenderer> = new Map([
  ["navigate", NavigateCall],
  ["snapshot", SnapshotCall],
  ["click", ClickCall],
  ["type", TypeCall],
  ["run", RunCall],
]);

function rendererFor(name: string): ToolCallRenderer {
  return renderers.get(name) ?? DefaultCall;
}

/** The registry from tool name to the component that draws it, shaped like CopilotKit's `useRenderToolCall`. */
export function useToolCallRenderer(): (name: string) => ToolCallRenderer {
  return rendererFor;
}
