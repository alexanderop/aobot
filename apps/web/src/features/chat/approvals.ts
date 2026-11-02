import type { ApprovalAnswer, ConversationId, MessageId } from "@aobot/domain";
import { Effect, type Option, Schedule, Stream } from "effect";
import { Atom } from "effect/reactivity";
import { ApprovalClient } from "./approval-client.ts";
import { type AskedQuestion, ApprovalReply } from "./approval-prompt.ts";

/** A person's answer to the question they were shown in a conversation, during the turn `turn`. */
export interface Choice {
  readonly conversation: ConversationId;
  readonly turn: Option.Option<MessageId>;
  readonly asked: AskedQuestion;
  readonly answer: ApprovalAnswer;
}

/** The approval atoms, over the client `runtime` gives: the server's on the page, a fake one in a test. */
export function makeApprovals(runtime: Atom.AtomRuntime<ApprovalClient>) {
  /** The question a conversation waits on, as the server last said. Watched while the conversation is open. */
  const approvalPending = Atom.family((conversation: ConversationId) =>
    runtime.atom(
      Stream.unwrap(
        ApprovalClient.use((client) =>
          Effect.succeed(client("Approval.pending", { conversation })),
        ),
      ).pipe(Stream.retry(Schedule.spaced("1 second"))),
    ),
  );

  /**
  The person's last answer in a conversation, and what the server said to it. Kept alive, so the card
  shows the answer after it re-renders.
  */
  const approvalAnswer = Atom.family((_conversation: ConversationId) =>
    Atom.keepAlive(
      runtime.fn(
        Effect.fnUntraced(function* ({ conversation, turn, asked, answer }: Choice) {
          const client = yield* ApprovalClient;

          return yield* client("Approval.answer", {
            conversation,
            approval: asked.approval,
            answer,
          }).pipe(
            Effect.match({
              onSuccess: () =>
                ApprovalReply.Taken({
                  approval: asked.approval,
                  turn,
                  question: asked.question,
                  answer,
                }),
              onFailure: ({ message }) =>
                ApprovalReply.Refused({ approval: asked.approval, message }),
            }),
          );
        }),
      ),
    ),
  );

  return { approvalPending, approvalAnswer };
}

/** The page's approval atoms, over its RPC socket. */
export const { approvalPending, approvalAnswer } = makeApprovals(ApprovalClient.runtime);
