import {
  BotId,
  NoSecretRequested,
  type PendingSecret,
  SecretAnswer,
  SecretRequestId,
  SecretRpcs,
  ToolCallId,
} from "@aobot/domain";
import { Effect, Layer, Option, Redacted, Stream } from "effect";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { RpcTest } from "effect/rpc";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SecretClient } from "./secret-client.ts";
import { SecretReply, type SentAnswer } from "./secret-entry.ts";
import { makeSecrets } from "./secrets.ts";

/** A secret client whose server shows `pending` and does `answer` with each answer it receives. */
function serverAnswering(
  answer: (payload: SentAnswer) => Effect.Effect<void, NoSecretRequested>,
  pending: Stream.Stream<Option.Option<PendingSecret>> = Stream.never,
) {
  const handlers = SecretRpcs.toLayer({
    "Secret.pending": () => pending,
    "Secret.answer": answer,
  });

  return Atom.runtime(
    Layer.effect(SecretClient, RpcTest.makeClient(SecretRpcs, { flatten: true })).pipe(
      Layer.provide(handlers),
    ),
  );
}

const registries: AtomRegistry.AtomRegistry[] = [];

afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
});

const call = ToolCallId.make("call-1");

const assistant = BotId.make("assistant");

const request = SecretRequestId.make("request-1");

/** What `secretAnswer` settles on once nothing is on its way. */
function replyTo(
  registry: AtomRegistry.AtomRegistry,
  secretAnswer: ReturnType<typeof makeSecrets>["secretAnswer"],
): Promise<SecretReply> {
  return Atom.toStream(secretAnswer(call)).pipe(
    Stream.filter((last) => !last.waiting),
    Stream.map(AsyncResult.value),
    Stream.filter(Option.isSome),
    Stream.runHead,
    Effect.map((reply) => Option.getOrThrow(Option.flatten(reply))),
    Effect.provideService(AtomRegistry.AtomRegistry, registry),
    Effect.runPromise,
  );
}

describe("given a Bot waiting for its person's secret", () => {
  describe("when the page watches the Bot's request", () => {
    it("shows the request the server says the Bot waits on", async () => {
      const shown = { request, field: "the password", host: "shop.example" };
      const server = serverAnswering(() => Effect.void, Stream.make(Option.some(shown)));

      const { secretPending } = makeSecrets(server);
      const registry = AtomRegistry.make();
      registries.push(registry);

      const pending = await Atom.toStream(secretPending(assistant)).pipe(
        Stream.map(AsyncResult.value),
        Stream.filter(Option.isSome),
        Stream.runHead,
        Effect.provideService(AtomRegistry.AtomRegistry, registry),
        Effect.runPromise,
      );

      expect(Option.flatten(Option.flatten(pending))).toEqual(Option.some(shown));
    });
  });

  describe("when the person supplies it", () => {
    it("hands the server the secret for that request, says it was taken, then forgets it", async () => {
      const received: Array<{ readonly sent: SentAnswer; readonly secret: string }> = [];

      const server = serverAnswering((sent) =>
        Effect.sync(() => {
          if (SecretAnswer.guards.Supplied(sent.answer)) {
            received.push({ sent, secret: Redacted.value(sent.answer.value) });
          }
        }),
      );

      const { secretAnswer } = makeSecrets(server);
      const registry = AtomRegistry.make();
      registries.push(registry);
      registry.mount(secretAnswer(call));

      const answer = SecretAnswer.cases.Supplied.make({ value: Redacted.make("hunter2") });
      registry.set(secretAnswer(call), { bot: assistant, request, answer });

      expect(await replyTo(registry, secretAnswer)).toEqual(
        SecretReply.Taken({ answer: "Supplied" }),
      );
      expect(received.map(({ sent, secret }) => [sent.bot, sent.request, secret])).toEqual([
        [assistant, request, "hunter2"],
      ]);
      expect(() => Redacted.value(answer.value)).toThrow();
    });
  });

  describe("when the server finds no request waiting any more", () => {
    it("says why, and forgets the secret all the same", async () => {
      const server = serverAnswering(() =>
        Effect.fail(new NoSecretRequested({ message: "The Bot is not waiting for a secret." })),
      );

      const { secretAnswer } = makeSecrets(server);
      const registry = AtomRegistry.make();
      registries.push(registry);
      registry.mount(secretAnswer(call));

      const answer = SecretAnswer.cases.Supplied.make({ value: Redacted.make("hunter2") });
      registry.set(secretAnswer(call), { bot: assistant, request, answer });

      expect(await replyTo(registry, secretAnswer)).toEqual(
        SecretReply.Refused({ message: "The Bot is not waiting for a secret." }),
      );
      expect(() => Redacted.value(answer.value)).toThrow();
    });
  });
});
