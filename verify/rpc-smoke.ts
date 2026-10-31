import { randomUUID } from "node:crypto";
import { Effect, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { ChatRpcs, ConversationId, MessageId } from "../packages/domain/src/index.ts";

/**
Talks to a running server the way the web app does: Effect RPC over the `/rpc` WebSocket. Opens a new
conversation, sends one message, prints the streamed events, then opens it again to see what was stored.
Usage: `node verify/rpc-smoke.ts [ws://localhost:3000/rpc]`.
*/

const url = process.argv[2] ?? "ws://localhost:3000/rpc";

const conversationId = ConversationId.make(randomUUID());

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`smoke failed: ${message}`);
  console.log(`ok: ${message}`);
}

const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(url)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

const smoke = Effect.gen(function* () {
  const client = yield* RpcClient.make(ChatRpcs);

  const before = yield* client["Chat.open"]({ conversationId });
  console.log("open (new):", JSON.stringify(before));
  check(before.messages.length === 0, "a new conversation has no messages");

  const started = Date.now();

  const events = yield* client["Chat.send"]({
    conversationId,
    messageId: MessageId.make(randomUUID()),
    text: "Say hi in five words",
  }).pipe(
    Stream.tap((event) =>
      Effect.sync(() => console.log(`+${Date.now() - started}ms`, JSON.stringify(event))),
    ),
    Stream.runCollect,
  );

  const deltas = events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT");
  check(events[0]?.type === "RUN_STARTED", "the turn starts with RUN_STARTED");
  check(deltas.length > 1, `the answer streamed in ${deltas.length} pieces`);
  check(events.at(-1)?.type === "RUN_FINISHED", "the turn ends with RUN_FINISHED");

  const after = yield* client["Chat.open"]({ conversationId });
  console.log("open (again):", JSON.stringify(after));
  check(
    after.messages.map((message) => message.role).join(",") === "user,assistant",
    "both messages were stored",
  );
  check(!after.isRunning, "no turn is running");
});

await Effect.runPromise(smoke.pipe(Effect.provide(protocol), Effect.scoped));
