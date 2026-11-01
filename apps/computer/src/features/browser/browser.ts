import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerAction, type ComputerActResult, snapshotLimit } from "@aobot/domain";
import { chromium, type BrowserContext, type Page } from "playwright";
import { Context, Effect, Layer, Option, Ref, Semaphore } from "effect";
import { checkNavigation, Destinations } from "./destinations.ts";
import { refusedHeader, startEgressProxy } from "./egress.ts";
import { ActionFailed, ActionRefused } from "./errors.ts";
import { capSnapshot } from "./snapshot.ts";
import { virtualDisplay } from "./virtual-display.ts";

/** The computer's browser: one Chromium with one page, driven one action at a time. */
export class Browser extends Context.Service<
  Browser,
  {
    readonly act: (
      action: ComputerAction,
    ) => Effect.Effect<ComputerActResult, ActionRefused | ActionFailed>;
  }
>()("aobot/computer/browser/Browser") {}

const navigationTimeoutMs = 30_000;

const snapshotTimeoutMs = 10_000;

function playwright<A>(what: string, run: () => Promise<A>): Effect.Effect<A, ActionFailed> {
  return Effect.tryPromise({
    try: run,
    catch: (error) =>
      new ActionFailed({
        message: `${what} failed: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
      }),
  });
}

/** The page as the Bot reads it after any action: its address, title and capped snapshot. */
const readPage = Effect.fn("Browser.readPage")(function* (current: Page) {
  const tree = yield* playwright("Reading the page", () =>
    current.ariaSnapshot({ mode: "ai", timeout: snapshotTimeoutMs }),
  );

  const title = yield* playwright("Reading the title", () => current.title());

  return { url: current.url(), title, ...capSnapshot(tree, snapshotLimit) };
});

/** The page actions run in. A page the site closed is replaced, so the next action still has one. */
function currentPage(context: BrowserContext, page: Ref.Ref<Page>) {
  return Effect.gen(function* () {
    const current = yield* Ref.get(page);

    if (!current.isClosed()) return current;

    const fresh = yield* playwright("Opening a page", () => context.newPage());
    yield* Ref.set(page, fresh);

    return fresh;
  });
}

/**
{@link Browser}: a headed Chromium on its own X display whose only route out is the egress proxy. It is
given only `DISPLAY` and `HOME`, never this process's environment, so a page exploit finds no token.
*/
export const browserLayer = (home: string) =>
  Layer.effect(
    Browser,
    Effect.gen(function* () {
      const destinations = yield* Destinations;
      const display = yield* virtualDisplay;
      const proxy = yield* startEgressProxy;

      const profile = yield* playwright("Creating a profile", () =>
        mkdtemp(join(tmpdir(), "aobot-browser-")),
      );

      const context = yield* Effect.acquireRelease(
        playwright("Launching Chromium", () =>
          chromium.launchPersistentContext(profile, {
            headless: false,
            env: { DISPLAY: display, HOME: home },
            proxy,
            viewport: { width: 1280, height: 800 },
            // `--enable-automation` sets `navigator.webdriver`, which bot checks read first.
            ignoreDefaultArgs: ["--enable-automation"],
            // WebRTC would otherwise send UDP around the proxy.
            args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
          }),
        ),
        (context) => Effect.promise(() => context.close()),
      );

      const first =
        context.pages()[0] ?? (yield* playwright("Opening a page", () => context.newPage()));

      const page = yield* Ref.make(first);
      const oneAtATime = yield* Semaphore.make(1);

      const navigate = Effect.fn("Browser.navigate")(function* (url: string) {
        const target = yield* checkNavigation(url).pipe(
          Effect.provideService(Destinations, destinations),
        );

        const current = yield* currentPage(context, page);

        const response = yield* playwright("Opening the page", () =>
          current.goto(target.href, {
            waitUntil: "domcontentloaded",
            timeout: navigationTimeoutMs,
          }),
        );

        // A redirect can lead somewhere the first check never saw. The proxy refuses it, and its answer
        // must not pass for the page.
        const refusal = Option.filter(
          Option.fromNullishOr(response),
          (answer) => answer.headers()[refusedHeader] === "refused",
        );

        if (Option.isSome(refusal)) {
          const message = yield* playwright("Reading the refusal", () => refusal.value.text());

          return yield* new ActionRefused({ message });
        }

        return yield* readPage(current);
      });

      const act = (action: ComputerAction) =>
        oneAtATime.withPermits(1)(
          ComputerAction.match(action, {
            navigate: ({ url }) => navigate(url),
            snapshot: () => Effect.flatMap(currentPage(context, page), readPage),
          }).pipe(Effect.map((read): ComputerActResult => ({ action: action.action, ...read }))),
        );

      return Browser.of({ act });
    }),
  );
