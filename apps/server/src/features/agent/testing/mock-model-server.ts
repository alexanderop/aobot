import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout } from "node:timers/promises";
import { text } from "node:stream/consumers";
import { Array, Effect, Option, Result, Schema } from "effect";
import type { ModelProvider } from "../model-providers.ts";
import {
  decodeModelScript,
  fillRefs,
  jsonStrings,
  type ModelScript,
  ModelStep,
  type ScriptedToolCall,
  scriptOverrun,
} from "./model-script.ts";

/** One server-sent event body. Its `type` names the event in the Anthropic and Responses streams. */
type WireEvent = Schema.JsonObject & { readonly type: string };

/** How one HTTP API streams a {@link ModelStep}, and the path it is served on. */
interface WireFormat {
  readonly path: string;
  readonly say: (words: ReadonlyArray<string>, call: number) => ReadonlyArray<string>;
  readonly callTools: (
    calls: ReadonlyArray<ScriptedToolCall>,
    call: number,
  ) => ReadonlyArray<string>;
}

const model = "mock";

function namedEvent(event: WireEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function dataEvent(data: Schema.JsonObject): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function anthropicMessage(
  call: number,
  stopReason: string,
  blocks: ReadonlyArray<WireEvent>,
): ReadonlyArray<string> {
  const start: WireEvent = {
    type: "message_start",
    message: {
      id: `msg_${call}`,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  };

  return [
    start,
    ...blocks,
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ].map(namedEvent);
}

function openAiResponse(
  call: number,
  output: ReadonlyArray<Schema.JsonObject>,
  events: ReadonlyArray<WireEvent>,
): ReadonlyArray<string> {
  const response = { id: `resp_${call}`, object: "response", created_at: 0, model };

  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    ...events,
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ].map(namedEvent);
}

function chatCompletion(
  call: number,
  finishReason: string,
  deltas: ReadonlyArray<Schema.JsonObject>,
): ReadonlyArray<string> {
  const chunk = (delta: Schema.JsonObject, finish: string | null) => ({
    id: `chatcmpl_${call}`,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  return [
    ...deltas.map((delta) => dataEvent(chunk(delta, null))),
    dataEvent({
      ...chunk({}, finishReason),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    "data: [DONE]\n\n",
  ];
}

/**
The API shapes our runtimes call, keyed by name. `api` uses all three through its providers; Claude Code
speaks Anthropic Messages and Codex speaks OpenAI Responses.
*/
const wireFormats = {
  "anthropic-messages": {
    path: "/v1/messages",
    say: (words, call) =>
      anthropicMessage(call, "end_turn", [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        ...words.map((word): WireEvent => ({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: word },
        })),
        { type: "content_block_stop", index: 0 },
      ]),
    callTools: (calls, call) =>
      anthropicMessage(
        call,
        "tool_use",
        calls.flatMap(({ name, params }, index): ReadonlyArray<WireEvent> => [
          {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: `toolu_${call}_${index}`, name, input: {} },
          },
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(params) },
          },
          { type: "content_block_stop", index },
        ]),
      ),
  },
  "openai-responses": {
    path: "/v1/responses",
    say: (words, call) => {
      const id = `msg_${call}`;

      const message = {
        type: "message",
        id,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: words.join(""), annotations: [] }],
      };

      return openAiResponse(
        call,
        [message],
        [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, status: "in_progress", content: [] },
          },
          ...words.map((delta): WireEvent => ({
            type: "response.output_text.delta",
            item_id: id,
            output_index: 0,
            content_index: 0,
            delta,
          })),
          { type: "response.output_item.done", output_index: 0, item: message },
        ],
      );
    },
    callTools: (calls, call) => {
      const items = calls.map(({ name, params }, index) => ({
        type: "function_call",
        id: `fc_${call}_${index}`,
        call_id: `call_${call}_${index}`,
        name,
        arguments: JSON.stringify(params),
        status: "completed",
      }));

      return openAiResponse(
        call,
        items,
        items.flatMap((item, index): ReadonlyArray<WireEvent> => [
          {
            type: "response.output_item.added",
            output_index: index,
            item: { ...item, arguments: "", status: "in_progress" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: index,
            delta: item.arguments,
          },
          {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: index,
            arguments: item.arguments,
          },
          { type: "response.output_item.done", output_index: index, item },
        ]),
      );
    },
  },
  "openai-chat": {
    path: "/v1/chat/completions",
    say: (words, call) =>
      chatCompletion(call, "stop", [
        { role: "assistant", content: "" },
        ...words.map((content) => ({ content })),
      ]),
    callTools: (calls, call) =>
      chatCompletion(
        call,
        "tool_calls",
        calls.map(({ name, params }, index) => ({
          tool_calls: [
            {
              index,
              id: `call_${call}_${index}`,
              type: "function",
              function: { name, arguments: JSON.stringify(params) },
            },
          ],
        })),
      ),
  },
} satisfies {
  readonly [Api in "anthropic-messages" | "openai-responses" | "openai-chat"]: WireFormat;
};

/**
A request for structured output, which Claude Code sends to title a session. It is a CLI's side call,
not a step of the turn, so it gets a JSON answer with every required field set and leaves the script
alone. Otherwise it would race the turn for the first step.
*/
const decodeSideCall = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      output_config: Schema.Struct({
        format: Schema.Struct({
          type: Schema.Literal("json_schema"),
          schema: Schema.Struct({ required: Schema.Array(Schema.String) }),
        }),
      }),
    }),
  ),
);

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** `calls` with every ref the script names by role and name read from the pages in `body`. */
function filledCalls(
  calls: ReadonlyArray<ScriptedToolCall>,
  body: string,
): Result.Result<ReadonlyArray<ScriptedToolCall>, string> {
  const texts = Option.match(decodeBody(body), { onNone: () => [], onSome: jsonStrings });

  return Result.all(
    calls.map(({ name, params }) =>
      Result.map(fillRefs(params, texts), (filled) => ({ name, params: filled })),
    ),
  );
}

const routes = new Map(Object.values(wireFormats).map((format) => [format.path, format]));

/** Which step answers call N once the script has run out: none, or the script again from the top. */
const stepIndex = {
  fail: (call: number) => call - 1,
  loop: (call: number, length: number) => (call - 1) % length,
} satisfies {
  readonly [AfterLastStep in "fail" | "loop"]: (call: number, length: number) => number;
};

/** How a {@link startMockModel} server answers and where it listens. */
interface MockModelOptions {
  /** The script it starts with. `PUT /mock/script` replaces it. */
  readonly script: ModelScript;
  /** `fail` answers a call past the end with a 500; `loop` starts the script again. */
  readonly afterLastStep: keyof typeof stepIndex;
  /** The pause before each streamed event, so a demo can watch the answer arrive word by word. */
  readonly delayMs: number;
  readonly host: string;
  /** `0` picks a free port; {@link MockModelServer.port} says which. */
  readonly port: number;
}

/** A running mock model server. */
export interface MockModelServer {
  readonly port: number;
  /** The body of every request since the last `PUT /mock/script`, in order: what the runtime sent the model. */
  readonly requests: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: Schema.JsonObject): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function stream(
  response: ServerResponse,
  events: ReadonlyArray<string>,
  delayMs: number,
): Promise<void> {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });

  for (const event of events) {
    await setTimeout(delayMs);
    response.write(event);
  }

  response.end();
}

/**
A model server that replays `script` over HTTP in every API shape we call: Anthropic Messages, OpenAI
Responses and OpenAI Chat Completions. Call N answers with step N, whichever route it arrives on. It
also answers the model lookups the server makes at startup. `PUT /mock/script` with a JSON
{@link ModelScript} replaces the script and starts counting calls and recording requests afresh, so a
verify scenario scripts its own turn on a running stack. `GET /mock/requests` answers
`{ "requests": [...] }`, every body since then, so the scenario can check what the model was shown. A
tool input written as {@link refTo} is filled in from the latest page in the request being answered. Plain Node, so `verify/mock-model.ts` runs it without a build.
*/
export function startMockModel(options: MockModelOptions): Promise<MockModelServer> {
  let script = options.script;
  let calls = 0;
  const bodies: Array<string> = [];

  const server = createServer(async (request, response) => {
    const body = await text(request);
    const { pathname } = new URL(request.url ?? "/", "http://mock");
    const format = routes.get(pathname);

    if (request.method === "PUT" && pathname === "/mock/script") {
      return Result.match(decodeModelScript(body), {
        onFailure: (error) => sendJson(response, 400, { error: { message: error.message } }),
        onSuccess: (next) => {
          script = next;
          calls = 0;
          bodies.length = 0;

          return sendJson(response, 200, { steps: next.length });
        },
      });
    }

    if (request.method === "GET" && pathname === "/mock/requests") {
      return sendJson(response, 200, { requests: [...bodies] });
    }

    bodies.push(body);

    if (request.method === "GET" && pathname.startsWith("/v1/models/")) {
      return sendJson(response, 200, { id: model, type: "model", object: "model" });
    }

    if (request.method !== "POST" || format === undefined) {
      return sendJson(response, 404, {
        error: { message: `The mock model has no ${request.method} ${pathname}.` },
      });
    }

    const sideCall = decodeSideCall(body);

    if (Option.isSome(sideCall)) {
      const { required } = sideCall.value.output_config.format.schema;
      const answer = JSON.stringify(Object.fromEntries(required.map((field) => [field, "mock"])));

      return stream(response, format.say([answer], 0), options.delayMs);
    }

    calls += 1;
    const call = calls;

    const step = Array.get(script, stepIndex[options.afterLastStep](call, script.length));

    await Option.match(step, {
      onNone: async () =>
        sendJson(response, 500, {
          error: { type: "script_overrun", message: scriptOverrun(script, call) },
        }),
      onSome: (answer) =>
        Result.match(
          ModelStep.$match(answer, {
            Say: ({ words }) => Result.succeed(format.say(words, call)),
            CallTools: ({ calls: toolCalls }) =>
              Result.map(filledCalls(toolCalls, body), (filled) => format.callTools(filled, call)),
          }),
          {
            onFailure: async (message) =>
              sendJson(response, 500, { error: { type: "unfilled_ref", message } }),
            onSuccess: (events) => stream(response, events, options.delayMs),
          },
        ),
    });
  });

  return new Promise((resolve) => {
    server.listen(options.port, options.host, () => {
      // SAFETY: a server listening on a host and port, not a pipe, reports an `AddressInfo`.
      const { port } = server.address() as AddressInfo;

      resolve({
        port,
        requests: () => [...bodies],
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
          }),
      });
    });
  });
}

/**
The mock model server for one test, stopped when the test's scope closes. Yields the base URL each
provider needs, so a test sets `baseUrl` from it without branching on the provider.
*/
export function mockModel(script: ModelScript) {
  return Effect.acquireRelease(
    Effect.promise(() =>
      startMockModel({ script, afterLastStep: "fail", delayMs: 0, host: "127.0.0.1", port: 0 }),
    ),
    (server) => Effect.promise(() => server.close()),
  ).pipe(
    Effect.map((server) => {
      const origin = `http://127.0.0.1:${server.port}`;

      return {
        anthropic: origin,
        openai: `${origin}/v1`,
        "openai-compat": `${origin}/v1`,
      } satisfies { readonly [P in ModelProvider]: string };
    }),
  );
}
