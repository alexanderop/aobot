import { execFileSync } from "node:child_process";
import { browser } from "./browser.ts";

const ticket = process.argv[2];
if (ticket === undefined) throw new Error("usage: vp run verify <ticket-id>");

const baseUrl = "http://localhost:3000";
const env = {
  ...process.env,
  MODEL_PROVIDER: "openai-compat",
  MODEL_NAME: "mock",
  MODEL_API_KEY: "mock",
  MODEL_BASE_URL: "http://mock-model:4010/v1",
};

function compose(...args: string[]): void {
  execFileSync(
    "docker",
    ["compose", "--project-name", "aobot-verify", "--profile", "verify", ...args],
    { env, stdio: "inherit" },
  );
}

const { default: scenario } = await import(`./scenarios/${ticket}.ts`);
compose("down", "--volumes");
compose("up", "--build", "--detach", "--wait");
try {
  await scenario(baseUrl);
  console.log(`verify ${ticket}: passed`);
} finally {
  browser("close");
  compose("logs", "server", "--tail", "40");
  compose("down", "--volumes");
}
