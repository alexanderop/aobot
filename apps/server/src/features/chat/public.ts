import { Layer } from "effect";
import { conversationStoreLayer } from "./conversation-store.ts";
import { chatHandlersLayer } from "./handlers.ts";

/** The chat RPC handlers with their SQLite store. Needs an `AgentRuntime`, `Bots`, `Turns` and a `SqlClient`. */
export const chatLayer = chatHandlersLayer.pipe(Layer.provide(conversationStoreLayer));

export { adoptUnowned, migrateChat } from "./migrations.ts";
