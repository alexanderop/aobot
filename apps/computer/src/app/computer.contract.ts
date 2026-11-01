import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { type OutgoingHttpHeaders, request } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CommandEnd,
  CommandRan,
  type ComputerAction,
  commandOutputLimit,
  FileAnswer,
  FileSaved,
  fileTransferLimit,
  findRef,
  PageRead,
  PersonInput,
  type RefTarget,
  ScreenFrame,
  snapshotRefs,
} from "@aobot/domain";
import { NodeWS } from "@effect/platform-node";
import { Effect, Option, Schema, Stream } from "effect";
import { Socket } from "effect/socket";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

/**
Tier 3: the computer image behaves as the wire contract says. Builds `aobot-computer:dev`, runs it twice
on a network of its own (private hosts allowed, for the fixture, and not), and drives `POST /act`, `POST /input`
and `GET /stream` over a port published on 127.0.0.1 only. The fixture page is served by a third container from the same image, so
the suite needs nothing but Docker. `vp run test:contract`.
*/

const run = promisify(execFile);

const { Exited, Signalled, TimedOut } = CommandEnd.cases;

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const image = "aobot-computer:dev";

const suite = `aobot-contract-${randomBytes(4).toString("hex")}`;

const token = randomBytes(24).toString("base64url");

const fixturePort = 8080;

const fixturePage = `<!doctype html><title>Contract Fixture</title><h1>A page for the computer</h1>
<a href="/next">Next page</a><button>Press me</button><label>Name <input></label>`;

// Pressing the button renames it, so its old ref and name no longer match. The form would leave the page
// if anything submitted it.
const formPage = `<!doctype html><title>Form Fixture</title><form action="/submitted">
<label>Name <input name="name"></label>
<button type="button" onclick="this.textContent = 'Pressed'">Press me</button></form>`;

// One link over the whole viewport, so a click anywhere on the screen follows it.
const linkPage = `<!doctype html><title>Link Fixture</title><style>body { margin: 0 }</style>
<a href="/followed" style="display: block; width: 100vw; height: 100vh">Follow me</a>`;

const slowPage = `<!doctype html><title>Slow Fixture</title><p>This page took two seconds.</p>`;

// A click anywhere holds the page's only thread for eight seconds, past the computer's limit on a click.
const busyPage = `<!doctype html><title>Busy Fixture</title><style>body { margin: 0 }</style>
<button style="width: 100vw; height: 100vh"
  onclick="const end = Date.now() + 8000; while (Date.now() < end) {}">Hold the page</button>`;

const fixtureServer = `require("node:http").createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  const page = req.url.startsWith("/form") ? ${JSON.stringify(formPage)}
    : req.url.startsWith("/link") ? ${JSON.stringify(linkPage)}
    : req.url.startsWith("/slow") ? ${JSON.stringify(slowPage)}
    : req.url.startsWith("/busy") ? ${JSON.stringify(busyPage)}
    : ${JSON.stringify(fixturePage)};
  setTimeout(() => res.end(page), req.url.startsWith("/slow") ? 2000 : 0);
}).listen(${fixturePort}, "0.0.0.0");`;

function docker(...args: ReadonlyArray<string>) {
  return run("docker", args, { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 }).then(
    ({ stdout }) => stdout.trim(),
  );
}

interface Computer {
  readonly name: string;
  readonly url: string;
}

async function startComputer(role: string, allowPrivateHosts: boolean): Promise<Computer> {
  const name = `${suite}-${role}`;
  await docker(
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    suite,
    "--publish",
    "127.0.0.1::4100",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "512",
    "--memory",
    "2g",
    "--env",
    `COMPUTER_TOKEN=${token}`,
    "--env",
    `COMPUTER_ALLOW_PRIVATE_HOSTS=${allowPrivateHosts}`,
    image,
  );
  const published = await docker("port", name, "4100/tcp");

  return { name, url: `http://${published.split("\n")[0] ?? ""}` };
}

async function untilHealthy(computer: Computer) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const status = await docker("inspect", "--format", "{{.State.Health.Status}}", computer.name);

    if (status === "healthy") return;

    if (status === "unhealthy") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`${computer.name} never became healthy:\n${await docker("logs", computer.name)}`);
}

interface Call {
  readonly authorization: string;
  readonly signal: AbortSignal;
}

const asServer: Call = { authorization: `Bearer ${token}`, signal: new AbortController().signal };

function act(computer: Computer, body: ComputerAction, { authorization, signal }: Call = asServer) {
  return fetch(`${computer.url}/act`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
    signal,
  });
}

async function result(response: Response): Promise<PageRead> {
  expect(response.status).toBe(200);

  return Schema.decodeUnknownSync(PageRead)(await response.json());
}

function runCommand(computer: Computer, command: string, signal = asServer.signal) {
  return act(computer, { action: "run", command }, { ...asServer, signal });
}

async function ran(response: Response): Promise<CommandRan> {
  expect(response.status).toBe(200);

  return Schema.decodeUnknownSync(CommandRan)(await response.json());
}

const fileUrl = (computer: Computer, path: string) =>
  `${computer.url}/files?path=${encodeURIComponent(path)}`;

async function fileAnswer(response: Response): Promise<FileAnswer> {
  expect(response.status).toBe(200);

  return Schema.decodeUnknownSync(FileAnswer)(await response.json());
}

/**
The status `PUT /files` answers an upload of `bytes` zero bytes, sent in 1 MiB pieces as fast as the
computer reads them. Without `declared` the upload says no length, so the computer can only count it as
it arrives.
*/
function uploadStatus(computer: Computer, path: string, bytes: number, declared: boolean) {
  return new Promise<number>((resolve, reject) => {
    const piece = Buffer.alloc(1024 * 1024);
    const headers: OutgoingHttpHeaders = { authorization: `Bearer ${token}` };

    if (declared) headers["content-length"] = String(bytes);

    const upload = request(fileUrl(computer, path), { method: "PUT", headers });

    upload.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
      upload.destroy();
    });
    // The computer may hang up once it has answered, before the rest is sent.
    upload.on("error", (error) => (upload.destroyed ? undefined : reject(error)));

    const send = (left: number) => {
      if (left <= 0) return upload.end();

      const ready = upload.write(piece.subarray(0, Math.min(piece.length, left)));

      if (ready) send(left - piece.length);
      else upload.once("drain", () => send(left - piece.length));
    };

    send(bytes);
  });
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function processes(computer: Computer): Promise<string> {
  return docker("exec", computer.name, "ps", "-eo", "args");
}

function target(snapshot: string, role: string, name: string): RefTarget {
  return Option.getOrThrowWith(
    findRef(snapshot, { role, name }),
    () => new Error(`no ${role} "${name}" in:\n${snapshot}`),
  );
}

/** The status `/stream` answers a WebSocket handshake with, without a token: 101 means it upgraded. */
function handshakeStatus(computer: Computer): Promise<number> {
  return new Promise((resolve, reject) => {
    const handshake = request(`${computer.url}/stream`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
    });

    handshake.on("response", (response) => resolve(response.statusCode ?? 0));
    handshake.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    handshake.on("error", reject);
    handshake.end();
  });
}

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(ScreenFrame));

/** The first frame `/stream` sends the token holder, through the server's own WebSocket client. */
function firstFrame(computer: Computer): Promise<ScreenFrame> {
  return Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(`${computer.url.replace(/^http/u, "ws")}/stream`, {
      headers: { authorization: `Bearer ${token}` },
    });

    return yield* Socket.toStream(socket).pipe(Stream.runHead);
  }).pipe(
    Effect.map(Option.getOrThrow),
    Effect.map((message) => decodeFrame(new TextDecoder().decode(message))),
    Effect.timeout("5 seconds"),
    Effect.provide(NodeWS.layerWebSocketConstructor),
    Effect.runPromise,
  );
}

/** The documented answer to a ref that no longer names what the Bot saw. */
const staleRefMessage =
  /^The page changed since your latest snapshot, so \S+ is not the \S+ it was\. Take a snapshot again and use a ref from it\.$/u;

let local: Computer;

let strict: Computer;

beforeAll(async () => {
  await docker("build", "--file", "apps/computer/Dockerfile", "--tag", image, ".");
  await docker("network", "create", suite);
  await docker(
    "run",
    "--detach",
    "--name",
    `${suite}-fixture`,
    "--network",
    suite,
    "--entrypoint",
    "node",
    image,
    "-e",
    fixtureServer,
  );
  [local, strict] = await Promise.all([
    startComputer("local", true),
    startComputer("strict", false),
  ]);
  await Promise.all([untilHealthy(local), untilHealthy(strict)]);
}, 900_000);

afterAll(async () => {
  const containers = await docker("ps", "--all", "--quiet", "--filter", `name=${suite}`);

  if (containers !== "") await docker("rm", "--force", ...containers.split("\n"));

  await docker("network", "rm", suite).catch(() => undefined);
}, 60_000);

describe("the docker computer", () => {
  it("answers /health without a token", async () => {
    const response = await fetch(`${local.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("opens the fixture and tells its title", async () => {
    const url = `http://${suite}-fixture:${fixturePort}/`;
    const response = await act(local, { action: "navigate", url });
    expect(await response.json()).toMatchObject({
      action: "navigate",
      url,
      title: "Contract Fixture",
    });
    expect(response.status).toBe(200);
  });

  it("snapshots the page with refs a Bot can act on", async () => {
    const body = await result(await act(local, { action: "snapshot" }));
    expect(body).toMatchObject({ action: "snapshot", title: "Contract Fixture", truncated: false });
    expect(body.snapshot).toMatch(/button "Press me" \[ref=e\d+\]/u);
    expect(body.snapshot).toMatch(/link "Next page" \[ref=e\d+\]/u);
  });

  describe("on a form", () => {
    const formUrl = `http://${suite}-fixture:${fixturePort}/form`;

    it("types into a field by its ref, replacing what it held, without submitting", async () => {
      const opened = await result(await act(local, { action: "navigate", url: formUrl }));
      const name = target(opened.snapshot, "textbox", "Name");

      await result(await act(local, { action: "type", target: name, text: "Ada" }));

      const typed = await result(
        await act(local, { action: "type", target: name, text: "Ada Lovelace" }),
      );

      expect(typed).toMatchObject({ action: "type", url: formUrl, title: "Form Fixture" });
      expect(typed.snapshot).toMatch(
        new RegExp(`textbox "Name" (\\[active\\] )?\\[ref=${name.ref}\\]: Ada Lovelace$`, "mu"),
      );
    });

    it("clicks a button by its ref and answers with the page it changed", async () => {
      const opened = await result(await act(local, { action: "snapshot" }));
      const button = target(opened.snapshot, "button", "Press me");

      const clicked = await result(await act(local, { action: "click", target: button }));

      expect(clicked.action).toBe("click");
      expect(Option.isSome(findRef(clicked.snapshot, { role: "button", name: "Pressed" }))).toBe(
        true,
      );

      const again = await act(local, { action: "click", target: button });
      expect(again.status).toBe(403);
      expect(await again.json()).toEqual({
        reason: "refused",
        message: expect.stringMatching(staleRefMessage),
      });
    });

    // Playwright 1.64 usually gives each document's refs their own prefix (`f1e4`), but its counter
    // can also start again at `e1`, so a ref from before a navigation may name something else.
    it("refuses a ref from before a navigation", async () => {
      const opened = await result(await act(local, { action: "navigate", url: formUrl }));
      const name = target(opened.snapshot, "textbox", "Name");

      const elsewhere = await result(
        await act(local, { action: "navigate", url: `http://${suite}-fixture:${fixturePort}/` }),
      );

      expect(snapshotRefs(elsewhere.snapshot).get(name.ref)).not.toEqual(name);

      const typed = await act(local, { action: "type", target: name, text: "Ada" });
      expect(typed.status).toBe(403);
      expect(await typed.json()).toEqual({
        reason: "refused",
        message: expect.stringMatching(staleRefMessage),
      });
    });

    it("refuses a ref that names nothing on the page", async () => {
      const response = await act(local, {
        action: "click",
        target: { ref: "e999", role: "button", name: "Press me" },
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ reason: "refused" });
    });
  });

  it.each([
    ["no token", ""],
    ["the wrong token", `Bearer ${token}x`],
    ["a non-ASCII token", "Bearer tökén"],
  ])("answers 401 to %s", async (_, authorization) => {
    const response = await act(local, { action: "snapshot" }, { ...asServer, authorization });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authorised." });
  });

  describe("a person's input", () => {
    const linkUrl = `http://${suite}-fixture:${fixturePort}/link`;

    const centre = JSON.stringify(PersonInput.cases.Click.make({ at: { x: 0.5, y: 0.5 } }));

    function input(body: string, authorization = asServer.authorization) {
      return fetch(`${local.url}/input`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body,
      });
    }

    it("clicks where the person clicked on the screen, as fractions of it", async () => {
      await result(await act(local, { action: "navigate", url: linkUrl }));

      const clicked = await input(centre);
      expect(clicked.status).toBe(204);

      const deadline = Date.now() + 10_000;
      let read = await result(await act(local, { action: "snapshot" }));

      while (!read.url.endsWith("/followed") && Date.now() < deadline) {
        await pause(200);
        read = await result(await act(local, { action: "snapshot" }));
      }

      expect(read.url).toBe(`http://${suite}-fixture:${fixturePort}/followed`);
    });

    it("clicks only once a Bot action whose caller hung up has settled", async () => {
      const slowUrl = `http://${suite}-fixture:${fixturePort}/slow`;
      await result(await act(local, { action: "navigate", url: linkUrl }));

      const hangUp = new AbortController();

      const navigating = act(
        local,
        { action: "navigate", url: slowUrl },
        { ...asServer, signal: hangUp.signal },
      ).catch(() => "hung up");

      await pause(300);
      hangUp.abort();
      expect(await navigating).toBe("hung up");

      expect((await input(centre)).status).toBe(204);

      const read = await result(await act(local, { action: "snapshot" }));
      expect(read.url, "the click landed on the slow page, not the link it replaced").toBe(slowUrl);
    });

    it("fails a click the page holds up past its limit, and the next Bot action still runs", async () => {
      const busyUrl = `http://${suite}-fixture:${fixturePort}/busy`;
      await result(await act(local, { action: "navigate", url: busyUrl }));

      const clickedAt = Date.now();
      const clicked = await input(centre);

      expect(clicked.status).toBe(502);
      expect(await clicked.json()).toEqual({
        reason: "failed",
        message: "Clicking failed: Timeout 5000ms exceeded.",
      });
      expect(Date.now() - clickedAt, "answered before the page let go").toBeLessThan(7_000);

      const read = await result(await act(local, { action: "snapshot" }));
      expect(read.title).toBe("Busy Fixture");
    });

    it("answers 401 without the token", async () => {
      const response = await input(centre, "");
      expect(response.status).toBe(401);
    });

    it("answers 400 to a point off the screen", async () => {
      const response = await input('{"_tag":"Click","at":{"x":2,"y":0.5}}');
      expect(response.status).toBe(400);
    });
  });

  describe("its screen", () => {
    it("refuses /stream without a token, before any upgrade", async () => {
      expect(await handshakeStatus(local)).toBe(401);
    });

    // Chromium paints a still page only when asked to start, so this is what a first viewer sees.
    it("streams a JPEG of a still page to the token holder, at once", async () => {
      await result(
        await act(local, { action: "navigate", url: `http://${suite}-fixture:${fixturePort}/` }),
      );

      const { jpeg } = await firstFrame(local);

      expect(jpeg.startsWith("/9j/")).toBe(true);
    });
  });

  it.each(["http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "file:///etc/passwd"])(
    "refuses %s",
    async (url) => {
      const response = await act(strict, { action: "navigate", url });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ reason: "refused" });
    },
  );

  it.each(["http://169.254.169.254/latest/meta-data/", "http://[::ffff:169.254.169.254]/"])(
    "refuses %s even with private hosts allowed",
    async (url) => {
      const response = await act(local, { action: "navigate", url });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ reason: "refused" });
    },
  );

  it("runs commands and Chromium as a user other than root", async () => {
    expect(await docker("exec", local.name, "id", "-u")).not.toBe("0");
    const owners = await docker("exec", local.name, "ps", "-o", "uid=", "-C", "chrome");
    expect(owners.split("\n").map((uid) => uid.trim())).not.toContain("0");
  });

  describe("its workspace", () => {
    it("keeps a Bot's files where its shell sees them", async () => {
      expect(
        await fileAnswer(
          await act(local, {
            action: "write_file",
            path: "reports/total.csv",
            contents: "total,20\n",
          }),
        ),
      ).toEqual({ action: "write_file", path: "reports/total.csv", bytes: 9 });

      expect((await ran(await runCommand(local, "cat reports/total.csv"))).stdout.text).toBe(
        "total,20\n",
      );
      expect(
        await fileAnswer(await act(local, { action: "read_file", path: "reports/total.csv" })),
      ).toMatchObject({ text: "total,20\n", bytes: 9 });
    });

    it("refuses /etc/passwd, and a link the shell placed in the workspace that leads to /etc", async () => {
      await ran(await runCommand(local, "ln -sfn /etc etc && ln -sf /etc/passwd passwd"));

      for (const path of ["/etc/passwd", "../etc/passwd", "etc/passwd", "passwd"]) {
        const response = await act(local, { action: "read_file", path });

        expect(response.status, path).toBe(403);
        expect(await response.json(), path).toMatchObject({ reason: "refused" });
      }

      const written = await act(local, { action: "write_file", path: "passwd", contents: "x" });
      expect(written.status).toBe(403);
    });

    it("refuses a write through a link that goes up out of a folder a link leads outside", async () => {
      await ran(await runCommand(local, "ln -sfn /tmp sub && ln -sfn sub/.. up"));

      const written = await act(local, {
        action: "write_file",
        path: "up/tmp/aobot-planted.txt",
        contents: "x",
      });

      expect(written.status).toBe(403);
      expect((await ran(await runCommand(local, "ls -A /tmp"))).stdout.text).not.toContain(
        "aobot-planted.txt",
      );
    });

    it("downloads the exact bytes of a file a person uploaded, as the shell sees them", async () => {
      const bytes = randomBytes(1024 * 1024);
      bytes[0] = 0;
      bytes[bytes.length - 1] = 0;

      const uploaded = await fetch(fileUrl(local, "blob.bin"), {
        method: "PUT",
        headers: { authorization: asServer.authorization },
        body: bytes,
      });

      expect(uploaded.status).toBe(200);
      expect(Schema.decodeUnknownSync(FileSaved)(await uploaded.json())).toEqual({
        path: "blob.bin",
        bytes: bytes.length,
      });

      const downloaded = await fetch(fileUrl(local, "blob.bin"), {
        headers: { authorization: asServer.authorization },
      });

      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("content-length")).toBe(String(bytes.length));
      expect(Buffer.from(await downloaded.arrayBuffer()).equals(bytes)).toBe(true);

      const { stdout } = await ran(await runCommand(local, "sha256sum blob.bin"));
      expect(stdout.text.split(" ")[0]).toBe(sha256(bytes));
    });

    it("refuses an upload past 100 MiB with 413 and keeps none of it, said or counted", async () => {
      const tooLarge = fileTransferLimit + 1024 * 1024;

      expect(await uploadStatus(local, "declared.bin", tooLarge, true)).toBe(413);
      expect(await uploadStatus(local, "counted.bin", tooLarge, false)).toBe(413);

      const { stdout } = await ran(await runCommand(local, "ls -A /workspace"));
      expect(stdout.text).not.toContain("declared.bin");
      expect(stdout.text).not.toContain("counted.bin");
    }, 120_000);

    it("refuses a download without the token", async () => {
      expect((await fetch(fileUrl(local, "blob.bin"))).status).toBe(401);
    });
  });

  describe("its shell", () => {
    it("runs a command with bash as pwuser in /workspace, which is also its HOME", async () => {
      expect(await ran(await runCommand(local, 'id -un; pwd; echo "$HOME"; echo "$0"'))).toEqual({
        action: "run",
        end: Exited.make({ code: 0 }),
        stdout: { text: "pwuser\n/workspace\n/workspace\nbash\n", truncated: false },
        stderr: { text: "", truncated: false },
        leftOutputOpen: false,
      });
    });

    it("keeps files between commands, and answers a failed command's exit code and errors", async () => {
      await ran(await runCommand(local, "echo hello > notes.txt"));

      const read = await ran(await runCommand(local, "cat notes.txt && ls /data/aobot.db"));

      expect(read.end).toEqual(Exited.make({ code: 2 }));
      expect(read.stdout.text).toBe("hello\n");
      expect(read.stderr.text).toContain("No such file or directory");
    });

    it("never gives a command the computer's token or its telemetry settings", async () => {
      const { stdout } = await ran(await runCommand(local, "env"));

      expect(stdout.text).toContain("HTTP_PROXY=");
      expect(stdout.text).not.toContain("COMPUTER_TOKEN");
      expect(stdout.text).not.toContain(token);
      expect(stdout.text).not.toContain("OTEL_");
    });

    it("refuses, through its proxy settings, a host the browser may open", async () => {
      const fixture = `http://${suite}-fixture:${fixturePort}/`;
      await result(await act(local, { action: "navigate", url: fixture }));

      const fetched = await ran(
        await runCommand(
          local,
          `curl --silent --show-error --fail-with-body --max-time 3 ${fixture}`,
        ),
      );

      expect(fetched.end).not.toEqual(Exited.make({ code: 0 }));
      expect(fetched.stdout.text).toContain("inside the computer's own network");
    });

    it("cannot drive the browser around the gateway with the token it reads out of /proc", async () => {
      const probe = await ran(
        await runCommand(
          local,
          [
            `token=$(for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$f" 2>/dev/null; done | sed -n 's/^COMPUTER_TOKEN=//p' | head -n 1)`,
            'test -n "$token" || exit 3',
            "own=$(hostname -i | cut -d ' ' -f 1)",
            'for host in 127.0.0.1 "$own"; do',
            `  curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}\\n' --max-time 3 -X POST -H "authorization: Bearer $token" -H 'content-type: application/json' --data '{"action":"snapshot"}' "http://$host:4100/act"`,
            "done",
          ].join("\n"),
        ),
      );

      expect(probe.end).toEqual(Exited.make({ code: 0 }));
      expect(probe.stdout.text).toBe("403\n403\n");
    });

    it("keeps only the end of a long output, and says so", async () => {
      const { stdout } = await ran(await runCommand(local, "seq 1 200000"));

      expect(stdout.truncated).toBe(true);
      expect(stdout.text.length).toBeLessThanOrEqual(commandOutputLimit);
      expect(stdout.text.endsWith("199999\n200000\n")).toBe(true);
    });

    it("answers the signal that ended bash, with what it printed before", async () => {
      expect(await ran(await runCommand(local, "echo before; kill -TERM $$"))).toEqual({
        action: "run",
        end: Signalled.make({ signal: "SIGTERM" }),
        stdout: { text: "before\n", truncated: false },
        stderr: { text: "", truncated: false },
        leftOutputOpen: false,
      });
    });

    it("answers as soon as bash exits, and stops a background job still holding its output", async () => {
      const started = Date.now();
      const exited = await ran(await runCommand(local, "sleep 602 & echo hi"));

      expect(exited.end).toEqual(Exited.make({ code: 0 }));
      expect(exited.stdout.text).toBe("hi\n");
      expect(exited.leftOutputOpen).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await processes(local)).not.toContain("sleep 602");
    });

    it("answers a command that exits just inside 30 seconds as exited, though a background job holds its output", async () => {
      const finished = await ran(await runCommand(local, "sleep 603 & sleep 29.7; echo finished"));

      expect(finished.end).toEqual(Exited.make({ code: 0 }));
      expect(finished.stdout.text).toBe("finished\n");
      expect(finished.leftOutputOpen).toBe(true);
      expect(await processes(local)).not.toContain("sleep 603");
    });

    it("stops a background job still holding its output after a signal ends bash, and says so", async () => {
      const ended = await ran(await runCommand(local, "sleep 604 & echo hi; kill -TERM $$"));

      expect(ended.end).toEqual(Signalled.make({ signal: "SIGTERM" }));
      expect(ended.leftOutputOpen).toBe(true);
      expect(await processes(local)).not.toContain("sleep 604");
    });

    it("stops a command that runs past 30 seconds, and everything in its process group", async () => {
      const started = Date.now();
      const stopped = await ran(await runCommand(local, "echo started; sleep 600 | cat"));
      const took = Date.now() - started;

      expect(stopped.end).toEqual(TimedOut.make({}));
      expect(stopped.stdout.text).toBe("started\n");
      expect(took).toBeGreaterThanOrEqual(30_000);
      expect(took).toBeLessThan(40_000);
      expect(await processes(local)).not.toContain("sleep 600");
    });

    it("stops a running command and everything in its process group when its request is aborted", async () => {
      const stop = new AbortController();
      const running = runCommand(local, "sleep 601 | cat", stop.signal).catch(() => "aborted");

      await pause(1_000);
      expect(await processes(local)).toContain("sleep 601");

      stop.abort();
      expect(await running).toBe("aborted");
      await pause(2_000);
      expect(await processes(local)).not.toContain("sleep 601");
    });

    it("never runs a command whose request was aborted while it waited for the one before", async () => {
      const first = runCommand(local, "sleep 3");
      await pause(500);

      const stop = new AbortController();

      const second = runCommand(local, "touch /workspace/b-ran", stop.signal).catch(
        () => "aborted",
      );

      await pause(500);
      stop.abort();

      expect(await second).toBe("aborted");
      expect((await ran(await first)).end).toEqual(Exited.make({ code: 0 }));
      expect((await ran(await runCommand(local, "ls /workspace/b-ran"))).end).not.toEqual(
        Exited.make({ code: 0 }),
      );
    });
  });
});
