import { Effect } from "effect";
import { Destinations } from "../egress/public.ts";
import { ActionFailed, ActionRefused } from "./errors.ts";

const webSchemes = new Set(["http:", "https:"]);

/** The address a Bot asked to open, if the browser may open it: a web address on a host it may reach. */
export const checkNavigation = Effect.fn("Browser.checkNavigation")(function* (raw: string) {
  const destinations = yield* Destinations;

  const url = yield* Effect.try({
    try: () => new URL(raw),
    catch: () => new ActionRefused({ message: "That is not a web address." }),
  });

  if (!webSchemes.has(url.protocol)) {
    return yield* new ActionRefused({
      message: `Only http and https addresses open, and that one is ${url.protocol.slice(0, -1)}.`,
    });
  }

  yield* destinations.check(url.hostname).pipe(
    Effect.catchTags({
      DestinationRefused: ({ message }) => Effect.fail(new ActionRefused({ message })),
      DestinationUnreachable: ({ message }) => Effect.fail(new ActionFailed({ message })),
    }),
  );

  return url;
});
