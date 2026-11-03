import { Layer, Stream } from "effect";
import { AgentEvent, AgentRuntime } from "../../agent/public.ts";

/** A Bot that says "One" and then works on forever, until its turn is stopped. */
export const workingAgent = Layer.succeed(
  AgentRuntime,
  AgentRuntime.of({
    run: () => Stream.concat(Stream.make(AgentEvent.TextDelta({ text: "One" })), Stream.never),
  }),
);
