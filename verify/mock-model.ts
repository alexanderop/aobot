import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
A stand-in model for demos and smoke tests: speaks OpenAI Chat Completions and answers every request
with the same sentence, word by word. Start it with `node verify/mock-model.ts [port]`.
*/

const port = Number(process.argv[2] ?? process.env.MOCK_MODEL_PORT ?? 4010);

const delayMs = Number(process.env.MOCK_MODEL_DELAY_MS ?? 150);

const words = ["Hi", " there,", " nice", " to", " meet", " you!"];

/** What one streamed chunk adds to the answer. */
interface Delta {
  readonly role?: "assistant";
  readonly content?: string;
}

function chunk(model: string, delta: Delta, finishReason: string | null): string {
  const body = {
    id: "mock-completion",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };

  return `data: ${JSON.stringify(body)}\n\n`;
}

async function readJson(request: IncomingMessage): Promise<{ model?: string; stream?: boolean }> {
  let text = "";

  for await (const part of request) text += part;

  return text.length === 0 ? {} : JSON.parse(text);
}

async function streamAnswer(response: ServerResponse, model: string): Promise<void> {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(chunk(model, { role: "assistant", content: "" }, null));

  for (const word of words) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response.write(chunk(model, { content: word }, null));
  }

  response.write(chunk(model, {}, "stop"));

  const usage = {
    prompt_tokens: 1,
    completion_tokens: words.length,
    total_tokens: words.length + 1,
  };

  response.write(
    `data: ${JSON.stringify({ id: "mock-completion", object: "chat.completion.chunk", created: 0, model, choices: [], usage })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function answerAtOnce(response: ServerResponse, model: string): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "mock-completion",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: words.join("") },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: words.length, total_tokens: words.length + 1 },
    }),
  );
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://mock");
  console.log(`${request.method} ${url.pathname}`);

  const modelLookup = url.pathname.match(/^\/v1\/models\/(.+)$/);

  if (request.method === "GET" && modelLookup !== null) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ id: decodeURIComponent(modelLookup[1]), object: "model", owned_by: "mock" }),
    );

    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = await readJson(request);
    const model = body.model ?? "mock";

    if (body.stream === true) await streamAnswer(response, model);
    else answerAtOnce(response, model);

    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: `mock model has no ${url.pathname}` } }));
});

server.listen(port, "0.0.0.0", () => console.log(`mock model listening on :${port}`));
