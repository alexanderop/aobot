import { execFileSync } from "node:child_process";

/** The Compose project `vp run verify` runs, beside the dev stack's `aobot`. */
export const project = "aobot-verify";

/** The container the verify server starts its computer in (`COMPUTER_NAME` in docker-compose.yml). */
export const computerContainer = `${project}-computer`;

const files = ["--file", "docker-compose.yml", "--file", "verify/compose.yml"];

/** Run `docker compose` on the verify stack, its output shown as it runs. */
export function compose(...args: ReadonlyArray<string>): void {
  execFileSync("docker", ["compose", "--project-name", project, ...files, ...args], {
    stdio: "inherit",
  });
}

/** Run `docker compose` on the verify stack and return what it printed. */
export function composeOutput(...args: ReadonlyArray<string>): string {
  return execFileSync("docker", ["compose", "--project-name", project, ...files, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}
