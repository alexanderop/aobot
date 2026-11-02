import { Effect, Layer, Option, type Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AuditRowsPage } from "@aobot/domain";
import { noFilters } from "./audit-filters.ts";
import type { History } from "../../shared/page-history.ts";
import {
  makeAuditTrail,
  makeFilters,
  type TrailUnreadable,
  type TrailView,
  trailView,
} from "./audit-trail.ts";

const row = (id: string) => ({
  id,
  createdAt: "2026-11-02T10:00:00.000Z",
  initiatorKind: "person",
  person: "single-user",
  decision: "deny",
  action: "run",
  detail: {},
});

/**
A server that answers `/audit/rows` with the page each cursor names, `first` for none, as `status` and
`json`, and keeps every query it was asked.
*/
function serverWith(
  pages: Record<string, { readonly status: number; readonly json: Schema.Json }>,
) {
  const asked: Array<string> = [];

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      asked.push(url.search);

      const answer = pages[url.searchParams.get("cursor") ?? "first"] ?? {
        status: 404,
        json: {},
      };

      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(answer.json), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://aobot.test")));

  const { trail } = makeAuditTrail(Atom.runtime(Layer.succeed(HttpClient.HttpClient, client)));

  return { asked, trail };
}

const registries: Array<AtomRegistry.AtomRegistry> = [];

afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
});

/** The view of `trail` once `ready` holds of it. */
function viewWhen(
  registry: AtomRegistry.AtomRegistry,
  trail: Atom.Atom<Atom.PullResult<AuditRowsPage, TrailUnreadable>>,
  ready: (view: TrailView) => boolean,
) {
  return Atom.toStream(trail).pipe(
    Stream.map(trailView),
    Stream.filter(ready),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.provideService(AtomRegistry.AtomRegistry, registry),
    Effect.runPromise,
  );
}

const settled = (view: TrailView) => !view.loading;

/** A registry with `pages` mounted, disposed after the test. */
function mounted(pages: Atom.Atom<Atom.PullResult<AuditRowsPage, TrailUnreadable>>) {
  const registry = AtomRegistry.make();
  registries.push(registry);
  registry.mount(pages);

  return registry;
}

describe("the audit trail", () => {
  it("reads the first page, then each older one as it is asked for, until there is none", async () => {
    const { asked, trail } = serverWith({
      first: { status: 200, json: { rows: [row("a"), row("b")], next: "after-b" } },
      "after-b": { status: 200, json: { rows: [row("c")] } },
    });

    const pages = trail("decision=deny");
    const registry = mounted(pages);

    const first = await viewWhen(registry, pages, settled);
    expect(first.rows.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(first.more).toBe(true);

    registry.set(pages, undefined);

    const all = await viewWhen(registry, pages, (view) => settled(view) && view.rows.length === 3);
    expect(all.rows.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(all.more).toBe(false);
    expect(asked).toEqual(["?decision=deny", "?decision=deny&cursor=after-b"]);
  });

  it("says why a page did not come, keeps the rows before it, and asks for it again", async () => {
    const answers: Parameters<typeof serverWith>[0] = {
      first: { status: 200, json: { rows: [row("a")], next: "after-a" } },
      "after-a": { status: 503, json: { message: "The server is restarting." } },
    };

    const { asked, trail } = serverWith(answers);

    const pages = trail("");
    const registry = mounted(pages);

    await viewWhen(registry, pages, settled);
    registry.set(pages, undefined);

    const failed = await viewWhen(registry, pages, (view) => Option.isSome(view.problem));
    expect(failed.problem).toEqual(Option.some("The server is restarting."));
    expect(failed.rows.map(({ id }) => id)).toEqual(["a"]);
    expect(failed.more).toBe(true);

    answers["after-a"] = { status: 200, json: { rows: [row("b")] } };
    registry.set(pages, undefined);

    const retried = await viewWhen(registry, pages, (view) => settled(view) && asked.length === 3);
    expect(retried.rows.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(retried.problem).toEqual(Option.none());
    expect(asked).toEqual(["", "?cursor=after-a", "?cursor=after-a"]);
  });

  it("shows no rows and nothing more for a trail with none", async () => {
    const { trail } = serverWith({ first: { status: 200, json: { rows: [] } } });

    const pages = trail("bot=operator");
    const registry = mounted(pages);

    expect(await viewWhen(registry, pages, settled)).toEqual({
      rows: [],
      loading: false,
      more: false,
      problem: Option.none(),
    });
  });

  it("reads the trail again from the newest row when it is refreshed", async () => {
    const { asked, trail } = serverWith({
      first: { status: 200, json: { rows: [row("a")], next: "after-a" } },
      "after-a": { status: 200, json: { rows: [row("b")] } },
    });

    const pages = trail("decision=deny");
    const registry = mounted(pages);

    await viewWhen(registry, pages, settled);
    registry.set(pages, undefined);
    await viewWhen(registry, pages, (view) => settled(view) && view.rows.length === 2);

    registry.refresh(pages);

    const again = await viewWhen(registry, pages, (view) => settled(view) && asked.length === 3);
    expect(again.rows.map(({ id }) => id)).toEqual(["a"]);
    expect(asked).toEqual(["?decision=deny", "?decision=deny&cursor=after-a", "?decision=deny"]);
  });
});

/** A browser history that starts at `start`, with Back. */
function historyAt(start: string) {
  const entries = [new URL(start)];
  const listeners = new Set<() => void>();
  let at = 0;

  const history: History = {
    url: () => entries[at] ?? new URL(start),
    push: (url) => {
      entries.splice(at + 1, entries.length, url);
      at += 1;
    },
    onPop: (f) => {
      listeners.add(f);

      return () => listeners.delete(f);
    },
  };

  const back = () => {
    at -= 1;
    listeners.forEach((f) => f());
  };

  return { history, back, length: () => entries.length };
}

describe("the audit page's filters", () => {
  const deny = { ...noFilters, decision: Option.some("deny" as const) };

  function filtersOn(start: string) {
    const browser = historyAt(start);
    const filters = makeFilters(browser.history);
    const registry = AtomRegistry.make();
    registries.push(registry);
    registry.mount(filters);

    return { ...browser, filters, registry };
  }

  it("pushes a history entry for new filters, and Back returns to the filters before", () => {
    const { history, back, length, filters, registry } = filtersOn("http://aobot.test/audit");

    registry.set(filters, deny);

    expect(length()).toBe(2);
    expect(history.url().search).toBe("?decision=deny");
    expect(registry.get(filters)).toEqual(deny);

    back();

    expect(registry.get(filters)).toEqual(noFilters);
  });

  it("pushes nothing for the filters it already shows", () => {
    const { length, filters, registry } = filtersOn("http://aobot.test/audit?decision=deny");

    registry.set(filters, deny);

    expect(length()).toBe(1);
    expect(registry.get(filters)).toEqual(deny);
  });
});
