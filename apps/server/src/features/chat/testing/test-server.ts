import { Layer, Ref } from "effect";
import { testBots } from "../../bots/testing/test-bots.ts";
import { testLifecycle } from "../../lifecycle/testing/test-lifecycle.ts";
import { testDatabase } from "./test-database.ts";

/**
What the chat needs beside its agent, as one server has it: the test Bots, and the lifecycle on a fresh
database that has the chat's tables too. The next reads of the pause state fail while `failures` is
above zero.
*/
export function testServer(failures: Ref.Ref<number> = Ref.makeUnsafe(0)) {
  return Layer.mergeAll(testLifecycle(failures), testBots).pipe(Layer.provideMerge(testDatabase));
}
