import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, connect, isIP, type Socket } from "node:net";
import { tokensMatch } from "@aobot/domain";
import { Data, Effect, Option } from "effect";
import { Destinations } from "./destinations.ts";

/** Where a proxied request wants to go. */
export interface EgressTarget {
  readonly host: string;
  readonly port: number;
}

/** What the egress proxy does with one request. */
export type EgressDecision = Data.TaggedEnum<{
  /** Ask for the proxy credentials: the caller sent none, or the wrong ones. */
  Challenge: {};
  /** Never connect, and say why. */
  Refuse: { readonly reason: string };
  /** The checks passed, but the host could not be reached. */
  Fail: { readonly reason: string };
  /** Connect to one of these checked addresses, and nothing else. */
  Connect: { readonly port: number; readonly addresses: ReadonlyArray<string> };
}>;

/** Constructors and the exhaustive matcher for {@link EgressDecision}. */
export const EgressDecision = Data.taggedEnum<EgressDecision>();

/** The user name the browser offers the proxy. Only the password, a per-process secret, is checked. */
export const proxyUser = "computer";

/** The password in a `Proxy-Authorization: Basic …` header, if it is one. */
function offeredPassword(header: string): Option.Option<string> {
  const match = /^Basic\s+(\S+)$/iu.exec(header.trim());

  if (match === null) return Option.none();

  const decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
  const colon = decoded.indexOf(":");

  return colon < 0 ? Option.none() : Option.some(decoded.slice(colon + 1));
}

/**
Decide one proxied request: the right credentials, then a target the caller may reach. `secret` is none
for a listener that asks for no credentials. `target` is none when the request did not name one the proxy
can read.
*/
export const decideEgress = Effect.fn("Egress.decide")(function* (
  secret: Option.Option<string>,
  proxyAuthorization: Option.Option<string>,
  target: Option.Option<EgressTarget>,
) {
  const authorised = Option.match(secret, {
    onNone: () => true,
    onSome: (expected) =>
      Option.match(Option.flatMap(proxyAuthorization, offeredPassword), {
        onNone: () => false,
        onSome: (password) => tokensMatch(expected, password),
      }),
  });

  if (!authorised) return EgressDecision.Challenge();

  if (Option.isNone(target)) {
    return EgressDecision.Refuse({ reason: "A proxy request names host and port." });
  }

  const { host, port } = target.value;
  const destinations = yield* Destinations;

  return yield* destinations.check(host).pipe(
    Effect.map((addresses) => EgressDecision.Connect({ port, addresses })),
    Effect.catchTags({
      ActionRefused: ({ message }) => Effect.succeed(EgressDecision.Refuse({ reason: message })),
      ActionFailed: ({ message }) => Effect.succeed(EgressDecision.Fail({ reason: message })),
    }),
  );
});

/** `host:port` from a CONNECT line, the host unbracketed. */
export function parseAuthority(authority: string): Option.Option<EgressTarget> {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/u.exec(authority);

  if (match === null) return Option.none();

  const port = Number(match[3]);

  if (port < 1 || port > 65_535) return Option.none();

  return Option.some({ host: match[1] ?? match[2] ?? "", port });
}

/** The host and port of an absolute `http:` URL, as a plain proxied request names it. */
export function parseAbsoluteUrl(raw: string): Option.Option<EgressTarget> {
  return Option.flatMap(Option.liftThrowable(() => new URL(raw))(), (url) =>
    url.protocol === "http:"
      ? Option.some({ host: url.hostname.replace(/^\[|\]$/gu, ""), port: Number(url.port || 80) })
      : Option.none(),
  );
}

/** Checked addresses in the order they are tried: IPv4 first, because many container networks have no IPv6 route. */
function connectOrder(addresses: ReadonlyArray<string>): ReadonlyArray<string> {
  return [
    ...addresses.filter((address) => isIP(address) === 4),
    ...addresses.filter((address) => isIP(address) !== 4),
  ];
}

const attemptTimeoutMs = 3_000;

/** Connect to the first checked address that answers. Each attempt is a literal address, so nothing is looked up again. */
function connectInTurn(
  addresses: ReadonlyArray<string>,
  port: number,
  onReady: (socket: Socket) => void,
  onError: () => void,
): void {
  const [address, ...rest] = addresses;

  if (address === undefined) {
    onError();

    return;
  }

  const socket = connect({ host: address, port });

  const moveOn = () => {
    socket.destroy();
    connectInTurn(rest, port, onReady, onError);
  };

  socket.setTimeout(attemptTimeoutMs, moveOn);
  socket.once("error", moveOn);
  socket.once("connect", () => {
    socket.setTimeout(0);
    socket.off("error", moveOn);
    onReady(socket);
  });
}

const challenge =
  'HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="aobot"\r\nconnection: close\r\ncontent-length: 0\r\n\r\n';

/** Marks a page the proxy answered itself, so a navigation that ends on one is reported as refused. */
export const refusedHeader = "x-aobot-egress";

function statusLine(status: 403 | 502, reason: string): string {
  const text = status === 403 ? "Forbidden" : "Bad Gateway";

  return `HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(reason)}\r\nconnection: close\r\n\r\n${reason}`;
}

/**
An HTTP and CONNECT forward proxy on 127.0.0.1 that checks every address a host resolves to against
{@link Destinations}, and connects only to an address it checked, so a redirect or a script cannot reach
a private or metadata address, however the name resolves the second time. With a `secret` it asks for
it first. Answers its address.
*/
const listenForEgress = Effect.fnUntraced(function* (secret: Option.Option<string>) {
  const run = Effect.runPromiseWith(yield* Effect.context<Destinations>());

  const decide = (request: IncomingMessage, target: Option.Option<EgressTarget>) =>
    run(decideEgress(secret, Option.fromNullishOr(request.headers["proxy-authorization"]), target));

  const forwardPlain = (
    request: IncomingMessage,
    response: ServerResponse,
    decision: EgressDecision,
  ) =>
    EgressDecision.$match(decision, {
      Challenge: () =>
        response
          .writeHead(407, { "proxy-authenticate": 'Basic realm="aobot"', connection: "close" })
          .end(),
      Refuse: ({ reason }) =>
        response
          .writeHead(403, { "content-type": "text/plain", [refusedHeader]: "refused" })
          .end(reason),
      Fail: ({ reason }) => response.writeHead(502, { "content-type": "text/plain" }).end(reason),
      Connect: ({ port, addresses }) => {
        const url = new URL(request.url ?? "");
        const { "proxy-authorization": _, "proxy-connection": __, ...headers } = request.headers;
        const [address = ""] = connectOrder(addresses);

        const outbound = httpRequest(
          {
            host: address,
            port,
            method: request.method,
            path: `${url.pathname}${url.search}`,
            headers,
          },
          (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(response);
          },
        );

        outbound.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        request.pipe(outbound);
      },
    });

  const tunnel = (client: Socket, head: Buffer, decision: EgressDecision) =>
    EgressDecision.$match(decision, {
      Challenge: () => client.end(challenge),
      Refuse: ({ reason }) => client.end(statusLine(403, reason)),
      Fail: ({ reason }) => client.end(statusLine(502, reason)),
      Connect: ({ port, addresses }) =>
        connectInTurn(
          connectOrder(addresses),
          port,
          (remote) => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

            if (head.length > 0) remote.write(head);
            remote.on("error", () => client.destroy());
            client.on("close", () => remote.destroy());
            remote.pipe(client);
            client.pipe(remote);
          },
          () => client.end(statusLine(502, "No checked address answered.")),
        ),
    });

  const server = createServer((request, response) => {
    void decide(request, parseAbsoluteUrl(request.url ?? "")).then((decision) =>
      forwardPlain(request, response, decision),
    );
  });

  server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    void decide(request, parseAuthority(request.url ?? "")).then((decision) =>
      tunnel(client, head, decision),
    );
  });

  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        // SAFETY: a server listening on a host and port, not a pipe, reports an `AddressInfo`.
        const { port } = server.address() as AddressInfo;
        resume(Effect.succeed(port));
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

  return `http://127.0.0.1:${port}`;
});

/** The browser's only way out: Chromium is launched pointing at it, with a per-process secret. */
export const startEgressProxy = Effect.gen(function* () {
  const secret = randomBytes(24).toString("base64url");
  const server = yield* listenForEgress(Option.some(secret));

  return { server, username: proxyUser, password: secret };
});

/**
The shell's way out: a listener of its own that asks for no credentials, because any command could read
them from its environment. A command reaches only what its {@link Destinations} allow, as long as it
honours its proxy variables; going around them is closed by network limits (E5-3), not here.
*/
export const startShellEgressProxy = listenForEgress(Option.none());
