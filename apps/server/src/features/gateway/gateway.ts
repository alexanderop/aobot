import { ComputerAction, type ComputerActResult } from "@aobot/domain";
import { Context, Duration, Effect, Layer, Match, Option, Result, type Schema } from "effect";
import { AuditLog, type Outcome } from "../audit/public.ts";
import {
  type ComputerActFailed,
  type ComputerLost,
  Computers,
  type ComputerUnavailable,
} from "../computers/public.ts";
import {
  capText,
  outsideText,
  ToolFailed,
  type ToolTimedOut,
  toolResult,
} from "../../shared/tool-result.ts";
import { redact } from "../../shared/redact.ts";

/** Something an agent asked for that the gateway turned down. `detail` is already redacted. */
export interface Refusal {
  /** The CLI or runtime that asked, such as `claude-code`. */
  readonly agent: string;
  /** What it asked for, such as `terminal/create`. */
  readonly action: string;
  readonly detail: Schema.JsonObject;
}

/** The only door a Bot's actions go through. */
export class Gateway extends Context.Service<
  Gateway,
  {
    readonly refuse: (refusal: Refusal) => Effect.Effect<void>;
    /**
    Records the call, forwards it to the computer, records what became of it, and answers what the model
    reads. A call the computer could not carry out is a `ToolFailed` the model reads, never a dead turn.
    */
    readonly act: (action: ComputerAction) => Effect.Effect<string, ToolFailed>;
  }
>()("aobot/gateway/Gateway") {}

type ActionName = ComputerAction["action"];

/** How long the computer may take over each action once it is running. Starting it is not counted. */
const timeouts = {
  navigate: Duration.seconds(45),
  snapshot: Duration.seconds(20),
  click: Duration.seconds(60),
  type: Duration.seconds(30),
} satisfies { readonly [Name in ActionName]: Duration.Duration };

/** The audit row's `detail`. Text a Bot typed goes through `redact()`; a URL is not typed text. */
const auditDetail = ComputerAction.match({
  navigate: ({ url }): Schema.JsonObject => ({ url }),
  snapshot: (): Schema.JsonObject => ({}),
  click: ({ target }): Schema.JsonObject => ({ ...target }),
  type: ({ target, text }): Schema.JsonObject => ({ ...target, text: redact(text) }),
});

/** What the model is told the computer answered, before it is marked untrusted. */
function present({ url, title, snapshot, truncated }: ComputerActResult): string {
  return [
    `URL: ${url}`,
    `Title: ${title}`,
    "",
    snapshot,
    ...(truncated ? ["[the computer cut this snapshot short]"] : []),
  ].join("\n");
}

/** Why a forwarded call did not come back with a result. */
type ForwardFailure = ComputerUnavailable | ComputerActFailed | ComputerLost | ToolTimedOut;

/** What a forwarded call became: its outcome row, and what the model is told. */
interface Settled {
  readonly outcome: Outcome;
  readonly detail: Schema.JsonObject;
  readonly answer: Result.Result<string, ToolFailed>;
}

/** The longest computer message kept in an audit row. */
const auditMessageLimit = 500;

function settle(name: ActionName, result: Result.Result<string, ForwardFailure>): Settled {
  const failed = (message: string) => Result.fail(new ToolFailed({ message }));
  const unknownAfter = `Whether ${name} happened is unknown; take a snapshot before trying again.`;

  return Result.match(result, {
    onSuccess: (text): Settled => ({
      outcome: "succeeded",
      detail: {},
      answer: Result.succeed(text),
    }),
    onFailure: Match.typeTags<ForwardFailure, Settled>()({
      ComputerUnavailable: ({ message }) => ({
        outcome: "failed",
        detail: { reason: "unavailable", message: capText(message, auditMessageLimit) },
        answer: failed(`Your computer could not be started, so ${name} did not run. ${message}`),
      }),
      ComputerActFailed: ({ reason, message }) => ({
        outcome: "failed",
        detail: { reason, message: capText(message, auditMessageLimit) },
        answer: failed(
          `${name} did not happen: the computer ${reason === "refused" ? "refused it" : "tried and failed"}.\n${outsideText(message, "computer")}`,
        ),
      }),
      ComputerLost: ({ message }) => ({
        outcome: "unknown",
        detail: { reason: "lost", message: capText(message, auditMessageLimit) },
        answer: failed(`The computer stopped answering. ${unknownAfter}`),
      }),
      ToolTimedOut: ({ timeoutMs }) => ({
        outcome: "unknown",
        detail: { reason: "timeout", timeoutMs },
        answer: failed(
          `The computer did not finish within ${Duration.format(Duration.millis(timeoutMs))}, so it was stopped. ${unknownAfter}`,
        ),
      }),
    }),
  });
}

// No sign-in exists yet, so every call is for the one person using this server. E3 brings people.
const actorId = "single-user";

/** The {@link Gateway}: one audit row per decision, and one outcome row per allowed call. */
export const gatewayLayer = Layer.effect(
  Gateway,
  Effect.gen(function* () {
    const audit = yield* AuditLog;
    const computers = yield* Computers;

    // Before anything is forwarded: a call an earlier run allowed and never heard back from is
    // recorded as unknown, never run again.
    const unfinished = yield* audit.settleUnfinished;

    if (unfinished > 0) {
      yield* Effect.logWarning(
        "Allowed calls from an earlier run had no outcome; recorded unknown",
      ).pipe(Effect.annotateLogs({ calls: unfinished }));
    }

    const refuse = Effect.fn("Gateway.refuse")(function* (refusal: Refusal) {
      const span = yield* Effect.option(Effect.currentSpan);

      yield* audit
        .record({
          traceId: Option.map(span, (current) => current.traceId),
          // A refusal comes from an `acp` turn, and `acp` only runs in single-user mode: the one
          // person at the keyboard is who it was for.
          initiatorKind: "person",
          actorId,
          decision: "deny",
          action: refusal.action,
          detail: { agent: refusal.agent, request: refusal.detail },
        })
        .pipe(Effect.orDie);
    });

    const act = Effect.fn("Gateway.act")(function* (action: ComputerAction) {
      const span = yield* Effect.option(Effect.currentSpan);
      yield* Effect.annotateCurrentSpan({ "gateway.action": action.action });

      // Grants and rules arrive with E2. Until then everything is allowed, and still recorded first.
      const allowRow = yield* audit
        .record({
          traceId: Option.map(span, (current) => current.traceId),
          initiatorKind: "person",
          actorId,
          decision: "allow",
          action: action.action,
          detail: auditDetail(action),
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.logError(
              "An audit row could not be written, so the action was not forwarded",
            ).pipe(Effect.annotateLogs({ action: action.action, reason: error.message })),
          ),
          Effect.mapError(
            () =>
              new ToolFailed({
                message: `${action.action} did not run: it could not be recorded, and nothing runs unrecorded.`,
              }),
          ),
        );

      const recordOutcome = (outcome: Outcome, detail: Schema.JsonObject) =>
        audit.recordOutcome({ allowRow, initiatorKind: "person", outcome, detail }).pipe(
          // The start-up sweep turns a missing outcome into `unknown`, so this never needs a retry.
          Effect.catchTag("AuditWriteFailed", (error) =>
            Effect.logWarning("An outcome row could not be written").pipe(
              Effect.annotateLogs({ action: action.action, reason: error.message }),
            ),
          ),
        );

      const forwarded = yield* Effect.gen(function* () {
        const computer = yield* computers.ensure;

        return yield* computer
          .act(action)
          .pipe(
            Effect.map(present),
            toolResult({ source: "web page", timeout: timeouts[action.action] }),
          );
      }).pipe(
        Effect.result,
        Effect.onInterrupt(() => recordOutcome("unknown", { reason: "the turn was stopped" })),
      );

      const settled = settle(action.action, forwarded);
      yield* Effect.annotateCurrentSpan({ "gateway.outcome": settled.outcome });
      yield* recordOutcome(settled.outcome, settled.detail);

      return yield* Effect.fromResult(settled.answer);
    });

    return Gateway.of({ refuse, act });
  }),
);
