import {
  ApprovalId,
  ApprovalRpcs,
  ConversationId,
  NoApprovalWaiting,
  type PendingApproval,
} from "@aobot/domain";
import { Effect, Layer, Option, Stream } from "effect";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { type Rpc, type RpcGroup, RpcTest } from "effect/rpc";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ApprovalClient } from "./approval-client.ts";
import { ApprovalReply } from "./approval-prompt.ts";
import { makeApprovals } from "./approvals.ts";

type Answered = Rpc.Payload<Rpc.ExtractTag<RpcGroup.Rpcs<typeof ApprovalRpcs>, "Approval.answer">>;

/** An approval client whose server shows `pending` and does `answer` with each answer it receives. */
function serverAnswering(
  answer: (payload: Answered) => Effect.Effect<void, NoApprovalWaiting>,
  pending: Stream.Stream<Option.Option<PendingApproval>> = Stream.never,
) {
  const handlers = ApprovalRpcs.toLayer({
    "Approval.pending": () => pending,
    "Approval.answer": answer,
  });

  return Atom.runtime(
    Layer.effect(ApprovalClient, RpcTest.makeClient(ApprovalRpcs, { flatten: true })).pipe(
      Layer.provide(handlers),
    ),
  );
}

const registries: AtomRegistry.AtomRegistry[] = [];

afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
});

const conversation = ConversationId.make("conversation-1");

const shown = {
  approval: ApprovalId.make("approval-1"),
  tool: "run",
  question: "Run `rm notes.txt`?",
} as const;

/** A registry of its own, disposed after the test. */
function registryFor() {
  const registry = AtomRegistry.make();
  registries.push(registry);

  return registry;
}

/** What `approvalAnswer` settles on once nothing is on its way. */
function replyTo(
  registry: AtomRegistry.AtomRegistry,
  approvalAnswer: ReturnType<typeof makeApprovals>["approvalAnswer"],
): Promise<ApprovalReply> {
  return Atom.toStream(approvalAnswer(conversation)).pipe(
    Stream.filter((last) => !last.waiting),
    Stream.map(AsyncResult.value),
    Stream.filter(Option.isSome),
    Stream.runHead,
    Effect.map((reply) => Option.getOrThrow(Option.flatten(reply))),
    Effect.provideService(AtomRegistry.AtomRegistry, registry),
    Effect.runPromise,
  );
}

describe("given a Bot waiting for its person's answer", () => {
  describe("when the page watches the conversation", () => {
    it("shows the question the server says the conversation waits on", async () => {
      const server = serverAnswering(() => Effect.void, Stream.make(Option.some(shown)));
      const { approvalPending } = makeApprovals(server);

      const pending = await Atom.toStream(approvalPending(conversation)).pipe(
        Stream.map(AsyncResult.value),
        Stream.filter(Option.isSome),
        Stream.runHead,
        Effect.provideService(AtomRegistry.AtomRegistry, registryFor()),
        Effect.runPromise,
      );

      expect(Option.flatten(Option.flatten(pending))).toEqual(Option.some(shown));
    });
  });

  describe("when the person answers yes", () => {
    it("hands the server the answer to that question, and says it was taken", async () => {
      const received: Array<Answered> = [];
      const server = serverAnswering((sent) => Effect.sync(() => received.push(sent)));
      const { approvalAnswer } = makeApprovals(server);
      const registry = registryFor();
      registry.mount(approvalAnswer(conversation));

      registry.set(approvalAnswer(conversation), { conversation, pending: shown, answer: "yes" });

      expect(await replyTo(registry, approvalAnswer)).toEqual(
        ApprovalReply.Taken({ approval: shown.approval, question: shown.question, answer: "yes" }),
      );
      expect(received).toEqual([{ conversation, approval: shown.approval, answer: "yes" }]);
    });
  });

  describe("when the server finds the question no longer waiting", () => {
    it("says why", async () => {
      const server = serverAnswering(() =>
        Effect.fail(new NoApprovalWaiting({ message: "The Bot is not waiting for that answer." })),
      );

      const { approvalAnswer } = makeApprovals(server);
      const registry = registryFor();
      registry.mount(approvalAnswer(conversation));

      registry.set(approvalAnswer(conversation), { conversation, pending: shown, answer: "no" });

      expect(await replyTo(registry, approvalAnswer)).toEqual(
        ApprovalReply.Refused({
          approval: shown.approval,
          message: "The Bot is not waiting for that answer.",
        }),
      );
    });
  });
});
