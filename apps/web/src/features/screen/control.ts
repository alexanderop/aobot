import { Effect, Option, Schedule, Stream } from "effect";
import { Atom } from "effect/reactivity";
import { ControlClient } from "./control-client.ts";
import { type Answered, ControlCommand, type Sent } from "./control-state.ts";

/** The control atoms, over the client `runtime` gives: the server's on the page, a fake one in a test. */
export function makeControl(runtime: Atom.AtomRuntime<ControlClient>) {
  /** Who holds the Bot's computer, as the server last said. Watched for as long as the page reads it. */
  const control = runtime.atom(
    Stream.unwrap(
      ControlClient.use((client) => Effect.succeed(client("Control.watch", undefined))),
    ).pipe(Stream.retry(Schedule.spaced("1 second"))),
  );

  /**
  The person's last command and how it was answered. One atom for every command, so a new one replaces
  the last and an old failure never comes back. A take or a hand back it replaces stops being waited
  for. A click it replaces still runs to its end, so every click reaches the computer, in the order made.
  Kept alive, so a call goes on when the button that started it unmounts, as the rail's does once the
  panel opens.
  */
  const lastCommand = Atom.keepAlive(
    runtime.fn(
      Effect.fnUntraced(function* (sent: Sent) {
        const client = yield* ControlClient;

        const call = ControlCommand.$match(sent.command, {
          Take: () => client("Control.take", undefined).pipe(Effect.asVoid),
          HandBack: () => client("Control.handBack", undefined).pipe(Effect.asVoid),
          Click: ({ at }) => Effect.uninterruptible(client("Control.click", at)),
        });

        return yield* call.pipe(
          Effect.match({
            onSuccess: (): Answered => ({ sentWhile: sent.sentWhile, failure: Option.none() }),
            onFailure: ({ _tag, message }): Answered => ({
              sentWhile: sent.sentWhile,
              failure: Option.some({ _tag, message }),
            }),
          }),
        );
      }),
    ),
  );

  return { control, lastCommand };
}

/** The page's control atoms, over its RPC socket. */
export const { control, lastCommand } = makeControl(ControlClient.runtime);
