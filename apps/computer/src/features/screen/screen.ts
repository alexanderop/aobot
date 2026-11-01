import type { ScreenFrame } from "@aobot/domain";
import { Context, Effect, Layer, Schedule, Stream } from "effect";
import { Browser } from "../browser/public.ts";
import { pageFrames } from "./screencast.ts";

/** The computer's screen, shared by however many `/stream` connections there are. */
export class Screencast extends Context.Service<
  Screencast,
  {
    /**
    The Bot's page as Chromium paints it, the latest frame first, following the browser to a new page when
    it replaces a closed one. One screencast runs while anyone reads this, and none while nobody does.
    */
    readonly frames: Stream.Stream<ScreenFrame>;
  }
>()("aobot/computer/screen/Screencast") {}

/** {@link Screencast} over the browser's pages. */
export const screencastLayer = Layer.effect(
  Screencast,
  Effect.gen(function* () {
    const browser = yield* Browser;

    const frames = yield* browser.pages.pipe(
      Stream.switchMap((page) =>
        pageFrames(page).pipe(
          Stream.tapError(({ message }) =>
            Effect.logWarning("The screencast stopped").pipe(
              Effect.annotateLogs({ reason: message }),
            ),
          ),
          Stream.retry(Schedule.spaced("1 second")),
          Stream.orDie,
        ),
      ),
      Stream.share({ capacity: 1, strategy: "sliding", replay: 1 }),
    );

    return Screencast.of({ frames });
  }),
);
