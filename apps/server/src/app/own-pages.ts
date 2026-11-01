import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/** The names this machine answers to on itself. */
const loopbackNames: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
What a browser says of where a request came from in `Sec-Fetch-Site`, when it is no other site: the
page itself, or a person who typed the address or opened a bookmark.
*/
const ownSites: ReadonlySet<string> = new Set(["same-origin", "none"]);

/** The name in a `Host` header, lower-cased and without its port, or none when it is not one. */
function hostname(host: string): Option.Option<string> {
  return URL.canParse(`http://${host}`)
    ? Option.some(new URL(`http://${host}`).hostname)
    : Option.none();
}

/**
Whether `request` came from a page this server served, or from no page at all. The host it was sent to
must be this machine or `publicHost`, whatever else it says: a browser sends no `Origin` with a same-origin
`GET`, so a site that points its own name at this machine reads a file with nothing but `Host` naming it.
A page's `Origin` must then name that same host. A browser sends no `Origin` with a link or an `<img>`
another site points here, but it does send `Sec-Fetch-Site`, which must then not name another site.
*/
function fromOwnPage(
  request: HttpServerRequest.HttpServerRequest,
  publicHost: Option.Option<string>,
): boolean {
  const site = Option.fromNullishOr(request.headers["sec-fetch-site"]);

  if (Option.exists(site, (value) => !ownSites.has(value))) return false;

  const host = Option.fromNullishOr(request.headers["host"]).pipe(
    Option.map((value) => value.toLowerCase()),
  );

  const reachable = Option.exists(
    Option.flatMap(host, hostname),
    (name) =>
      loopbackNames.has(name) ||
      Option.exists(publicHost, (expected) => expected.toLowerCase() === name),
  );

  if (!reachable) return false;

  return Option.match(Option.fromNullishOr(request.headers["origin"]), {
    onNone: () => true,
    onSome: (origin) => URL.canParse(origin) && Option.contains(host, new URL(origin).host),
  });
}

/**
Refuses with 403 a request from a page that is not this server's own. A browser lets any page send a
request to any address, and names the page in `Origin`. Without this, any site the person visits could take
their Bot's computer, click on it, or put files in its workspace. `Origin` and `Host` alone agree on a site
that points its own name at this machine (DNS rebinding), so the host must always be one this server is
meant to be reached at, with an `Origin` or without.
*/
export const ownPagesOnly = (publicHost: Option.Option<string>) =>
  HttpRouter.middleware((handle) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      fromOwnPage(request, publicHost)
        ? handle
        : Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    ),
  );
