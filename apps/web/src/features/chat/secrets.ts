import { type BotId, SecretAnswer, type ToolCallId } from "@aobot/domain";
import { Effect, Redacted, Schedule, Stream } from "effect";
import { Atom } from "effect/reactivity";
import { SecretClient } from "./secret-client.ts";
import { SecretReply, type SentAnswer } from "./secret-entry.ts";

/** Forgets the secret in `answer`, so the `Redacted` holds nothing once it is sent. */
function wipe(answer: SecretAnswer): void {
  if (SecretAnswer.guards.Supplied(answer)) Redacted.wipeUnsafe(answer.value);
}

/** The secret atoms, over the client `runtime` gives: the server's on the page, a fake one in a test. */
export function makeSecrets(runtime: Atom.AtomRuntime<SecretClient>) {
  /** The request a Bot waits on for its person, as the server last said. Watched while a card reads it. */
  const secretPending = Atom.family((bot: BotId) =>
    runtime.atom(
      Stream.unwrap(
        SecretClient.use((client) => Effect.succeed(client("Secret.pending", { bot }))),
      ).pipe(Stream.retry(Schedule.spaced("1 second"))),
    ),
  );

  /**
  The person's answer to the request one tool call made, and what the server said to it. Kept alive, so
  the card shows the answer after it re-renders. The atom keeps the answer it was last given, so the
  secret in it, a `Redacted`, is wiped once the call settles, however it settles: from then on no atom
  holds it, and nothing ever stores it.
  */
  const secretAnswer = Atom.family((_call: ToolCallId) =>
    Atom.keepAlive(
      runtime.fn(
        Effect.fnUntraced(function* (sent: SentAnswer) {
          const client = yield* SecretClient;

          return yield* client("Secret.answer", sent).pipe(
            Effect.match({
              onSuccess: () => SecretReply.Taken({ answer: sent.answer._tag }),
              onFailure: ({ message }) => SecretReply.Refused({ message }),
            }),
            Effect.ensuring(Effect.sync(() => wipe(sent.answer))),
          );
        }),
      ),
    ),
  );

  return { secretPending, secretAnswer };
}

/** The page's secret atoms, over its RPC socket. */
export const { secretPending, secretAnswer } = makeSecrets(SecretClient.runtime);
