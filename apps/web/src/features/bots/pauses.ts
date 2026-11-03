import { type BotId, type PauseNotChanged, type SignedOut, type UnknownBot } from "@aobot/domain";
import { Effect, Match, Option, Schedule, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { RpcClientError } from "effect/rpc";
import { PauseClient } from "./pause-client.ts";

/** What an admin asks of a Bot. */
type PauseChange = PauseNotChanged["change"];

/** Why a pause or a resume the server could not store did not happen. */
const notStored: Readonly<Record<PauseChange, string>> = {
  pause: "The Bot was not paused: the pause could not be stored.",
  resume: "The Bot was not resumed: the change could not be stored.",
};

/** Why a pause or a resume did not happen, as the server or the connection said. */
const whyNotChanged = Match.typeTags<
  PauseNotChanged | UnknownBot | SignedOut | RpcClientError.RpcClientError,
  string
>()({
  PauseNotChanged: ({ change }) => notStored[change],
  UnknownBot: () => "The server knows no such Bot.",
  SignedOut: ({ message }) => message,
  RpcClientError: () => "Cannot reach the server.",
});

/** The pause atoms, over the client `runtime` gives: the server's on the page, a fake one in a test. */
export function makePauses(runtime: Atom.AtomRuntime<PauseClient>) {
  /** The paused Bots, as the server last said. Watched for as long as the page reads it. */
  const pausedBots = runtime.atom(
    Stream.unwrap(
      PauseClient.use((client) => Effect.succeed(client("Pause.watch", undefined))),
    ).pipe(Stream.retry(Schedule.spaced("1 second"))),
  );

  /**
  The last pause or resume of `bot`, answered with why it failed, if it did. One atom per Bot, so a new
  change replaces the last and an old failure never comes back. Kept alive, so a change goes on when the
  header that sent it unmounts.
  */
  const lastChange = Atom.family((bot: BotId) =>
    Atom.keepAlive(
      runtime.fn(
        Effect.fnUntraced(function* (change: PauseChange) {
          const client = yield* PauseClient;
          const ref = { botId: bot };

          const call =
            change === "pause" ? client("Pause.pause", ref) : client("Pause.resume", ref);

          return yield* call.pipe(
            Effect.match({
              onSuccess: () => Option.none<string>(),
              onFailure: (error) => Option.some(whyNotChanged(error)),
            }),
          );
        }),
      ),
    ),
  );

  return { pausedBots, lastChange };
}

/** The page's pause atoms, over its RPC socket. */
export const { pausedBots, lastChange } = makePauses(PauseClient.runtime);
