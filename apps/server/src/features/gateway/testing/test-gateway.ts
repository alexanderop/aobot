import type { ComputerAction } from "@aobot/domain";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { auditLogLayer, migrateAudit } from "../../audit/public.ts";
import { testBots } from "../../bots/testing/test-bots.ts";
import { type Computer, Computers } from "../../computers/public.ts";
import { everyTurnLive } from "../../lifecycle/testing/test-lifecycle.ts";
import { fakeComputer } from "../../computers/testing/fake-computer.ts";
import type { Policy } from "../../policy/public.ts";
import { allowEverything } from "../../policy/testing/test-policy.ts";
import { gatewayLayer } from "../gateway.ts";
import { migrateGateway } from "../migrations.ts";

/**
A computer that answers with `answers`, and keeps every page, command and file action it was sent. It is
running and starts at once, unless `computers` says how `ensure` or `running` answer instead.
*/
export function fakeComputers(
  answers: Partial<Computer>,
  computers: Partial<Pick<Computers["Service"], "ensure" | "running">> = {},
) {
  const actions: Array<ComputerAction> = [];
  const answering = fakeComputer(answers);

  const computer: Computer = {
    ...answering,
    browse: (action) =>
      Effect.andThen(
        Effect.sync(() => actions.push(action)),
        answering.browse(action),
      ),
    run: (command) =>
      Effect.andThen(
        Effect.sync(() => actions.push(command)),
        answering.run(command),
      ),
    files: (action) =>
      Effect.andThen(
        Effect.sync(() => actions.push(action)),
        answering.files(action),
      ),
  };

  const layer = Layer.succeed(
    Computers,
    Computers.of({
      ensure: Effect.succeed(computer),
      running: Effect.succeed(computer),
      stop: Effect.void,
      reset: Effect.void,
      list: Effect.succeed([]),
      screen: Stream.never,
      ...computers,
    }),
  );

  return { actions, layer };
}

/** A fresh database in memory for each test, with the audit and gateway tables. */
export const database = Layer.effectDiscard(Effect.andThen(migrateAudit, migrateGateway)).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.fresh,
);

/**
A gateway on the database in the context, as one server start would build it, judging by `policy`, where
every turn a call names still runs.
*/
export function startGateway(
  computers: Layer.Layer<Computers>,
  policy: Layer.Layer<Policy> = allowEverything,
) {
  return gatewayLayer.pipe(
    Layer.provide(auditLogLayer),
    Layer.provide(computers),
    Layer.provide(testBots),
    Layer.provide(policy),
    Layer.provide(everyTurnLive),
  );
}

/** Every audit row, oldest first. */
export const auditRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql`
    SELECT id, trace_id, initiator_kind, decision, action, detail, outcome_of
    FROM audit_rows ORDER BY seq
  `;
});

/** Each audit row as `action · decision` and its detail, oldest first. */
export const decodedTrail = Effect.map(auditRows, (rows) =>
  rows.map((row) => [
    `${String(row["action"])} · ${String(row["decision"])}`,
    JSON.parse(String(row["detail"])),
  ]),
);
