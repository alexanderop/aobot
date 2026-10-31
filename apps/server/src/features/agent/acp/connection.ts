import {
  Array,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  MutableHashMap,
  Option,
  Queue,
  type Schema,
  Stream,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { ModelFailed } from "../agent-runtime.ts";
import {
  Incoming,
  notificationLine,
  type Reply,
  type RequestId,
  readLine,
  replyLine,
  requestLine,
} from "./wire.ts";

/** What the agent may send us unasked: notifications to note, and requests to answer. */
export interface AcpHandlers {
  readonly notification: (method: string, params: Schema.Json) => Effect.Effect<void>;
  readonly request: (method: string, params: Schema.Json) => Effect.Effect<Reply>;
}

/** JSON-RPC over one agent process's stdio. */
export interface AcpConnection {
  /** Ask the agent and wait for its answer. Fails if the agent refuses or exits first. */
  readonly request: (
    method: string,
    params: Schema.Json,
  ) => Effect.Effect<Schema.Json, ModelFailed>;
  readonly notify: (method: string, params: Schema.Json) => Effect.Effect<void>;
  /** Write whatever is still queued, then close the agent's stdin. */
  readonly close: Effect.Effect<void>;
}

/** The last non-empty line of what the agent wrote to stderr, which is usually why it stopped. */
function lastLine(text: string): Option.Option<string> {
  return Array.findLast(
    text.split("\n").map((line) => line.trim()),
    (line) => line.length > 0,
  );
}

/**
Speak newline-delimited JSON-RPC 2.0 with an agent started as `handle`. Lines arrive in order and are
handled one at a time, so every `session/update` before an answer is handled before that answer.
*/
export const connect = Effect.fnUntraced(function* (
  agent: string,
  handle: ChildProcessSpawner.ChildProcessHandle,
  handlers: AcpHandlers,
) {
  const outgoing = yield* Queue.unbounded<string, Cause.Done>();
  const pending = MutableHashMap.empty<RequestId, Deferred.Deferred<Schema.Json, ModelFailed>>();
  let nextId = 0;
  let gone = Option.none<ModelFailed>();
  let stderrTail = "";

  const writer = yield* Stream.fromQueue(outgoing).pipe(
    Stream.encodeText,
    Stream.run(handle.stdin),
    Effect.ignore,
    Effect.forkScoped,
  );

  const stderr = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        stderrTail = (stderrTail + chunk).slice(-2_000);
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const settle = (id: RequestId, exit: Exit.Exit<Schema.Json, ModelFailed>) =>
    Option.match(MutableHashMap.get(pending, id), {
      onNone: () => Effect.void,
      onSome: (answer) => Deferred.done(answer, exit),
    });

  const dispatch = Incoming.$match({
    Request: ({ id, method, params }) =>
      handlers
        .request(method, params)
        .pipe(Effect.flatMap((reply) => Queue.offer(outgoing, replyLine(id, reply)))),
    Notification: ({ method, params }) => handlers.notification(method, params),
    Answered: ({ id, result }) => settle(id, Exit.succeed(result)),
    Failed: ({ id, code, message }) =>
      settle(id, Exit.fail(new ModelFailed({ reason: `${agent} answered ${code}: ${message}` }))),
    Unreadable: () => Effect.void,
  });

  // The agent closed stdout, so it has exited or is about to: nothing pending will be answered.
  const exited = Effect.gen(function* () {
    yield* Fiber.join(stderr).pipe(Effect.timeout("500 millis"), Effect.ignore);

    const why = Option.match(lastLine(stderrTail), {
      onNone: () => ".",
      onSome: (line) => `: ${line}`,
    });

    const failure = new ModelFailed({ reason: `${agent} exited before it answered${why}` });
    gone = Option.some(failure);

    yield* Effect.forEach(
      MutableHashMap.values(pending),
      (answer) => Deferred.fail(answer, failure),
      {
        discard: true,
      },
    );
  });

  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => dispatch(readLine(line))),
    Effect.ignore,
    Effect.andThen(exited),
    Effect.forkScoped,
  );

  const request = (method: string, params: Schema.Json) =>
    Effect.gen(function* () {
      const answer = yield* Deferred.make<Schema.Json, ModelFailed>();

      // The check and the registration run in one synchronous step, so an exit cannot slip between.
      const id = yield* Effect.suspend(() => {
        if (Option.isSome(gone)) return Effect.fail(gone.value);

        const id = nextId++;
        MutableHashMap.set(pending, id, answer);

        return Effect.succeed(id);
      });

      yield* Queue.offer(outgoing, requestLine(id, method, params));

      return yield* Deferred.await(answer).pipe(
        Effect.ensuring(Effect.sync(() => MutableHashMap.remove(pending, id))),
      );
    });

  const notify = (method: string, params: Schema.Json) =>
    Queue.offer(outgoing, notificationLine(method, params)).pipe(Effect.asVoid);

  const close = Queue.end(outgoing).pipe(
    Effect.andThen(Fiber.join(writer).pipe(Effect.timeout("1 second"), Effect.ignore)),
  );

  return { request, notify, close } satisfies AcpConnection;
});
