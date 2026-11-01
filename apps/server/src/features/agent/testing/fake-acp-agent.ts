import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Schema } from "effect";

/**
A stand-in for a CLI's ACP adapter, for tier-2 tests: `node fake-acp-agent.ts` speaks ACP on stdio and
does what `FAKE_ACP` (JSON, see {@link FakeAgentScript}) says. Plain Node, no imports from the app.
*/
export interface FakeAgentScript {
  /** Text chunks of the answer, sent as `agent_message_chunk` updates. */
  readonly chunks: ReadonlyArray<string>;
  /** Requests to send the client before answering. Each reply's error code is told back as a chunk. */
  readonly ask: ReadonlyArray<{ readonly method: string; readonly params: Schema.JsonObject }>;
  /** Never answer `session/prompt`: the agent goes silent. */
  readonly silent: boolean;
  /** Where to write this process's pid and its child's, one per line. Empty for none. */
  readonly pidFile: string;
  /** Where to append the method of every message received, one per line. Empty for none. */
  readonly logFile: string;
}

type Message = {
  readonly id: number | string;
  readonly method: string;
  readonly params: { readonly sessionId: string };
  readonly result: Schema.JsonObject;
  readonly error: { readonly code: number };
};

const script: FakeAgentScript = JSON.parse(process.env.FAKE_ACP ?? "{}");

const send = (message: Schema.JsonObject) =>
  process.stdout.write(`{"jsonrpc":"2.0",${JSON.stringify(message).slice(1)}\n`);

const waiting = new Map<number, (message: Message) => void>();

let nextId = 1000;

function ask(method: string, params: Schema.JsonObject): Promise<Message> {
  const id = nextId++;
  send({ id, method, params });

  return new Promise((resolve) => waiting.set(id, resolve));
}

function update(sessionId: string, text: string) {
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
}

if (script.pidFile !== "") {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  writeFileSync(script.pidFile, `${process.pid}\n${child.pid}\n`);
}

process.stdout.write("a log line the client must skip\n");

async function prompt(message: Message) {
  const { sessionId } = message.params;

  for (const request of script.ask) {
    const reply = await ask(request.method, Object.assign({ sessionId }, request.params));
    update(sessionId, `${request.method}: ${reply.error?.code ?? JSON.stringify(reply.result)}\n`);
  }

  for (const chunk of script.chunks) update(sessionId, chunk);

  if (!script.silent) send({ id: message.id, result: { stopReason: "end_turn" } });
}

const input = createInterface({ input: process.stdin });

// Like a real CLI: once the client closes stdin there is nothing left to do. The `sleep` child
// stays behind in the process group, so the client must still end the group itself.
input.on("close", () => process.exit(0));

input.on("line", (line) => {
  const message: Message = JSON.parse(line);

  if (script.logFile !== "") appendFileSync(script.logFile, `${message.method ?? "reply"}\n`);

  if (message.method === undefined) {
    waiting.get(Number(message.id))?.(message);

    return;
  }

  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake-acp-agent", version: "9.9.9" },
        agentCapabilities: { mcpCapabilities: { http: true } },
        authMethods: [],
      },
    });
  } else if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: "fake-session" } });
  } else if (message.method === "session/prompt") {
    void prompt(message);
  }
});
