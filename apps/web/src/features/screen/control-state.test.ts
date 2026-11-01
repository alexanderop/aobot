import { Control } from "@aobot/domain";
import { DateTime, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { type Answered, panelOpen, problem } from "./control-state.ts";

const bot = Control.cases.Bot.make({});

const taking = Control.cases.Taking.make({ waitingFor: 1 });

const person = Control.cases.Person.make({ since: DateTime.makeUnsafe("2026-11-01T09:00:00Z") });

function failed(
  sentWhile: Control["_tag"],
  _tag: "ControlNotChanged" | "ComputerNotStarted" | "InputFailed",
  message: string,
): AsyncResult.AsyncResult<Answered> {
  return AsyncResult.success({ sentWhile, failure: Option.some({ _tag, message }) });
}

const takeNotStored = failed("Bot", "ControlNotChanged", "Control did not change.");

describe("the problem the panel shows", () => {
  it("is none before any command, and none for one that worked", () => {
    expect(problem(bot, AsyncResult.initial())).toEqual(Option.none());
    expect(
      problem(person, AsyncResult.success({ sentWhile: "Bot", failure: Option.none() })),
    ).toEqual(Option.none());
  });

  it("is a failed take's reason while the Bot still holds the computer", () => {
    expect(problem(bot, takeNotStored)).toEqual(Option.some("Control did not change."));
  });

  it("is past once the computer changed hands since the failure", () => {
    expect(problem(person, takeNotStored)).toEqual(Option.none());
    expect(problem(taking, takeNotStored)).toEqual(Option.none());
  });

  it("is a failed click's reason while the person holds the computer, and past once they hand back", () => {
    const clickFailed = failed("Person", "InputFailed", "No computer is running.");

    expect(problem(person, clickFailed)).toEqual(Option.some("No computer is running."));
    expect(problem(bot, clickFailed)).toEqual(Option.none());
  });

  it("is a take's failure to start the computer, while the person holds it", () => {
    const notStarted = failed("Bot", "ComputerNotStarted", "The computer could not be started.");

    expect(problem(person, notStarted)).toEqual(Option.some("The computer could not be started."));
    expect(problem(bot, notStarted)).toEqual(Option.none());
  });

  it("is none while the next command is on its way, so the last one's failure goes with it", () => {
    expect(problem(bot, AsyncResult.waitingFrom(Option.some(takeNotStored)))).toEqual(
      Option.none(),
    );
  });
});

describe("the panel", () => {
  it.each([
    ["open", "the Bot uses its computer this turn", true, bot, Option.none()],
    ["open", "a person takes the computer", false, taking, Option.none()],
    ["open", "a person holds it", false, person, Option.none()],
    ["open", "a take from the rail failed", false, bot, Option.some("Control did not change.")],
    ["folded", "the Bot holds an idle computer", false, bot, Option.none()],
  ] as const)("is %s while %s", (state, _, usesComputer, control, shown) => {
    expect(panelOpen(usesComputer, control, shown)).toBe(state === "open");
  });
});
