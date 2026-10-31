import { Context, Effect, Layer, Option, type Schema } from "effect";
import { AuditLog } from "../audit/public.ts";

/** Something an agent asked for that the gateway turned down. `detail` is already redacted. */
export interface Refusal {
  /** The CLI or runtime that asked, such as `claude-code`. */
  readonly agent: string;
  /** What it asked for, such as `terminal/create`. */
  readonly action: string;
  readonly detail: Schema.JsonObject;
}

/** The only door a Bot's actions go through. Today it only refuses; E1-1 adds tools it forwards. */
export class Gateway extends Context.Service<
  Gateway,
  {
    readonly refuse: (refusal: Refusal) => Effect.Effect<void>;
  }
>()("aobot/gateway/Gateway") {}

/** The {@link Gateway}, writing one audit row per decision. */
export const gatewayLayer = Layer.effect(
  Gateway,
  Effect.gen(function* () {
    const audit = yield* AuditLog;

    const refuse = Effect.fn("Gateway.refuse")(function* (refusal: Refusal) {
      const span = yield* Effect.option(Effect.currentSpan);

      yield* audit.record({
        traceId: Option.map(span, (current) => current.traceId),
        // A refusal comes from an `acp` turn, and `acp` only runs in single-user mode: the one
        // person at the keyboard is who it was for.
        initiatorKind: "person",
        actorId: "single-user",
        decision: "deny",
        action: refusal.action,
        detail: { agent: refusal.agent, request: refusal.detail },
      });
    });

    return Gateway.of({ refuse });
  }),
);
