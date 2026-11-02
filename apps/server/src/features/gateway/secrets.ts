import {
  type BotId,
  NoSecretRequested,
  type PendingSecret,
  type SecretAnswer,
  SecretRequestId,
} from "@aobot/domain";
import {
  Context,
  Deferred,
  type Duration,
  Effect,
  HashMap,
  Option,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";

/** A person answering the secret a Bot asked them for. */
export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    /** The request `bot` waits on for its person, if any: now, then each change. */
    readonly pending: (bot: BotId) => Stream.Stream<Option.Option<PendingSecret>>;
    /**
    Hands `answer` to `bot`'s waiting request `request`, which the gateway then carries out. Fails when
    that request is not the one waiting: it was never shown, or it was answered, timed out or stopped.
    */
    readonly answer: (
      bot: BotId,
      request: SecretRequestId,
      answer: SecretAnswer,
    ) => Effect.Effect<void, NoSecretRequested>;
  }
>()("aobot/gateway/SecretRequests") {}

/**
One Bot's request for a secret. It is held for the Bot while its ref is resolved and judged, so a second
request is refused before any rule runs, and `shown` to the person only once the rules allowed it; only
then is an answer taken.
*/
interface Waiting {
  readonly id: SecretRequestId;
  readonly answer: Deferred.Deferred<SecretAnswer>;
  readonly shown: Option.Option<PendingSecret>;
}

/** Each Bot's request that waits for its person, by the Bot. */
type Requests = HashMap.HashMap<BotId, Waiting>;

/** The Bot asked for a secret while its earlier request still waits for the person. */
export class AlreadyAsked extends Schema.TaggedError<AlreadyAsked>()("AlreadyAsked", {}) {}

/** One Bot's request for a secret, from {@link secretRequests}'s `open`. */
export interface OpenRequest {
  /** Shows the request to the person as `field` on a page at `host`. Their answer is taken from then on. */
  readonly ask: (field: string, host: string) => Effect.Effect<void>;
  /**
  The person's answer, or none once `limit` passed. The request is withdrawn the moment the wait ends,
  however it ends, so an answer that comes later finds none.
  */
  readonly wait: (limit: Duration.Input) => Effect.Effect<Option.Option<SecretAnswer>>;
}

const noRequest = new NoSecretRequested({
  message: "The Bot is not waiting for that secret any more, so nothing was typed.",
});

const samePending = Option.makeEquivalence<PendingSecret>((a, b) => a.request === b.request);

/**
Where each Bot's request for a secret waits for the person's answer, one request per Bot at a time. In
memory: a request waits inside one turn, and a restart ends the turn with it. The answer is handed over
once, so a second answer to the same request finds none.
*/
export const secretRequests = Effect.gen(function* () {
  const requests = yield* SubscriptionRef.make<Requests>(HashMap.empty());

  /** Takes `bot`'s request out, when it is still `id`, and says whether it did. */
  const withdraw = (bot: BotId, id: SecretRequestId) =>
    SubscriptionRef.modify(requests, (all): readonly [boolean, Requests] =>
      Option.exists(HashMap.get(all, bot), (waiting) => waiting.id === id)
        ? [true, HashMap.remove(all, bot)]
        : [false, all],
    );

  /** Holds a request for `bot` until the scope closes. Fails while another of its requests waits. */
  const open = (bot: BotId): Effect.Effect<OpenRequest, AlreadyAsked, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const waiting: Waiting = {
          id: SecretRequestId.make(crypto.randomUUID()),
          answer: yield* Deferred.make<SecretAnswer>(),
          shown: Option.none(),
        };

        const opened = yield* SubscriptionRef.modify(
          requests,
          (all): readonly [boolean, Requests] =>
            HashMap.has(all, bot) ? [false, all] : [true, HashMap.set(all, bot, waiting)],
        );

        if (!opened) return yield* new AlreadyAsked();

        return waiting;
      }),
      ({ id }) => withdraw(bot, id),
    ).pipe(
      Effect.map(({ id, answer }): OpenRequest => {
        const withdrawn = withdraw(bot, id);

        return {
          ask: (field, host) =>
            SubscriptionRef.update(requests, (all) =>
              HashMap.modifyAt(
                all,
                bot,
                Option.map((waiting) =>
                  waiting.id === id
                    ? { ...waiting, shown: Option.some({ request: id, field, host }) }
                    : waiting,
                ),
              ),
            ),
          wait: (limit) =>
            Deferred.await(answer).pipe(
              Effect.timeoutOption(limit),
              Effect.flatMap(
                Option.match({
                  onSome: (given) => Effect.succeedSome(given),
                  // An answer that took the request before the wait ended is handed over all the same.
                  onNone: () =>
                    Effect.flatMap(withdrawn, (taken) =>
                      taken ? Effect.succeedNone : Effect.asSome(Deferred.await(answer)),
                    ),
                }),
              ),
              Effect.onInterrupt(() => withdrawn),
            ),
        };
      }),
    );

  const pending = (bot: BotId) =>
    SubscriptionRef.changes(requests).pipe(
      Stream.map((all) => Option.flatMap(HashMap.get(all, bot), ({ shown }) => shown)),
      Stream.changesWith(samePending),
    );

  const answer = Effect.fn("SecretRequests.answer")(function* (
    bot: BotId,
    request: SecretRequestId,
    given: SecretAnswer,
  ) {
    const taken = yield* SubscriptionRef.modify(
      requests,
      (all): readonly [Option.Option<Deferred.Deferred<SecretAnswer>>, Requests] =>
        Option.match(
          Option.filter(
            HashMap.get(all, bot),
            (waiting) => waiting.id === request && Option.isSome(waiting.shown),
          ),
          {
            onNone: () => [Option.none(), all],
            onSome: (waiting) => [Option.some(waiting.answer), HashMap.remove(all, bot)],
          },
        ),
    );

    yield* Option.match(taken, {
      onNone: () => Effect.fail(noRequest),
      onSome: (waiting) => Deferred.succeed(waiting, given),
    });
  });

  return { open, requests: SecretRequests.of({ pending, answer }) };
});
