import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ComputerAction, ComputerActResult } from "@aobot/domain";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

/**
Tier 3: the computer image behaves as the wire contract says. Builds `aobot-computer:dev`, runs it twice
on a network of its own (private hosts allowed, for the fixture, and not), and drives `POST /act` over a
port published on 127.0.0.1 only. The fixture page is served by a third container from the same image, so
the suite needs nothing but Docker. `vp run test:contract`.
*/

const run = promisify(execFile);

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const image = "aobot-computer:dev";

const suite = `aobot-contract-${randomBytes(4).toString("hex")}`;

const token = randomBytes(24).toString("base64url");

const fixturePort = 8080;

const fixturePage = `<!doctype html><title>Contract Fixture</title><h1>A page for the computer</h1>
<a href="/next">Next page</a><button>Press me</button><label>Name <input></label>`;

const fixtureServer = `require("node:http").createServer((_, res) => {
  res.setHeader("content-type", "text/html");
  res.end(${JSON.stringify(fixturePage)});
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

function act(computer: Computer, body: ComputerAction, authorization = `Bearer ${token}`) {
  return fetch(`${computer.url}/act`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });
}

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
    expect(await response.json()).toEqual({ action: "navigate", url, title: "Contract Fixture" });
    expect(response.status).toBe(200);
  });

  it("snapshots the page with refs a Bot can act on", async () => {
    const response = await act(local, { action: "snapshot" });
    const body = Schema.decodeUnknownSync(ComputerActResult)(await response.json());
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ action: "snapshot", title: "Contract Fixture", truncated: false });
    const snapshot = ComputerActResult.guards.snapshot(body) ? body.snapshot : "";
    expect(snapshot).toMatch(/button "Press me" \[ref=e\d+\]/u);
    expect(snapshot).toMatch(/link "Next page" \[ref=e\d+\]/u);
  });

  it.each([
    ["no token", ""],
    ["the wrong token", `Bearer ${token}x`],
    ["a non-ASCII token", "Bearer tökén"],
  ])("answers 401 to %s", async (_, authorization) => {
    const response = await act(local, { action: "snapshot" }, authorization);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authorised." });
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
});
