import { Effect } from "effect";
import { botToolkit } from "../bots/public.ts";
import { Gateway } from "./gateway.ts";

/** The handlers of every Bot tool: each one is a gateway call, whichever runtime asked. */
export const botToolHandlers = botToolkit.toLayer(
  Effect.gen(function* () {
    const gateway = yield* Gateway;

    return {
      navigate: ({ url }) => gateway.act({ action: "navigate", url }),
      snapshot: () => gateway.act({ action: "snapshot" }),
    };
  }),
);
