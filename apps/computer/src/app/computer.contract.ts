import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type ComputerAction,
  ComputerActResult,
  findRef,
  type RefTarget,
  snapshotRefs,
} from "@aobot/domain";
import { Option, Schema } from "effect";
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

// Pressing the button renames it, so its old ref and name no longer match. The form would leave the page
// if anything submitted it.
const formPage = `<!doctype html><title>Form Fixture</title><form action="/submitted">
<label>Name <input name="name"></label>
<button type="button" onclick="this.textContent = 'Pressed'">Press me</button></form>`;

const fixtureServer = `require("node:http").createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(req.url.startsWith("/form") ? ${JSON.stringify(formPage)} : ${JSON.stringify(fixturePage)});
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

async function result(response: Response): Promise<ComputerActResult> {
  expect(response.status).toBe(200);

  return Schema.decodeUnknownSync(ComputerActResult)(await response.json());
}

function target(snapshot: string, role: string, name: string): RefTarget {
  return Option.getOrThrowWith(
    findRef(snapshot, { role, name }),
    () => new Error(`no ${role} "${name}" in:\n${snapshot}`),
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
