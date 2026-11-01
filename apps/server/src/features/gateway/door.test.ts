import { Control } from "@aobot/domain";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { close, Door, drained, enter, leave, reopen, view } from "./door.ts";

const since = DateTime.makeUnsafe("2026-11-01T09:00:00Z");

const open = (inFlight: number) => Door.Open({ inFlight });

const closing = (inFlight: number) => Door.Closing({ inFlight });

const held = Door.Held({ since });

describe("a Bot's door", () => {
  it.each([
    ["open and idle", "admitted", open(0), open(1)],
    ["open with an action running", "admitted", open(2), open(3)],
    ["closing", "refused", closing(1), closing(1)],
    ["closing and drained", "refused", closing(0), closing(0)],
    ["held by a person", "refused", held, held],
  ] as const)("when %s, an action is %s", (_, admission, door, after) => {
    expect(enter(door)).toEqual([admission, after]);
  });

  it("counts an admitted action out again, open or closing", () => {
    expect(leave(open(1))).toEqual(open(0));
    expect(leave(closing(2))).toEqual(closing(1));
  });

  it("enters then leaves back to where it was", () => {
    const [, entered] = enter(open(0));

    expect(leave(entered)).toEqual(open(0));
  });

  it("closes on new actions, keeping count of those already inside", () => {
    expect(close(open(2))).toEqual(closing(2));
  });

  it("reopens a take that could not be stored, with its actions still counted", () => {
    expect(reopen(closing(1))).toEqual(open(1));
  });

  it("is drained only once closing with nothing left inside", () => {
    expect(drained(closing(0))).toBe(true);
    expect(drained(closing(1))).toBe(false);
  });

  it("shows the page who holds the computer, and how many actions a take waits for", () => {
    expect(view(open(3))).toEqual(Control.cases.Bot.make({}));
    expect(view(closing(2))).toEqual(Control.cases.Taking.make({ waitingFor: 2 }));
    expect(view(held)).toEqual(Control.cases.Person.make({ since }));
  });
});
