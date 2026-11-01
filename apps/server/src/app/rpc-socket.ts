import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcServer } from "effect/rpc";

/** The names this machine answers to on itself. */
const loopbackNames: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
Whether `request` came from a page this server served, or from no page at all. A page's `Origin` must name
the host the request was sent to, and that host must be this machine or `publicHost`.
*/
function fromOwnPage(
  request: HttpServerRequest.HttpServerRequest,
  publicHost: Option.Option<string>,
): boolean {
  return Option.match(Option.fromNullishOr(request.headers["origin"]), {
    onNone: () => true,
    onSome: (origin) => {
      if (!URL.canParse(origin)) return false;

      const page = new URL(origin);

      return (
        page.host === request.headers["host"]?.toLowerCase() &&
        (loopbackNames.has(page.hostname) ||
          Option.exists(publicHost, (host) => host.toLowerCase() === page.hostname))
      );
    },
  });
}

/**
A browser lets any page open a WebSocket to any address, and names the page in `Origin`. Without this, any
site the person visits could take their Bot's computer and click on it. `Origin` and `Host` alone agree on
a site that points its own name at this machine (DNS rebinding), so the host must also be one this server
is meant to be reached at.
*/
const ownPagesOnly = (publicHost: Option.Option<string>) =>
  HttpRouter.middleware((handle) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      fromOwnPage(request, publicHost)
        ? handle
        : Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    ),
  );

/**
The page's RPC socket at `/rpc`. An upgrade from a page that is not on this machine or at `publicHost` is
refused with 403 before any RPC.
*/
export const rpcSocket = (publicHost: Option.Option<string>) =>
  RpcServer.layerProtocolWebsocket({ path: "/rpc" }).pipe(
    Layer.provide(ownPagesOnly(publicHost).layer),
  );
