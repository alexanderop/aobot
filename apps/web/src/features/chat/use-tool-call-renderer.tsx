import { WorkspacePath } from "@aobot/domain";
import { Option, Schema } from "effect";
import type { ReactNode } from "react";
import { ToolCallStatus } from "./conversation-state.ts";
import type { ToolCall } from "./conversation-state.ts";
import { FileChip } from "./FileChip.tsx";

/** Draws one tool call in each of its states. */
export type ToolCallRenderer = (props: { readonly call: ToolCall }) => ReactNode;

const decodeNavigateArgs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
);

const decodeRefArgs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ ref: Schema.String })),
);

const refOf = (args: string) => Option.map(decodeRefArgs(args), ({ ref }) => ref);

const decodeRunArgs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ command: Schema.String })),
);

const decodePathArgs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ path: WorkspacePath })),
);

const pathOf = (args: string) => Option.map(decodePathArgs(args), ({ path }) => path);

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

/** What a card says in each state, given what its call names: an element's ref, or a file's path. */
interface CallWords {
  readonly running: (target: string) => string;
  readonly done: (target: string) => string;
  readonly failed: (target: string) => string;
  readonly unfinished: (target: string) => string;
}

/**
A call on one thing its args name, or `fallback` when they name none: what it did, then `shown` of what
it answered, or why not.
*/
function namedCall(options: {
  readonly target: (args: string) => Option.Option<string>;
  readonly fallback: string;
  readonly words: CallWords;
  readonly shown: (target: string, result: string) => ReactNode;
}): ToolCallRenderer {
  const { words, shown } = options;

  return function NamedCall({ call }) {
    const target = Option.getOrElse(options.target(call.args), () => options.fallback);

    return ToolCallStatus.$match(call.status, {
      Running: () => <p className="tool-call__title">{words.running(target)}</p>,
      Done: ({ result }) => (
        <>
          <p className="tool-call__title">{words.done(target)}</p>
          {shown(target, result)}
        </>
      ),
      Failed: ({ result }) => (
        <>
          <p className="tool-call__title">{words.failed(target)}</p>
          <Result summary="Why" text={result} />
        </>
      ),
      Unfinished: () => <p className="tool-call__title">{words.unfinished(target)}</p>,
    });
  };
}

const pageAfter = (_ref: string, result: string) => (
  <Result summary="The page after" text={result} />
);

const ClickCall = namedCall({
  target: refOf,
  fallback: "an element",
  words: {
    running: (ref) => `Clicking ${ref}…`,
    done: (ref) => `Clicked ${ref}`,
    failed: (ref) => `Could not click ${ref}`,
    unfinished: (ref) => `Did not finish clicking ${ref}`,
  },
  shown: pageAfter,
});

const TypeCall = namedCall({
  target: refOf,
  fallback: "an element",
  words: {
    running: (ref) => `Typing into ${ref}…`,
    done: (ref) => `Typed into ${ref}`,
    failed: (ref) => `Could not type into ${ref}`,
    unfinished: (ref) => `Did not finish typing into ${ref}`,
  },
  shown: pageAfter,
});

function RunCall({ call }: { readonly call: ToolCall }) {
  return (
    <>
      <p className="tool-call__title">
        {ToolCallStatus.$match(call.status, {
          Running: () => "Running a command…",
          Done: () => "Ran a command",
          Failed: () => "Could not run a command",
          Unfinished: () => "Did not finish a command",
        })}
      </p>
      {Option.match(decodeRunArgs(call.args), {
        onNone: () => null,
        onSome: ({ command }) => <code className="tool-call__args">{command}</code>,
      })}
      {ToolCallStatus.$match(call.status, {
        Done: ({ result }) => <Result summary="What it printed" text={result} />,
        Failed: ({ result }) => <Result summary="Why" text={result} />,
        Running: () => null,
        Unfinished: () => null,
      })}
    </>
  );
}

const ReadFileCall = namedCall({
  target: pathOf,
  fallback: "a file",
  words: {
    running: (path) => `Reading ${path}…`,
    done: (path) => `Read ${path}`,
    failed: (path) => `Could not read ${path}`,
    unfinished: (path) => `Did not finish reading ${path}`,
  },
  shown: (_path, result) => <Result summary="What it read" text={result} />,
});

/** A file the Bot saved: once it is saved, a chip the person downloads it from. */
const WriteFileCall = namedCall({
  target: pathOf,
  fallback: "a file",
  words: {
    running: (path) => `Saving ${path}…`,
    done: (path) => `Saved ${path}`,
    failed: (path) => `Could not save ${path}`,
    unfinished: (path) => `Did not finish saving ${path}`,
  },
  shown: (path) => <FileChip path={path} />,
});

/** Where a listing starts, in words: a folder, or the whole workspace for `.`. */
const folderWords = (path: string) => (path === "." ? "your files" : path);

const ListFilesCall = namedCall({
  target: pathOf,
  fallback: "a folder",
  words: {
    running: (path) => `Listing ${folderWords(path)}…`,
    done: (path) => `Listed ${folderWords(path)}`,
    failed: (path) => `Could not list ${folderWords(path)}`,
    unfinished: (path) => `Did not finish listing ${folderWords(path)}`,
  },
  shown: (_path, result) => <Result summary="What is there" text={result} />,
});

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
  ["read_file", ReadFileCall],
  ["write_file", WriteFileCall],
  ["list_files", ListFilesCall],
]);

function rendererFor(name: string): ToolCallRenderer {
  return renderers.get(name) ?? DefaultCall;
}

/** The registry from tool name to the component that draws it, shaped like CopilotKit's `useRenderToolCall`. */
export function useToolCallRenderer(): (name: string) => ToolCallRenderer {
  return rendererFor;
}
