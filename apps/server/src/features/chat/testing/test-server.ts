import { Layer, Ref } from "effect";
import type { SqlClient } from "effect/sql";
import { testBots } from "../../bots/testing/test-bots.ts";
import { testLifecycle } from "../../lifecycle/testing/test-lifecycle.ts";
import { testDatabase } from "./test-database.ts";

/**
What the chat needs beside its agent, as one server has it: the test Bots, and the lifecycle on
`database`, a fresh one with the chat's tables unless two servers share one. The next reads of the pause
state fail while `failures` is above zero.
*/
export function testServer({
  database = testDatabase,
  failures = Ref.makeUnsafe(0),
}: {
  readonly database?: Layer.Layer<SqlClient.SqlClient, Layer.Error<typeof testDatabase>>;
  readonly failures?: Ref.Ref<number>;
} = {}) {
  return Layer.mergeAll(testLifecycle(failures), testBots).pipe(Layer.provideMerge(database));
}
