import { Layer } from "effect";
import { pauseStoreLayer } from "./pause-store.ts";
import { turnsLayer } from "./turns.ts";

/** Which Bot turns run here and whether a Bot may run one. Needs a `SqlClient` and an `AuditLog`. */
export const lifecycleLayer = turnsLayer.pipe(Layer.provide(pauseStoreLayer));

export { migrateLifecycle } from "./migrations.ts";

export { pauseHandlers } from "./rpcs.ts";

export { StopReason, Turns } from "./turns.ts";
