import { Screen } from "@aobot/domain";
import { Effect, Option, Schedule, Stream } from "effect";
import { ScreenClient } from "./screen-client.ts";

/**
The Bot's screen as an image src, or none while it is blank. Not kept alive on purpose: the watch runs only
while a component reads the atom, so folding the panel ends it and the server can let go of the computer's
screen. Not `ScreenClient.query`, whose result keeps every frame.
*/
export const liveScreen = ScreenClient.runtime.atom(
  Stream.unwrap(
    ScreenClient.use((client) => Effect.succeed(client("Screen.watch", undefined))),
  ).pipe(
    Stream.map(
      Screen.match({
        Blank: () => Option.none<string>(),
        Frame: ({ jpeg }) => Option.some(`data:image/jpeg;base64,${jpeg}`),
      }),
    ),
    Stream.retry(Schedule.spaced("1 second")),
  ),
);
