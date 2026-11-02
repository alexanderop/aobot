import { SecretRequestId } from "@aobot/domain";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { ToolCallStatus } from "./conversation-state.ts";
import { SecretEntry, secretEntry, SecretReply } from "./secret-entry.ts";

const running = ToolCallStatus.Running();

const done = ToolCallStatus.Done({ result: "Your person typed it." });

const failed = ToolCallStatus.Failed({ result: "Your person did not answer within 10m." });

const notYet = AsyncResult.initial<SecretReply>();

const taken = (answer: "Supplied" | "Declined") =>
  AsyncResult.success(SecretReply.Taken({ answer }));

const refused = AsyncResult.success(
  SecretReply.Refused({ message: "The Bot is not waiting for a secret any more." }),
);

const shown = {
  request: SecretRequestId.make("request-1"),
  field: "the password",
  host: "shop.example",
};

const waits = Option.some(shown);

describe("secretEntry", () => {
  it.each([
    [
      "opens while the server shows no request yet",
      running,
      Option.none(),
      notYet,
      SecretEntry.Opening(),
    ],
    [
      "asks for the request the server shows while the Bot waits",
      running,
      waits,
      notYet,
      SecretEntry.Asking({ request: shown, sending: false, problem: Option.none() }),
    ],
    [
      "holds the buttons while the answer is on its way",
      running,
      waits,
      AsyncResult.initial<SecretReply>(true),
      SecretEntry.Asking({ request: shown, sending: true, problem: Option.none() }),
    ],
    [
      "says why the server refused the last answer, while the Bot still waits",
      running,
      waits,
      refused,
      SecretEntry.Asking({
        request: shown,
        sending: false,
        problem: Option.some("The Bot is not waiting for a secret any more."),
      }),
    ],
    [
      "says it was supplied before the Bot's call ends",
      running,
      Option.none(),
      taken("Supplied"),
      SecretEntry.Answered({ answer: "Supplied" }),
    ],
    [
      "says it was supplied once the call is done",
      done,
      Option.none(),
      taken("Supplied"),
      SecretEntry.Answered({ answer: "Supplied" }),
    ],
    [
      "says it was not typed when the call failed after the person supplied it",
      ToolCallStatus.Failed({ result: "a person has control of your computer now" }),
      Option.none(),
      taken("Supplied"),
      SecretEntry.NotTyped(),
    ],
    [
      "says it was declined",
      failed,
      Option.none(),
      taken("Declined"),
      SecretEntry.Answered({ answer: "Declined" }),
    ],
    ["ends without an answer from this page", failed, Option.none(), notYet, SecretEntry.Ended()],
    ["ends when the answer came too late", failed, Option.none(), refused, SecretEntry.Ended()],
    [
      "ends when its run ended without a result",
      ToolCallStatus.Unfinished(),
      waits,
      notYet,
      SecretEntry.Ended(),
    ],
  ])("%s", (_, status, pending, last, entry) => {
    expect(secretEntry(status, pending, last)).toEqual(entry);
  });
});
