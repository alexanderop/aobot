import { execFileSync } from "node:child_process";
import { browser } from "./browser.ts";
import { compose, computerContainer } from "./stack.ts";

const ticket = process.argv[2];

if (ticket === undefined) throw new Error("usage: vp run verify <ticket-id>");

const baseUrl = "http://localhost:3100";

const grafanaUrl = "http://localhost:3400";

/**
The server removes its computer when it stops, but not when it crashed. A computer left behind holds the
stack's network, and `compose down` cannot remove a network a container still uses.
*/
function removeComputer(): void {
  try {
    execFileSync("docker", ["rm", "--force", computerContainer], { stdio: "ignore" });
  } catch {
    // Most runs have none to remove.
  }
}

function down(): void {
  removeComputer();
  compose("down", "--volumes");
}

const { default: scenario, stack } = await import(`./scenarios/${ticket}.ts`);

// A failed cleanup step must not hide why the scenario failed, and must not skip the teardown.
function bestEffort(step: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error(`verify cleanup: ${step} failed`, error);
  }
}

if (stack === false) {
  await scenario(baseUrl, grafanaUrl);
  console.log(`verify ${ticket}: passed`);
} else {
  try {
    down();
    compose("up", "--build", "--detach", "--wait");
    await scenario(baseUrl, grafanaUrl);
    console.log(`verify ${ticket}: passed`);
  } finally {
    try {
      bestEffort("close the browser", () => browser("close"));
      bestEffort("collect the server log", () => compose("logs", "server", "--tail", "40"));
    } finally {
      down();
    }
  }
}
