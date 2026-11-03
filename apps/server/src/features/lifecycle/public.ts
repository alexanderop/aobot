import { Layer } from "effect";
import { pauseStoreLayer } from "./pause-store.ts";
import { turnsLayer } from "./turns.ts";

/**
Which Bot turns run here, whether a Bot may run one, and whether a turn still runs. Needs a `SqlClient`
and an `AuditLog`.
*/
export const lifecycleLayer = turnsLayer.pipe(Layer.provide(pauseStoreLayer));

export { migrateLifecycle } from "./migrations.ts";

export { pauseHandlers } from "./rpcs.ts";

export { LiveTurns, Turns, TurnStopped } from "./turns.ts";
