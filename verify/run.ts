import { execFileSync } from "node:child_process";
import { browser } from "./browser.ts";

const ticket = process.argv[2];

if (ticket === undefined) throw new Error("usage: vp run verify <ticket-id>");

const baseUrl = "http://localhost:3100";

function compose(...args: string[]): void {
  execFileSync(
    "docker",
    [
      "compose",
      "--project-name",
      "aobot-verify",
      "--file",
      "docker-compose.yml",
      "--file",
      "verify/compose.yml",
      ...args,
    ],
    { stdio: "inherit" },
  );
}

const { default: scenario } = await import(`./scenarios/${ticket}.ts`);

// A failed cleanup step must not hide why the scenario failed, and must not skip the teardown.
function bestEffort(step: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error(`verify cleanup: ${step} failed`, error);
  }
}

try {
  compose("down", "--volumes");
  compose("up", "--build", "--detach", "--wait");
  await scenario(baseUrl);
  console.log(`verify ${ticket}: passed`);
} finally {
  try {
    bestEffort("close the browser", () => browser("close"));
    bestEffort("collect the server log", () => compose("logs", "server", "--tail", "40"));
  } finally {
    compose("down", "--volumes");
  }
}
