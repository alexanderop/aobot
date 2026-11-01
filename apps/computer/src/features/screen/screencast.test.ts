import { describe, expect, it } from "vite-plus/test";
import { Effect, Schedule, Stream } from "effect";
import type { WatchedPage } from "../browser/public.ts";
import { pageFrames } from "./screencast.ts";

describe("pageFrames", () => {
  it("ends without starting again once the page closed while its screencast failed to start", async () => {
    let closed = false;
    let starts = 0;

    const page: WatchedPage = {
      isClosed: () => closed,
      onClose: () => () => undefined,
      startScreencast: async () => {
        starts += 1;
        closed = true;
        throw new Error("Target closed");
      },
    };

    await Effect.runPromise(
      pageFrames(page).pipe(Stream.retry(Schedule.recurs(3)), Stream.runDrain),
    );

    expect(starts).toBe(1);
  });
});
