import { realpathSync } from "node:fs";
import { Effect, FileSystem, Layer, Option, Path, Schema, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  type TranscriptEntry,
  encodeTranscript,
  lineSplitter,
  placeholders,
  readJson,
  substitute,
} from "./acp-transcript.ts";

const CommandsUpdate = Schema.Struct({
  method: Schema.Literal("session/update"),
  params: Schema.Struct({
    sessionId: Schema.String,
    update: Schema.Struct({ sessionUpdate: Schema.Literal("available_commands_update") }),
  }),
});

const decodeCommandsUpdate = Schema.decodeUnknownOption(CommandsUpdate);

/**
An adapter lists the slash commands and skills of the person whose machine it runs on. Our client
ignores the list, and it is not ours to commit, so the recording keeps the message with an empty list.
*/
function scrub(frame: Schema.Json): Schema.Json {
  return Option.match(decodeCommandsUpdate(frame), {
    onNone: () => frame,
    onSome: ({ params }) => ({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      },
    }),
  });
}

/** Where a recording goes and what it is about. */
export interface Recording {
  /** The transcript file to write when the process ends. */
  readonly file: string;
  readonly scenario: string;
  readonly agent: string;
  /** The real gateway MCP URL, written as `<gateway>`. */
  readonly gatewayMcpUrl: string;
}

/**
A spawner that starts the real process through `ChildProcessSpawner` underneath and keeps a copy of every
JSON line on its stdin and stdout, in the order our client wrote and read them, with run-specific values
replaced by placeholders and the person's own command list emptied (see `scrub`). When the process's scope
closes it writes them as a transcript to `recording.file`. Lines that are not JSON, such as an adapter's
log lines on stdout, are left out: our client skips them too.
*/
export function recordingSpawner(recording: Recording) {
  return Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* real.spawn(command);

          const standard = ChildProcess.isStandardCommand(command)
            ? Option.some(command)
            : Option.none();

          const cwd = Option.flatMap(standard, (each) => Option.fromNullishOr(each.options.cwd));

          // macOS hands out temporary folders under /var, which is a link to /private/var. Both
          // spellings show up in what adapters write; the longer one is replaced first.
          const pairs: ReadonlyArray<readonly [string, string]> = [
            [recording.gatewayMcpUrl, placeholders.gateway],
            ...Option.toArray(cwd).flatMap((folder) => [
              [realpathSync(folder), placeholders.workspace] as const,
              [folder, placeholders.workspace] as const,
            ]),
          ];

          const entries: Array<TranscriptEntry> = [];

          const keep = (type: TranscriptEntry["type"]) => (line: string) =>
            Option.match(readJson(line), {
              onNone: () => {},
              onSome: (frame) => {
                entries.push({ type, frame: substitute(scrub(frame), pairs) });
              },
            });

          const splitWritten = lineSplitter();
          const splitRead = lineSplitter();
          const written = (chunk: Uint8Array) => splitWritten(chunk).forEach(keep("expect"));
          const read = (chunk: Uint8Array) => splitRead(chunk).forEach(keep("emit"));

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(path.dirname(recording.file), { recursive: true });
              yield* fs.writeFileString(
                recording.file,
                `${encodeTranscript({
                  start: {
                    type: "start",
                    scenario: recording.scenario,
                    agent: recording.agent,
                    command: Option.match(standard, {
                      onNone: () => "",
                      onSome: (each) => each.command,
                    }),
                    args: Option.match(standard, {
                      onNone: () => [],
                      onSome: (each) => each.args.map(String),
                    }),
                  },
                  entries,
                })}\n`,
              );
            }).pipe(Effect.orDie),
          );

          return ChildProcessSpawner.makeHandle({
            ...handle,
            stdin: Sink.mapInput(handle.stdin, (chunk: Uint8Array) => {
              written(chunk);

              return chunk;
            }),
            stdout: handle.stdout.pipe(Stream.tap((chunk) => Effect.sync(() => read(chunk)))),
          });
        }),
      );
    }),
  );
}
