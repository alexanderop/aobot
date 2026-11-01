import {
  CommandEnd,
  type CommandOutput,
  type CommandRan,
  commandTimeLimit,
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
