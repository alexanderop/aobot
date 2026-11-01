import { ScreenRpcs } from "@aobot/domain";
import { Effect } from "effect";
import { Computers } from "../computers/public.ts";

/** `Screen.watch`: a person watching their Bot's computer. Watching asks the computer to do nothing, so nothing is audited. */
export const screenHandlers = ScreenRpcs.toLayer(
  Effect.gen(function* () {
    const computers = yield* Computers;

    return ScreenRpcs.of({ "Screen.watch": () => computers.screen });
  }),
);
