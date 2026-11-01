import { execFileSync } from "node:child_process";
import { Schema } from "effect";

/** Run one `agent-browser` command in the verify session and return what it printed. */
export function browser(...args: string[]): string {
  return execFileSync("agent-browser", ["--session", "aobot-verify", ...args], {
    encoding: "utf8",
  }).trim();
}

/** What `js` evaluates to on the page, which agent-browser prints as JSON, decoded as `schema`. */
export function evaluate<A, I>(schema: Schema.Codec<A, I>, js: string): A {
  return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(browser("eval", js));
}

/** Fail the scenario with a message that says which step broke. */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`verify failed: ${message}`);
  console.log(`ok: ${message}`);
}

/** Poll `read` until it returns true, or fail after `timeoutMs`. */
export async function waitFor(
  description: string,
  timeoutMs: number,
  read: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`verify failed: timed out waiting for ${description}`);
}
