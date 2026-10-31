import { Layer } from "effect";
import { conversationStoreLayer } from "./conversation-store.ts";
import { chatHandlersLayer } from "./handlers.ts";
import { runLeaseLayer } from "./run-lease.ts";

/** The chat RPC handlers with their Postgres store and lease. Needs an `AgentRuntime` and a `SqlClient`. */
export const chatLayer = chatHandlersLayer.pipe(
  Layer.provide([conversationStoreLayer, runLeaseLayer]),
);

export { migrateChat } from "./migrations.ts";
