import { Control } from "@aobot/domain";
import { Data, type DateTime } from "effect";

/**
The door a Bot's actions go through, one per Bot. `Open` while the Bot holds its computer, with the
actions it let in still running. `Closing` once a person starts taking control: nothing new gets in, and
the take waits for `inFlight` to reach 0. `Held` while the person holds it; nothing of the Bot's runs then.
*/
export type Door = Data.TaggedEnum<{
  Open: { readonly inFlight: number };
  Closing: { readonly inFlight: number };
  Held: { readonly since: DateTime.Utc };
}>;

/** Constructors and matchers for {@link Door}. */
export const Door = Data.taggedEnum<Door>();

/** Whether a Bot action was let in, and so must {@link leave} once it is done. */
export type Admission = "admitted" | "refused";

/** A Bot action asks to go through. Only an open door lets it in, whatever the action is. */
export function enter(door: Door): readonly [Admission, Door] {
  return Door.$match(door, {
    Open: ({ inFlight }) => ["admitted", Door.Open({ inFlight: inFlight + 1 })] as const,
    Closing: () => ["refused", door] as const,
    Held: () => ["refused", door] as const,
  });
}

/** An admitted action is done. A door that is `Held` has none left to finish. */
export function leave(door: Door): Door {
  return Door.$match(door, {
    Open: ({ inFlight }) => Door.Open({ inFlight: inFlight - 1 }),
    Closing: ({ inFlight }) => Door.Closing({ inFlight: inFlight - 1 }),
    Held: () => door,
  });
}

/** A person starts taking control: the door shuts on new actions and keeps count of those inside. */
export function close(door: Door): Door {
  return Door.$is("Open")(door) ? Door.Closing({ inFlight: door.inFlight }) : door;
}

/** The take could not be stored, so the Bot keeps its computer, with what it let in still running. */
export function reopen(door: Door): Door {
  return Door.$is("Closing")(door) ? Door.Open({ inFlight: door.inFlight }) : door;
}

/** How many admitted actions are still running. */
export function inFlight(door: Door): number {
  return Door.$match(door, {
    Open: ({ inFlight }) => inFlight,
    Closing: ({ inFlight }) => inFlight,
    Held: () => 0,
  });
}

/** Whether every action admitted before the door closed is done, so the person may have the screen. */
export function drained(door: Door): boolean {
  return Door.$is("Closing")(door) && inFlight(door) === 0;
}

/** Who holds the computer, as the page is shown it. */
export function view(door: Door): Control {
  return Door.$match(door, {
    Open: () => Control.cases.Bot.make({}),
    Closing: ({ inFlight }) => Control.cases.Taking.make({ waitingFor: inFlight }),
    Held: ({ since }) => Control.cases.Person.make({ since }),
  });
}
