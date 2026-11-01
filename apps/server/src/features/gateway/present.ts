import {
  CommandEnd,
  type CommandOutput,
  type CommandRan,
  commandTimeLimit,
  FileAnswer,
  FileEntry,
  fileListLimit,
  fileReadLimit,
  type PageRead,
} from "@aobot/domain";
import { Duration } from "effect";

/** A page the computer read, as the model reads it before it is marked untrusted. */
export function presentPage({ url, title, snapshot, truncated }: PageRead): string {
  return [
    `URL: ${url}`,
    `Title: ${title}`,
    "",
    snapshot,
    ...(truncated ? ["[the computer cut this snapshot short]"] : []),
  ].join("\n");
}

function presentEnd(end: CommandEnd): string {
  return CommandEnd.match(end, {
    Exited: ({ code }) => `Exit code: ${code}`,
    Signalled: ({ signal }) => `The command was ended by ${signal}.`,
    TimedOut: () =>
      `The command ran past ${Duration.format(commandTimeLimit)}, so the computer stopped it.`,
  });
}

function presentOutput(name: string, { text, truncated }: CommandOutput): ReadonlyArray<string> {
  return [
    `${name}:`,
    text === "" ? "(nothing)" : text,
    ...(truncated ? [`[the computer kept only the end of ${name}]`] : []),
  ];
}

/** How a command ended and what it printed, as the model reads it before it is marked untrusted. */
export function presentCommand({ end, stdout, stderr, leftOutputOpen }: CommandRan): string {
  return [
    presentEnd(end),
    "",
    ...presentOutput("stdout", stdout),
    "",
    ...presentOutput("stderr", stderr),
    ...(leftOutputOpen
      ? [
          "",
          "[the computer stopped what the command left running, so anything it printed later is missing]",
        ]
      : []),
  ].join("\n");
}

/** The `Gateway.act` span's attributes for how a command ended. Never the command or its output. */
export function endAttributes(end: CommandEnd): Record<string, string | number> {
  return CommandEnd.match(end, {
    Exited: ({ code }) => ({ "gateway.command_end": "exited", "gateway.exit_code": code }),
    Signalled: ({ signal }) => ({ "gateway.command_end": "signalled", "gateway.signal": signal }),
    TimedOut: () => ({ "gateway.command_end": "timed_out" }),
  });
}

const presentEntry = FileEntry.match({
  file: ({ path, bytes }) => `${path} (${bytes} bytes)`,
  folder: ({ path }) => `${path}/`,
  unreadable: ({ path }) => `${path} (could not be read)`,
});

/** What a file action answered, as the model reads it before it is marked untrusted. Contents only for a read. */
export const presentFile = FileAnswer.match({
  read_file: ({ path, text, truncated, bytes }) =>
    [
      `File: ${path} (${bytes} bytes)`,
      "",
      text,
      ...(truncated
        ? [`[the computer read only the first ${fileReadLimit} bytes of ${bytes}]`]
        : []),
    ].join("\n"),
  write_file: ({ path, bytes }) =>
    `Saved ${path} (${bytes} bytes). Your person can download it from the chat.`,
  list_files: ({ path, entries, truncated }) =>
    [
      `Files in ${path === "." ? "your workspace" : path}:`,
      ...(entries.length === 0 ? ["(none)"] : entries.map(presentEntry)),
      ...(truncated ? [`[the computer listed only the first ${fileListLimit}]`] : []),
    ].join("\n"),
});

/** The `Gateway.act` span's attributes for a file action: the file's size, never its path or contents. */
export function fileAttributes(answer: FileAnswer): Record<string, number> {
  return FileAnswer.match(answer, {
    read_file: ({ bytes }) => ({ "gateway.file_bytes": bytes }),
    write_file: ({ bytes }) => ({ "gateway.file_bytes": bytes }),
    list_files: ({ entries }) => ({ "gateway.file_entries": entries.length }),
  });
}
