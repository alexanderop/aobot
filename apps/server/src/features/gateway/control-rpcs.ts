import { ControlRpcs, PersonInput } from "@aobot/domain";
import { Effect } from "effect";
import { assistant } from "../bots/public.ts";
import { ComputerControl } from "./control.ts";

/**
The `Control.*` handlers: a person taking the Bot's computer, clicking on its screen and handing it back.
Assistant is the only Bot until E2-1, so every call is about its computer.
*/
export const controlHandlers = ControlRpcs.toLayer(
  Effect.gen(function* () {
    const control = yield* ComputerControl;

    return ControlRpcs.of({
      "Control.watch": () => control.watch(assistant.id),
      "Control.take": () => control.take(assistant.id),
      "Control.handBack": () => control.handBack(assistant.id),
      "Control.click": (at) => control.input(assistant.id, PersonInput.cases.Click.make({ at })),
    });
  }),
);
