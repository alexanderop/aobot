import { Effect } from "effect";
import { assistant, botToolkit } from "../bots/public.ts";
import { Gateway } from "./gateway.ts";

/**
The handlers of every Bot tool: each one is a gateway call, whichever runtime asked. Assistant is the
only Bot until E2-1, so every call is its own.
*/
export const botToolHandlers = botToolkit.toLayer(
  Effect.gen(function* () {
    const gateway = yield* Gateway;

    return {
      navigate: ({ url }) => gateway.act(assistant.id, { action: "navigate", url }),
      snapshot: () => gateway.act(assistant.id, { action: "snapshot" }),
      click: ({ ref }) => gateway.act(assistant.id, { action: "click", ref }),
      type: ({ ref, text }) => gateway.act(assistant.id, { action: "type", ref, text }),
      run: ({ command }) => gateway.act(assistant.id, { action: "run", command }),
      read_file: ({ path }) => gateway.act(assistant.id, { action: "read_file", path }),
      write_file: ({ path, contents }) =>
        gateway.act(assistant.id, { action: "write_file", path, contents }),
      list_files: ({ path }) => gateway.act(assistant.id, { action: "list_files", path }),
    };
  }),
);
