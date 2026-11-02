import { Context, Effect } from "effect";
import { botToolkit } from "../bots/public.ts";
import { type BotRequest, Claim, Gateway } from "./gateway.ts";

/**
The Bot whose turn a tool call belongs to. The `api` runtime provides it around each turn and the gateway's
MCP server from the header the `acp` runtime sends. A call that names no Bot is refused like one whose
Bot was not granted the tool, so the default grants nothing.
*/
export const ActingBot = Context.Reference<Claim>("aobot/gateway/ActingBot", {
  defaultValue: () => Claim.cases.Unnamed.make({}),
});

/** The handlers of every Bot tool: each one is a gateway call on behalf of the {@link ActingBot}. */
export const botToolHandlers = botToolkit.toLayer(
  Effect.gen(function* () {
    const gateway = yield* Gateway;

    const act = Effect.fnUntraced(function* (request: BotRequest) {
      return yield* gateway.act(yield* ActingBot, request);
    });

    return {
      navigate: ({ url }) => act({ action: "navigate", url }),
      snapshot: () => act({ action: "snapshot" }),
      click: ({ ref }) => act({ action: "click", ref }),
      type: ({ ref, text }) => act({ action: "type", ref, text }),
      run: ({ command }) => act({ action: "run", command }),
      read_file: ({ path }) => act({ action: "read_file", path }),
      write_file: ({ path, contents }) => act({ action: "write_file", path, contents }),
      list_files: ({ path }) => act({ action: "list_files", path }),
    };
  }),
);
