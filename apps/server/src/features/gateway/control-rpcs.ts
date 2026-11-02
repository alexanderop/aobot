import { ControlRpcs, PersonInput } from "@aobot/domain";
import { Effect } from "effect";
import { ComputerControl } from "./control.ts";

/** The `Control.*` handlers: a person taking the computer, clicking on its screen and handing it back. */
export const controlHandlers = ControlRpcs.toLayer(
  Effect.gen(function* () {
    const control = yield* ComputerControl;

    return ControlRpcs.of({
      "Control.watch": () => control.watch,
      "Control.take": () => control.take,
      "Control.handBack": () => control.handBack,
      "Control.click": (at) => control.input(PersonInput.cases.Click.make({ at })),
    });
  }),
);
