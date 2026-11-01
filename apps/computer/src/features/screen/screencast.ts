import { ScreenFrame } from "@aobot/domain";
import { Effect, Queue, Schema, Stream } from "effect";
import { failureMessage, type WatchedPage } from "../browser/public.ts";

/** Chromium could not start a screencast on a page. Says nothing about what was on it. */
export class ScreencastFailed extends Schema.TaggedError<ScreencastFailed>()("ScreencastFailed", {
  message: Schema.String,
}) {}

/** The frames of `page` until it closes. Whether it has closed is asked on every run, so on every retry. */
export function pageFrames(page: WatchedPage): Stream.Stream<ScreenFrame, ScreencastFailed> {
  return Stream.suspend(() => {
    if (page.isClosed()) return Stream.empty;

    return Stream.callback<ScreenFrame, ScreencastFailed>(
      (queue) =>
        Effect.gen(function* () {
          const removeListener = page.onClose(() => Queue.endUnsafe(queue));
          yield* Effect.addFinalizer(() => Effect.sync(removeListener));

          yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                page.startScreencast((jpeg) =>
                  Queue.offerUnsafe(queue, ScreenFrame.make({ jpeg })),
                ),
              catch: (error) =>
                new ScreencastFailed({ message: failureMessage("Starting the screencast", error) }),
            }),
            (stop) => Effect.promise(stop),
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );
  });
}
