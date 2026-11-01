import {
  type BotId,
  ComputerAction,
  commandTimeLimit,
  RunCommand,
  snapshotRefs,
} from "@aobot/domain";
import { Context, Duration, Effect, Layer, Match, Option, Result, Schema } from "effect";
import { AuditLog, type Outcome } from "../audit/public.ts";
import {
  type Computer,
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
import { ComputerControl, controlDoors } from "./control.ts";
import { personAudit } from "./person-audit.ts";
import { endAttributes, presentCommand, presentPage } from "./present.ts";
import { snapshotStore } from "./snapshot-store.ts";
import { spanEvent } from "./span-event.ts";

/** Something an agent asked for that the gateway turned down. `detail` is already redacted. */
export interface Refusal {
  /** The CLI or runtime that asked, such as `claude-code`. */
  readonly agent: string;
  /** What it asked for, such as `terminal/create`. */
  readonly action: string;
  readonly detail: Schema.JsonObject;
}

/**
What a Bot asks for, in the words of its tools: an element is a ref from its latest snapshot. The gateway
resolves each ref into the {@link RefTarget} the computer is sent.
*/
export const BotRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("navigate"), url: Schema.String }),
  Schema.Struct({ action: Schema.Literal("snapshot") }),
  Schema.Struct({ action: Schema.Literal("click"), ref: Schema.String }),
  Schema.Struct({ action: Schema.Literal("type"), ref: Schema.String, text: Schema.String }),
  RunCommand,
]).pipe(Schema.toTaggedUnion("action"));

/** A decoded {@link BotRequest}. */
export type BotRequest = typeof BotRequest.Type;

/** The only door a Bot's actions go through. */
export class Gateway extends Context.Service<
  Gateway,
  {
    readonly refuse: (refusal: Refusal) => Effect.Effect<void>;
    /**
    Refuses the call while a person holds the Bot's computer. Otherwise resolves its ref against the
    Bot's latest snapshot, records the call, forwards it to the computer, records what became of it, and
    answers what the model reads. A call that could not be carried out is a `ToolFailed` the model reads,
    never a dead turn.
    */
    readonly act: (bot: BotId, request: BotRequest) => Effect.Effect<string, ToolFailed>;
  }
>()("aobot/gateway/Gateway") {}

type ActionName = ComputerAction["action"];

/** A ref the gateway could not find in the Bot's latest snapshot, so the call is denied. */
class UnknownRef extends Schema.TaggedError<UnknownRef>()("UnknownRef", {
  ref: Schema.String,
  reason: Schema.String,
}) {}

/** What the model reads when its ref is not in its latest snapshot. */
function unknownRefAnswer(action: ActionName, ref: string): string {
  return `${action} did not run: ${ref} is not a ref in your latest snapshot. Take a snapshot and use a ref from it.`;
}

/** What the model reads, whatever it asked for, while a person holds its computer. */
function personHasControlAnswer(action: ActionName): string {
  return `${action} did not run: a person has control of your computer. Wait until they hand it back, then take a snapshot.`;
}

interface Forwarding {
  readonly timeout: Duration.Duration;
  readonly source: string;
  readonly whenUnknown: string;
}

/** Past the computer's own limit, so a command that runs too long answers as timed out, not unknown. */
const pastTheComputersLimit = Duration.sum(commandTimeLimit, Duration.seconds(5));

const onAPage = "take a snapshot before trying again";

const forwarding = {
  navigate: { timeout: Duration.seconds(45), source: "web page", whenUnknown: onAPage },
  snapshot: { timeout: Duration.seconds(20), source: "web page", whenUnknown: onAPage },
  click: { timeout: Duration.seconds(60), source: "web page", whenUnknown: onAPage },
  type: { timeout: Duration.seconds(30), source: "web page", whenUnknown: onAPage },
  run: {
    timeout: pastTheComputersLimit,
    source: "command output",
    whenUnknown: "check the workspace, for example with ls, before running it again",
  },
} satisfies { readonly [Name in ActionName]: Forwarding };

const auditCommandLimit = 2_000;

/**
The audit row's `detail`. Text a Bot typed into a page goes through `redact()`; a URL is not typed text,
and the command is what the audit row exists to show.
*/
const auditDetail = ComputerAction.match({
  navigate: ({ url }): Schema.JsonObject => ({ url }),
  snapshot: (): Schema.JsonObject => ({}),
  click: ({ target }): Schema.JsonObject => ({ ...target }),
  type: ({ target, text }): Schema.JsonObject => ({ ...target, text: redact(text) }),
  run: ({ command }): Schema.JsonObject => ({ command: capText(command, auditCommandLimit) }),
});

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
  const unknownAfter = `Whether ${name} happened is unknown; ${forwarding[name].whenUnknown}.`;

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

/**
The {@link Gateway}: one audit row per decision, and one outcome row per allowed call. The same layer
provides {@link ComputerControl}, so a person's take and the Bot's actions meet at one door per Bot.
*/
export const gatewayLayer = Layer.effectContext(
  Effect.gen(function* () {
    const audit = yield* AuditLog;
    const rows = yield* personAudit;
    const computers = yield* Computers;
    const snapshots = yield* snapshotStore;
    const doors = yield* controlDoors;

    // Before anything is forwarded: a call an earlier run allowed and never heard back from is
    // recorded as unknown, never run again.
    const unfinished = yield* audit.settleUnfinished;

    if (unfinished > 0) {
      yield* Effect.logWarning(
        "Allowed calls from an earlier run had no outcome; recorded unknown",
      ).pipe(Effect.annotateLogs({ calls: unfinished }));
    }

    const refuse = Effect.fn("Gateway.refuse")(function* (refusal: Refusal) {
      yield* rows
        .decide("deny", refusal.action, { agent: refusal.agent, request: refusal.detail })
        .pipe(Effect.orDie);
    });

    const targetOf = Effect.fn("Gateway.resolveRef")(function* (bot: BotId, ref: string) {
      const latest = yield* snapshots
        .latest(bot)
        .pipe(
          Effect.mapError(
            () => new UnknownRef({ ref, reason: "the latest snapshot could not be read" }),
          ),
        );

      if (Option.isNone(latest)) {
        return yield* new UnknownRef({ ref, reason: "there is no snapshot yet" });
      }

      const target = snapshotRefs(latest.value).get(ref);

      if (target === undefined) {
        return yield* new UnknownRef({ ref, reason: "not in the latest snapshot" });
      }

      return target;
    });

    const forward = (
      bot: BotId,
      computer: Computer,
      action: ComputerAction,
    ): Effect.Effect<string, ComputerActFailed | ComputerLost> =>
      action.action === "run"
        ? computer.run(action).pipe(
            Effect.tap(({ end }) => Effect.annotateCurrentSpan(endAttributes(end))),
            Effect.map(presentCommand),
          )
        : computer.browse(action).pipe(
            Effect.tap((page) =>
              snapshots.save(bot, page.snapshot).pipe(
                // Its refs then resolve against an older page, which the computer refuses as stale.
                Effect.catchTag("SqlError", (error) =>
                  Effect.logWarning("The latest snapshot could not be stored").pipe(
                    Effect.annotateLogs({ action: page.action, reason: error.message }),
                  ),
                ),
              ),
            ),
            Effect.map(presentPage),
          );

    const resolve = (bot: BotId, request: BotRequest): Effect.Effect<ComputerAction, UnknownRef> =>
      BotRequest.match(request, {
        navigate: (navigate) => Effect.succeed(navigate),
        snapshot: (snapshot) => Effect.succeed(snapshot),
        click: ({ ref }) =>
          Effect.map(targetOf(bot, ref), (target) => ({ action: "click", target }) as const),
        type: ({ ref, text }) =>
          Effect.map(targetOf(bot, ref), (target) => ({ action: "type", target, text }) as const),
        run: (run) => Effect.succeed(run),
      });

    /** Records a `deny` row for `action` and tells the model `answer`. */
    const deny = Effect.fnUntraced(function* (
      action: ActionName,
      detail: Schema.JsonObject,
      answer: string,
    ) {
      yield* Effect.annotateCurrentSpan({ "gateway.outcome": "deny" });

      yield* rows
        .decide("deny", action, detail)
        .pipe(
          Effect.catchTag("AuditWriteFailed", (error) =>
            Effect.logError("A deny row could not be written").pipe(
              Effect.annotateLogs({ action, reason: error.message }),
            ),
          ),
        );

      return yield* new ToolFailed({ message: answer });
    });

    const carryOut = Effect.fnUntraced(function* (bot: BotId, request: BotRequest) {
      // A ref is resolved before anything else, so the rules E2 brings judge the element, not its ref.
      const action = yield* resolve(bot, request);

      // Grants and rules arrive with E2. Until then everything is allowed, and still recorded first.
      const allowRow = yield* rows.decide("allow", action.action, auditDetail(action)).pipe(
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

      const forwarded = yield* Effect.gen(function* () {
        const computer = yield* computers.ensure;

        return yield* forward(bot, computer, action).pipe(toolResult(forwarding[action.action]));
      }).pipe(
        Effect.result,
        Effect.onInterrupt(() =>
          rows.settle(allowRow, "unknown", { reason: "the turn was stopped" }),
        ),
      );

      const settled = settle(action.action, forwarded);
      yield* Effect.annotateCurrentSpan({ "gateway.outcome": settled.outcome });
      yield* rows.settle(allowRow, settled.outcome, settled.detail);

      return yield* Effect.fromResult(settled.answer);
    });

    const act = Effect.fn("Gateway.act")(function* (bot: BotId, request: BotRequest) {
      yield* Effect.annotateCurrentSpan({ "gateway.action": request.action });

      // A Bot's commands run one at a time, in the order it asked for them.
      const queued = request.action === "run";

      return yield* doors.admit(bot, carryOut(bot, request), { queued }).pipe(
        Effect.catchTags({
          PersonHasControl: () =>
            spanEvent("control.refused").pipe(
              Effect.andThen(
                deny(
                  request.action,
                  { reason: "a person has control" },
                  personHasControlAnswer(request.action),
                ),
              ),
            ),
          UnknownRef: ({ ref, reason }) =>
            deny(request.action, { ref, reason }, unknownRefAnswer(request.action, ref)),
        }),
      );
    });

    return Context.make(Gateway, Gateway.of({ refuse, act })).pipe(
      Context.add(ComputerControl, doors.control),
    );
  }),
);
