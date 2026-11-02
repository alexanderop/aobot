import { ApprovalId } from "@aobot/domain";
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

const taken = (approval: ApprovalId) =>
  AsyncResult.success(ApprovalReply.Taken({ approval, question: shown.question, answer: "no" }));

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
    ApprovalPrompt.Asking({ pending: shown, sending: false, problem: Option.none(), ...more }),
  );

describe("approvalPrompt", () => {
  it.each([
    ["shows nothing while nothing is asked", Option.none(), notYet, true, Option.none()],
    ["asks the question the server shows", waits, notYet, true, asking()],
    ["holds the answers while one is on its way", waits, sending, true, asking({ sending: true })],
    [
      "says why the server refused the answer to this question",
      waits,
      refused(shown.approval),
      true,
      asking({ problem: Option.some("The Bot is not waiting for that answer any more.") }),
    ],
    ["forgets a refusal of an earlier question", waits, refused(earlier), true, asking()],
    [
      "says what the person answered, once the server took it",
      Option.none(),
      taken(shown.approval),
      true,
      Option.some(ApprovalPrompt.Answered({ question: shown.question, answer: "no" })),
    ],
    [
      "says what the person answered before the server withdrew the question",
      waits,
      taken(shown.approval),
      true,
      Option.some(ApprovalPrompt.Answered({ question: shown.question, answer: "no" })),
    ],
    ["asks a new question after an earlier answer", waits, taken(earlier), true, asking()],
    [
      "shows nothing once the turn that was answered ended",
      Option.none(),
      taken(shown.approval),
      false,
      Option.none(),
    ],
  ])("%s", (_case, pending, last, running, prompt) => {
    expect(approvalPrompt(pending, last, running)).toEqual(prompt);
  });
});
