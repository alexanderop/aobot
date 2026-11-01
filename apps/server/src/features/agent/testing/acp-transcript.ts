import { Option, Schema } from "effect";

/**
One recorded turn of an ACP adapter, as newline-delimited JSON: a `start` line naming how the adapter
was launched, then every JSON-RPC message in the order our client saw it. `expect` is a message our
client wrote and must write again on replay; `emit` is one the adapter wrote and the replay writes back.

Recorded by the contract suite (`vp run test:contract:agents:record`, see `recording-spawner.ts`) against
the mock model, replayed in-process by `replay-spawner.ts`.
*/
const TranscriptStart = Schema.Struct({
  type: Schema.Literal("start"),
  scenario: Schema.String,
  agent: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
});

/** A message our client wrote to the adapter's stdin. */
const TranscriptExpect = Schema.Struct({
  type: Schema.Literal("expect"),
  frame: Schema.Json,
});

/** A message the adapter wrote to its stdout. */
const TranscriptEmit = Schema.Struct({ type: Schema.Literal("emit"), frame: Schema.Json });

/** One line after the `start` line. */
export const TranscriptEntry = Schema.Union([TranscriptExpect, TranscriptEmit]);

/** A decoded {@link TranscriptEntry}. */
export type TranscriptEntry = typeof TranscriptEntry.Type;

/** A whole decoded transcript. */
export interface Transcript {
  readonly start: typeof TranscriptStart.Type;
  readonly entries: ReadonlyArray<TranscriptEntry>;
}

/**
Stand-ins for values that differ on every run. The turn's own folder becomes `<workspace>`; tests pass
`<gateway>` as the gateway's MCP URL, and the recorder rewrites the real one to it.
*/
export const placeholders = { workspace: "<workspace>", gateway: "<gateway>" } as const;

const decodeStart = Schema.decodeUnknownSync(Schema.fromJsonString(TranscriptStart));

const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(TranscriptEntry));

/** Read a transcript file's text. Throws on a malformed line: a broken fixture is a broken test. */
export function decodeTranscript(text: string): Transcript {
  const [first = "", ...rest] = text.split("\n").filter((line) => line.trim() !== "");

  return { start: decodeStart(first), entries: rest.map((line) => decodeEntry(line)) };
}

/** Write a transcript as file text, one JSON value per line. */
export function encodeTranscript(transcript: Transcript): string {
  return [transcript.start, ...transcript.entries].map((line) => JSON.stringify(line)).join("\n");
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** One line of JSON as a value, or `Option.none()` for a log line or a broken message. */
export const readJson = (line: string): Option.Option<Schema.Json> => decodeJson(line);

const Labelled = Schema.Struct({
  method: Schema.OptionFromOptionalKey(Schema.String),
  id: Schema.OptionFromOptionalKey(Schema.Json),
});

const decodeLabelled = Schema.decodeUnknownOption(Labelled);

/**
A short name for a message, which replay gates refer to: the method of a request or notification
(`session/update`), `answer:<id>` for an answer to request `<id>`.
*/
export function labelOf(frame: Schema.Json): string {
  return Option.match(decodeLabelled(frame), {
    onNone: () => "unreadable",
    onSome: ({ method, id }) =>
      Option.getOrElse(method, () => `answer:${JSON.stringify(Option.getOrNull(id))}`),
  });
}

const decodeJsonSync = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/**
Replace every occurrence of each `[from, to]` pair in `frame`'s text. Placeholders and folder paths have
nothing JSON escapes, so replacing them in the text replaces them in every string inside.
*/
export function substitute(
  frame: Schema.Json,
  pairs: ReadonlyArray<readonly [string, string]>,
): Schema.Json {
  const text = pairs.reduce(
    (current, [from, to]) => (from === "" ? current : current.replaceAll(from, to)),
    JSON.stringify(frame),
  );

  return decodeJsonSync(text);
}

/** Splits a byte stream into lines, carrying a partial line over to the next chunk. */
export function lineSplitter(): (chunk: Uint8Array) => ReadonlyArray<string> {
  const decoder = new TextDecoder();
  let partial = "";

  return (chunk) => {
    const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n");
    partial = lines.pop() ?? "";

    return lines;
  };
}
