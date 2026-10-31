import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, browser, waitFor } from "../browser.ts";

/** Runs the server on this laptop, so the CLIs use the subscriptions they are signed in with. */
export const stack = false;

const database = join(mkdtempSync(join(tmpdir(), "aobot-verify-e0-5-")), "aobot.db");

function startServer(agent: string): ChildProcess {
  const server = spawn("node", ["apps/server/src/app/main.ts"], {
    env: {
      ...process.env,
      AGENT_RUNTIME: "acp",
      ACP_AGENT: agent,
      SINGLE_USER: "true",
      HOST: "127.0.0.1",
      PORT: "3100",
      DATABASE_PATH: database,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  return server;
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await exited;
}

async function serverUp(baseUrl: string): Promise<void> {
  await waitFor("the server", 20_000, () =>
    fetch(baseUrl).then(
      (response) => response.ok,
      () => false,
    ),
  );
}

/** The text of every answer on the page, oldest first. */
function answers(): ReadonlyArray<string> {
  return JSON.parse(
    browser(
      "eval",
      "[...document.querySelectorAll('.bubble--assistant .bubble__text')].map((node) => node.textContent)",
    ),
  );
}

function isRunning(): boolean {
  return browser("get", "count", ".composer__button--stop") !== "0";
}

/** Send `text` and wait for answer number `index` to finish, noting every length it had on the way. */
async function ask(
  text: string,
  index: number,
  done: (answer: string) => boolean,
): Promise<string> {
  browser("find", "placeholder", "Message Assistant", "fill", text);
  browser("press", "Enter");

  const lengths = new Set<number>();
  await waitFor(`answer ${index + 1}`, 120_000, () => {
    const answer = answers()[index] ?? "";
    lengths.add(answer.length);

    return done(answer) && !isRunning();
  });

  const final = answers()[index] ?? "";
  const partial = [...lengths].filter((length) => length > 0 && length < final.length);
  assert(
    partial.length >= 2,
    `answer ${index + 1} streamed in (saw lengths ${[...lengths].join(", ")})`,
  );

  return final;
}

/** E0-5: the E0-1 demo on my Claude Code subscription, then another message on my Codex one. */
export default async function scenario(baseUrl: string): Promise<void> {
  execFileSync("vp", ["build"], { cwd: "apps/web", stdio: "inherit" });

  const claude = startServer("claude-code");

  try {
    await serverUp(baseUrl);
    browser("open", baseUrl);
    browser("wait", "--load", "networkidle");

    const first = await ask(
      "Count from one to fifty in words, separated by spaces. Nothing else.",
      0,
      (answer) => /fifty\W*$/iu.test(answer),
    );

    assert(/one two three/iu.test(first), `Claude Code answered: ${first}`);

    browser("reload");
    browser("wait", "--load", "networkidle");
    await waitFor("the answer after reload", 10_000, () => answers()[0] === first);
  } finally {
    await stopServer(claude);
  }

  const codex = startServer("codex");

  try {
    await serverUp(baseUrl);
    browser("reload");
    browser("wait", "--load", "networkidle");

    const second = await ask(
      "Now count on from fifty-one to one hundred in words, separated by spaces. Nothing else.",
      1,
      (answer) => /hundred\W*$/iu.test(answer),
    );

    assert(/fifty-one/iu.test(second), `Codex answered: ${second}`);
  } finally {
    await stopServer(codex);
    browser("close");
  }
}
