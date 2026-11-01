import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { Duration, Effect, Schema } from "effect";

/** Xvfb did not give the browser a display to draw on. */
export class DisplayUnavailable extends Schema.TaggedError<DisplayUnavailable>()(
  "DisplayUnavailable",
  {
    message: Schema.String,
  },
) {}

/**
An X display for a headed Chromium, for as long as the scope lasts. Bot checks spot headless browsers, so
the browser draws into this in-container X server instead and nothing appears anywhere.

`-displayfd 3` makes Xvfb pick a free display and write its number to fd 3 only once it accepts clients,
so neither a stale socket nor another X server can pass for ready.
*/
export const virtualDisplay = Effect.acquireRelease(
  Effect.suspend(() => {
    const child = spawn(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
      { stdio: ["ignore", "ignore", "inherit", "pipe"] },
    );

    // SAFETY: fd 3 is declared as "pipe" above, so Node opens it as a readable stream.
    const displayFd = child.stdio[3] as Readable;

    return Effect.callback<string, DisplayUnavailable>((resume) => {
      let written = "";
      displayFd.setEncoding("utf8");
      displayFd.on("data", (chunk: string) => {
        written += chunk;

        if (!written.includes("\n")) return;

        const number = written.trim();
        resume(
          /^\d+$/u.test(number)
            ? Effect.succeed(`:${number}`)
            : Effect.fail(new DisplayUnavailable({ message: "Xvfb wrote no display number." })),
        );
      });
      child.once("error", (error) =>
        resume(
          Effect.fail(new DisplayUnavailable({ message: `Xvfb did not start: ${error.message}` })),
        ),
      );
      child.once("exit", (code) =>
        resume(Effect.fail(new DisplayUnavailable({ message: `Xvfb exited with ${code}.` }))),
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(5),
        orElse: () => Effect.fail(new DisplayUnavailable({ message: "Xvfb was not ready in 5s." })),
      }),
      Effect.tapError(() => Effect.sync(() => child.kill("SIGKILL"))),
      Effect.map((name) => ({ name, child })),
    );
  }),
  ({ child }) =>
    Effect.callback<void>((resume) => {
      if (child.exitCode !== null) return resume(Effect.void);

      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.once("exit", () => {
        clearTimeout(force);
        resume(Effect.void);
      });
      child.kill("SIGTERM");
    }),
).pipe(Effect.map(({ name }) => name));
