import { ApprovalId, MessageId } from "@aobot/domain";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { ApprovalPrompt, approvalPrompt, ApprovalReply } from "./approval-prompt.ts";

const shown = {
  approval: ApprovalId.make("approval-1"),
  tool: "run",
  question: "Run `rm notes.txt`?",
} as const;

const waits = Option.some(shown);

const notYet = AsyncResult.initial<ApprovalReply>();

const sending = AsyncResult.initial<ApprovalReply>(true);

const thisTurn = Option.some(MessageId.make("message-1"));

const nextTurn = Option.some(MessageId.make("message-2"));

const noTurn = Option.none<MessageId>();

const taken = (approval: ApprovalId) =>
  AsyncResult.success(
    ApprovalReply.Taken({ approval, turn: thisTurn, question: shown.question, answer: "no" }),
  );

const refused = (approval: ApprovalId) =>
  AsyncResult.success(
    ApprovalReply.Refused({
      approval,
      message: "The Bot is not waiting for that answer any more.",
    }),
  );

const earlier = ApprovalId.make("approval-0");

const asking = (more: Partial<{ sending: boolean; problem: Option.Option<string> }> = {}) =>
  Option.some(
    ApprovalPrompt.Asking({
      approval: shown.approval,
      question: shown.question,
      sending: false,
      problem: Option.none(),
      ...more,
    }),
  );

const answeredNo = Option.some(
  ApprovalPrompt.Answered({ approval: shown.approval, question: shown.question, answer: "no" }),
);

describe("approvalPrompt", () => {
  it.each([
    ["shows nothing while nothing is asked", Option.none(), notYet, thisTurn, Option.none()],
    ["asks the question the server shows", waits, notYet, thisTurn, asking()],
    [
      "holds the answers while one is on its way",
      waits,
      sending,
      thisTurn,
      asking({ sending: true }),
    ],
    [
      "says why the server refused the answer to this question",
      waits,
      refused(shown.approval),
      thisTurn,
      asking({ problem: Option.some("The Bot is not waiting for that answer any more.") }),
    ],
    ["forgets a refusal of an earlier question", waits, refused(earlier), thisTurn, asking()],
    [
      "says what the person answered, once the server took it",
      Option.none(),
      taken(shown.approval),
      thisTurn,
      answeredNo,
    ],
    [
      "says what the person answered before the server withdrew the question",
      waits,
      taken(shown.approval),
      thisTurn,
      answeredNo,
    ],
    ["asks a new question after an earlier answer", waits, taken(earlier), thisTurn, asking()],
    [
      "shows nothing once the turn that was answered ended",
      Option.none(),
      taken(shown.approval),
      noTurn,
      Option.none(),
    ],
    [
      "shows nothing in the person's next turn until it asks something",
      Option.none(),
      taken(shown.approval),
      nextTurn,
      Option.none(),
    ],
  ])("%s", (_case, pending, last, turn, prompt) => {
    expect(approvalPrompt(pending, last, turn)).toEqual(prompt);
  });
});
