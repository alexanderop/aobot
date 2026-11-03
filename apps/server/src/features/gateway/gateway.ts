import {
  type AcpClientMethod,
  type ApprovalAnsweredBy,
  type AuditAction,
  BotId,
  ComputerAction,
  commandTimeLimit,
  escapesWorkspace,
  FileAction,
  type PageAction,
  PressKey,
  type RefTarget,
  RunCommand,
  SecretAnswer,
  type SecretValue,
  snapshotRefs,
  type ToolName,
  workspaceRoot,
} from "@aobot/domain";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import {
  AuditLog,
  auditRows,
  type AuditRowId,
  type AuditWriteFailed,
  type Decision,
  type Outcome,
  type RefusalDecision,
} from "../audit/public.ts";
import { Bots, isGranted } from "../bots/public.ts";
import { LiveTurns } from "../lifecycle/public.ts";
import { type Allowed, Policy, Refused, Verdict } from "../policy/public.ts";
import {
  type Computer,
  type ComputerActFailed,
  type ComputerLost,
  Computers,
} from "../computers/public.ts";
import {
  capText,
  outsideText,
  ToolFailed,
  type ToolTimedOut,
  toolResult,
} from "../../shared/tool-result.ts";
import { CurrentActor, deployment } from "../../shared/actor.ts";
import { redact, redactCommand, redactUrl } from "../../shared/redact.ts";
import { actionFacts, hostOf } from "./action-facts.ts";
import {
  type ActionChanged,
  type AlreadySpent,
  type AlreadyWaiting,
  type Answered,
  ApprovalRequests,
  approvalRequests,
  type DeclinedEarlier,
  type HeldQuestion,
  type LeftOpen,
  type LedgerFailed,
  type OpenApproval,
  type OutcomeUnknown,
} from "./approvals.ts";
import { ComputerControl, controlDoors, type PersonHasControl } from "./control.ts";
import { type ComputerFailure, failureOutcome } from "./computer-failure.ts";
import { fileTarget } from "./file-target.ts";
import {
  endAttributes,
  fileAttributes,
  presentCommand,
  presentFile,
  presentPage,
} from "./present.ts";
import { safetyAbout, SafetyList, safetyOf } from "./safety.ts";
import { snapshotStore } from "./snapshot-store.ts";
import { spanEvent } from "./span-event.ts";
import { type AlreadyAsked, secretRequests, SecretRequests } from "./secrets.ts";
import { auditAction, DirectAction, SecretRequest, ToolAction } from "./tool-action.ts";
import { TurnRef } from "./turn.ts";
import { FileTransfers, fileTransfers } from "./transfers.ts";

/** Something an agent asked for that the gateway turned down. `detail` is already redacted. */
export interface Refusal {
  /** The Bot whose turn the CLI was running. */
  readonly bot: BotId;
  /** The CLI or runtime that asked, such as `claude-code`. */
  readonly agent: string;
  /** What it asked for, such as `terminal/create`. */
  readonly action: AcpClientMethod;
  readonly detail: Schema.JsonObject;
}

/**
What a Bot asks the computer to do, in the words of its tools: an element is a ref from the latest
snapshot. The gateway resolves each ref into the {@link RefTarget} the computer is sent. A file is a path
inside its workspace.
*/
const DirectRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("navigate"), url: Schema.String }),
  Schema.Struct({ action: Schema.Literal("snapshot") }),
  Schema.Struct({ action: Schema.Literal("click"), ref: Schema.String }),
  Schema.Struct({ action: Schema.Literal("type"), ref: Schema.String, text: Schema.String }),
  Schema.Struct({ action: Schema.Literal("press"), ref: Schema.String, key: PressKey }),
  RunCommand,
  FileAction,
]).pipe(Schema.toTaggedUnion("action"));

/** A decoded {@link DirectRequest}. */
type DirectRequest = typeof DirectRequest.Type;

/**
What a Bot asks for: an action of its computer, or `request_secret`, a secret its person types into the
field a ref names, as the Bot names it for them.
*/
export const BotRequest = Schema.Union([
  DirectRequest,
  Schema.Struct({
    action: Schema.Literal("request_secret"),
    ref: Schema.String,
    field: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("action"));

/** A decoded {@link BotRequest}. */
export type BotRequest = typeof BotRequest.Type;

/**
The Bot a call says it is made for: one named by its id, with the turn it is made in when the call says,
or, from an `acp` CLI whose `aobot-bot` header is no Bot id, that header as it was written. Only a named
Bot can have been granted anything, and only a call in a turn has a person to ask.
*/
export const Claim = Schema.TaggedUnion({
  Named: { bot: BotId, turn: Schema.optionalKey(TurnRef) },
  Unreadable: { header: Schema.String },
  Unnamed: {},
});

/** A decoded {@link Claim}. */
export type Claim = typeof Claim.Type;

/** The only door a Bot's actions go through. */
export class Gateway extends Context.Service<
  Gateway,
  {
    readonly refuse: (refusal: Refusal) => Effect.Effect<void>;
    /**
    Refuses the call when the turn it names no longer runs, then when the Bot it claims was not granted
    its tool, or is no Bot the server knows, before anything else the gateway does, then when it names no
    turn a person started. Every row and rule after that names the person the turn runs for. Then refuses
    it while a person holds the computer. Otherwise resolves its ref against the latest snapshot, judges
    it by the rules, records the call, forwards it to the computer, records what became of it, and
    answers what the model reads. `request_secret` waits for the person's answer outside the door, at
    most {@link secretWaitLimit}, before what they typed is forwarded. A call that could not be carried
    out is a `ToolFailed` the model reads, never a dead turn. A call still running when its turn is
    stopped is cut off there.
    */
    readonly act: (claim: Claim, request: BotRequest) => Effect.Effect<string, ToolFailed>;
  }
>()("aobot/gateway/Gateway") {}

/** What the computer is sent, by its action. */
type ActionName = ComputerAction["action"];

/**
The turn a call names no longer runs here: it was stopped, or ended, so nothing more is done in it, such
as by a CLI that keeps calling tools after its turn was stopped.
*/
class TurnEnded extends Schema.TaggedError<TurnEnded>()("TurnEnded", {}) {}

/** The Bot a call claims was not granted the tool, or is no Bot the server knows, so it is denied. */
class NotGranted extends Schema.TaggedError<NotGranted>()("NotGranted", { claim: Claim }) {}

const claimedHeaderLimit = 100;

/** The Bot a call named by its id, which its audit rows and span record. */
const namedBot = Claim.match({
  Named: ({ bot }) => Option.some(bot),
  Unreadable: () => Option.none<BotId>(),
  Unnamed: () => Option.none<BotId>(),
});

/** The turn a call named, which a question to the person is asked in. */
const turnOf = Claim.match({
  Named: ({ turn }) => Option.fromUndefinedOr(turn),
  Unreadable: () => Option.none<TurnRef>(),
  Unnamed: () => Option.none<TurnRef>(),
});

/** How a refusal names the Bot a call claimed: its id, the header as written, or none. */
const claimedName = Claim.match({
  Named: ({ bot }): string => bot,
  Unreadable: ({ header }) => JSON.stringify(capText(header, claimedHeaderLimit)),
  Unnamed: () => "an unnamed Bot",
});

/** Another Bot read the page after the Bot that sent the ref, so its refs name a page it has not seen. */
const readByAnother = "another Bot read the page since";

/** The database did not answer with the latest snapshot. */
const unreadSnapshot = "the latest snapshot could not be read";

/** Why a ref did not resolve, as its deny row says. */
const RefMiss = Schema.Literals([
  "there is no snapshot yet",
  unreadSnapshot,
  "not in the latest snapshot",
  readByAnother,
]);

/** A ref the gateway could not resolve for the Bot that sent it, so the call is denied. */
class UnknownRef extends Schema.TaggedError<UnknownRef>()("UnknownRef", {
  ref: Schema.String,
  reason: RefMiss,
}) {}

/**
The latest snapshot could not be read, so no rule can tell which page a `snapshot` would read, and it is
denied.
*/
class UnknownPage extends Schema.TaggedError<UnknownPage>()("UnknownPage", {}) {}

/** The rules refused the action, as `verdict` says. */
class RuleRefused extends Schema.TaggedError<RuleRefused>()("RuleRefused", {
  action: ToolAction,
  verdict: Refused,
}) {}

/**
The ask rule `askRule` holds for `action`, on a page at `host`, which the allow rule `allowRule` allows:
it runs only once the person says yes.
*/
class NeedsApproval extends Schema.TaggedError<NeedsApproval>()("NeedsApproval", {
  action: DirectAction,
  host: Schema.String,
  allowRule: Schema.String,
  askRule: Schema.String,
}) {}

/**
`action`, on a page at `path`, falls under the safety list `safety`, so it is handed to the person before
any rule is read.
*/
class HandedOff extends Schema.TaggedError<HandedOff>()("HandedOff", {
  action: ToolAction,
  path: Schema.String,
  safety: SafetyList,
}) {}

/**
The call names no turn of a person, so there is nobody it could be on the authority of: a Bot acts only in
the turn a person started.
*/
class NoPerson extends Schema.TaggedError<NoPerson>()("NoPerson", {}) {}

/** The person, or the time limit on their answer, said no to an asked action. */
class Declined extends Schema.TaggedError<Declined>()("Declined", {
  by: Schema.Literals(["person", "time limit"]),
}) {}

/**
Why the gateway did not carry out a Bot's call: each is one `deny` row, or for {@link HandedOff} one
`hand_off` row, and what the model reads.
*/
type Denial =
  | TurnEnded
  | NotGranted
  | NoPerson
  | AlreadyAsked
  | PersonHasControl
  | UnknownRef
  | UnknownPage
  | HandedOff
  | RuleRefused
  | OutsideWorkspace
  | NoTextField
  | NoSite
  | AlreadyWaiting
  | Declined
  | DeclinedEarlier
  | OutcomeUnknown
  | ActionChanged
  | AlreadySpent
  | LedgerFailed
  | AuditWriteFailed;

/** How much of a failed rule's error a deny row keeps. */
const ruleErrorLimit = 500;

/** The rules that failed on the way, each with its error, capped, for the deny row. */
const failedRules = (broken: ReadonlyArray<{ readonly rule: string; readonly error: string }>) =>
  broken.map(({ rule, error }) => ({ rule, error: capText(error, ruleErrorLimit) }));

/**
What a refusing verdict puts in the deny row, and why the model reads the action did not run. A failed
rule's error stays in the row: it can echo what the action holds, so no log or span gets it.
*/
const ruleRefusal = Refused.match({
  Denied: ({ rule }) => ({
    detail: { rule, reason: "denied by rule" },
    why: `the rule ${rule} refuses it`,
  }),
  DenyRuleFailed: ({ rule, error }) => ({
    detail: { rule, reason: "rule failed", error: capText(error, ruleErrorLimit) },
    why: `the rule ${rule} could not be checked, so it refuses`,
  }),
  NoneAllowed: ({ broken }) => {
    const detail = { rule: null, reason: "no rule allows it" };

    return {
      detail: broken.length === 0 ? detail : { ...detail, failed: failedRules(broken) },
      why: "no rule allows it",
    };
  },
});

/**
The roles of the fields a secret may be typed into: the computer hides what such a field holds once the
secret is in it, and refuses any element but a text input or a textarea itself.
*/
const secretRoles: ReadonlySet<string> = new Set(["textbox", "searchbox"]);

/** A `request_secret` whose ref names no text field, so the call is denied. */
class NoTextField extends Schema.TaggedError<NoTextField>()("NoTextField", {
  action: SecretRequest,
}) {}

/** What the model reads when it asks for a secret for an element that takes no typed text. */
function noTextFieldAnswer({ target }: SecretRequest): string {
  return `request_secret did not run: ${target.ref} is a ${target.role}, not a text field. Ask for a secret only for a textbox or a searchbox.`;
}

/**
A `request_secret` on a page with no host, such as `about:blank` or a `data:` page, so the call is denied:
the person could not be told which site the secret is for.
*/
class NoSite extends Schema.TaggedError<NoSite>()("NoSite", { action: SecretRequest }) {}

/** What the model reads when it asks for a secret on a page that is on no site. */
function noSiteAnswer({ target }: SecretRequest): string {
  return `request_secret did not run: the page ${target.ref} is on has no site, so your person could not tell where the secret goes. Ask for a secret only on a page of the site it is for.`;
}

/** A file action whose path leaves the workspace as it is written, so the call is denied. */
class OutsideWorkspace extends Schema.TaggedError<OutsideWorkspace>()("OutsideWorkspace", {
  action: FileAction,
}) {}

/** What the model reads when it names a file outside its workspace. */
function outsideWorkspaceAnswer({ action, path }: FileAction): string {
  return `${action} did not run: ${path} is outside your workspace. Name a file by its path inside ${workspaceRoot}, such as notes.txt, with no leading / and no "..".`;
}

/** What the model reads when its ref does not resolve. */
function unknownRefAnswer(action: ToolName, { ref, reason }: UnknownRef): string {
  return reason === readByAnother
    ? `${action} did not run: the page changed since you last read it. Take a snapshot and use a ref from it.`
    : `${action} did not run: ${ref} is not a ref in the page's latest snapshot. Take a snapshot and use a ref from it.`;
}

/** What the model reads when no rule can tell which page its `snapshot` would read. */
function unknownPageAnswer(action: ToolName): string {
  return `${action} did not run: the server could not tell which page it would read, so no rule could judge it. Try again.`;
}

/** What the model reads when the rules refuse what it asked for. */
function ruleRefusedAnswer(action: ToolName, why: string): string {
  return `${action} did not run: ${why}. Tell your person what was refused; do not try another way around it.`;
}

/** What the model reads when the safety list `safety` hands what it asked for to its person. */
function handedOffAnswer(action: ToolName, safety: SafetyList): string {
  return `${action} did not run: ${safetyAbout(safety)} is always your person's to do, never a Bot's, whatever the rules say. Stop, tell your person what needs doing, and ask them to take control of your computer and do it themselves.`;
}

/** What the model reads when it asks for a tool it was not granted. */
function notGrantedAnswer(action: ToolName, claim: Claim): string {
  return `${action} did not run: it is not granted to ${claimedName(claim)}. Use only the tools your instructions name.`;
}

/** What the model reads when a row of what it asked for could not be written. */
function unrecordedAnswer(action: ToolName): string {
  return `${action} did not run: it could not be recorded, and nothing runs unrecorded.`;
}

/** What the model reads when it asks for a secret while its last request still waits. */
const alreadyAskedAnswer =
  "request_secret did not run: you already asked your person for a secret, and they have not answered yet. Wait for that answer before asking again.";

/** How long a Bot's request for a secret waits for its person. */
export const secretWaitLimit = Duration.minutes(10);

/** How long an action a rule asks the person about waits for their answer, which is no after it. */
export const approvalWaitLimit = Duration.minutes(10);

/** Why a call ended early: its turn was stopped, by Stop, a pause, or the deployment's check. */
const turnStopped = "the turn was stopped";

/** Why a question an earlier run left open was answered no and refused at start-up. */
const serverStopped = "the server stopped" satisfies ApprovalAnsweredBy;

/** What a Bot is told after its person, or the time limit, said no. */
const holdOff =
  "Do not try it, or another way to do it, until they write to you; tell them it did not run.";

/** Why an asked action did not run after a no, by who said it: its deny row's reason, and why the model reads. */
const declined: Readonly<
  Record<Answered["by"], { readonly reason: string; readonly why: string }>
> = {
  person: { reason: "declined", why: "your person said no" },
  "time limit": {
    reason: "no answer",
    why: `your person did not answer within ${Duration.format(approvalWaitLimit)}, which counts as no`,
  },
};

/** How much of the field a Bot named for its secret its audit rows keep. */
const fieldLimit = 200;

/** What the model reads when its person did not answer its request for a secret in time. */
function noAnswerAnswer({ target }: SecretRequest): string {
  return `Your person did not answer within ${Duration.format(secretWaitLimit)}, so nothing was typed into ${target.ref}. Ask them in the chat whether to go on.`;
}

/** What the model reads when its person declined to give the secret. */
function declinedAnswer({ field }: SecretRequest): string {
  return `Your person declined to type ${JSON.stringify(field)}, so nothing was typed. Do not ask for it again unless they tell you to.`;
}

/** What the model reads once the secret was typed, before the page it then read. */
function suppliedAnswer({ target, field }: SecretRequest, page: string): string {
  return `Your person typed ${JSON.stringify(field)} into ${target.ref}. You never see it: the field shows [hidden].\n${page}`;
}

/** What the model reads, whatever it asked for, while a person holds its computer. */
function personHasControlAnswer(action: ToolName): string {
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

const onAFile = "list your files with list_files before trying again";

const forwarding = {
  navigate: { timeout: Duration.seconds(45), source: "web page", whenUnknown: onAPage },
  snapshot: { timeout: Duration.seconds(20), source: "web page", whenUnknown: onAPage },
  click: { timeout: Duration.seconds(60), source: "web page", whenUnknown: onAPage },
  type: { timeout: Duration.seconds(30), source: "web page", whenUnknown: onAPage },
  press: { timeout: Duration.seconds(60), source: "web page", whenUnknown: onAPage },
  type_secret: { timeout: Duration.seconds(30), source: "web page", whenUnknown: onAPage },
  run: {
    timeout: pastTheComputersLimit,
    source: "command output",
    whenUnknown: "check the workspace, for example with ls, before running it again",
  },
  read_file: { timeout: Duration.seconds(20), source: "file contents", whenUnknown: onAFile },
  write_file: { timeout: Duration.seconds(30), source: "workspace", whenUnknown: onAFile },
  list_files: { timeout: Duration.seconds(20), source: "file list", whenUnknown: onAFile },
} satisfies { readonly [Name in ActionName]: Forwarding };

/**
The longest a tool call runs in the gateway: a request for a secret or an action a rule asks about, which
waits for its person, then the longest a forwarded action may take.
*/
export const longestToolCall = Duration.sum(
  Duration.max(secretWaitLimit, approvalWaitLimit),
  Object.values(forwarding).reduce(
    (longest, { timeout }) => Duration.max(longest, timeout),
    Duration.zero,
  ),
);

const auditCommandLimit = 2_000;

/**
The element a ref named, and the host of the page it was on: what a rule judged. Never the page's whole
address, whose query or fragment can carry a token, such as an OAuth `#access_token=…`.
*/
const refDetail = ({ ref, role, name, url }: RefTarget) => ({ ref, role, name, host: hostOf(url) });

/**
The audit row's `detail`. Text a Bot typed into a page goes through `redact()`. The address `navigate`
opens keeps its path, and the command what it does, since each is what the row exists to show; a secret
in either, such as a query value or `API_TOKEN=…`, is redacted. A file is its path, name and extension,
and for a write its size: never what it holds.
*/
const auditDetail = ToolAction.match({
  navigate: ({ url }) => ({ url: redactUrl(url) }),
  snapshot: () => ({}),
  click: ({ target }) => refDetail(target),
  type: ({ target, text }) => ({ ...refDetail(target), text: redact(text) }),
  press: ({ target, key }) => ({ ...refDetail(target), key }),
  run: ({ command }) => ({ command: capText(redactCommand(command), auditCommandLimit) }),
  read_file: ({ path }) => ({ ...fileTarget(path) }),
  write_file: ({ path, contents }) => ({
    ...fileTarget(path),
    bytes: new TextEncoder().encode(contents).length,
  }),
  list_files: ({ path }) => ({ ...fileTarget(path) }),
  request_secret: ({ target, field }) => ({
    ...refDetail(target),
    field: capText(field, fieldLimit),
  }),
});

/** A page element as a question names it, such as `the button "Delete" on shop.example`. */
const elementOn = ({ role, name, url }: RefTarget) =>
  `the ${role} ${JSON.stringify(name)} on ${hostOf(url) || "a page with no site"}`;

/**
The question a person is asked about an action: worded by the server from the action as it resolved, and
showing what they approve as the Bot wrote it, the whole command, address or text. Only the person's own
page sees it, never an audit row, a log, a span or the conversation, so nothing in it is redacted or cut:
a redacted command can hide the very part a rule asks about.
*/
const questionOf = DirectAction.match({
  navigate: ({ url }) => `Open ${url}?`,
  snapshot: () => "Read the page?",
  click: ({ target }) => `Click ${elementOn(target)}?`,
  type: ({ target, text }) => `Type ${JSON.stringify(text)} into ${elementOn(target)}?`,
  press: ({ target, key }) => `Press ${key} on ${elementOn(target)}?`,
  run: ({ command }) => `Run \`${command}\`?`,
  read_file: ({ path }) => `Read the file ${path}?`,
  write_file: ({ path, contents }) =>
    `Write ${new TextEncoder().encode(contents).length} bytes to the file ${path}?`,
  list_files: ({ path }) => `List the files in ${path}?`,
});

/**
What an audit row's `detail` holds, as a record: lint refuses spreading `Schema.JsonObject`, an interface
it cannot tell from a class instance.
*/
type Detail = Readonly<Record<string, Schema.Json>>;

/** Why a forwarded call did not come back with a result. */
type ForwardFailure = ComputerFailure | ToolTimedOut;

/** What a forwarded call became: its outcome row, and what the model is told. */
interface Settled {
  readonly outcome: Outcome;
  readonly detail: Detail;
  readonly answer: Result.Result<string, ToolFailed>;
}

/**
What became of `name`, forwarded for the tool `tool`: the model reads of the tool it called, so typing a
person's secret is `request_secret`'s.
*/
function settle(
  name: ActionName,
  tool: ToolName,
  result: Result.Result<string, ForwardFailure>,
): Settled {
  const failed = (message: string) => Result.fail(new ToolFailed({ message }));
  const unknownAfter = `Whether ${tool} happened is unknown; ${forwarding[name].whenUnknown}.`;

  return Result.match(result, {
    onSuccess: (text): Settled => ({
      outcome: "succeeded",
      detail: {},
      answer: Result.succeed(text),
    }),
    onFailure: Match.typeTags<ForwardFailure, Settled>()({
      ComputerUnavailable: (failure) => ({
        ...failureOutcome(failure),
        answer: failed(
          `Your computer could not be started, so ${tool} did not run. ${failure.message}`,
        ),
      }),
      ComputerActFailed: (failure) => ({
        ...failureOutcome(failure),
        answer: failed(
          `${tool} did not happen: the computer ${failure.reason === "refused" ? "refused it" : "tried and failed"}.\n${outsideText(failure.message, "computer")}`,
        ),
      }),
      ComputerLost: (failure) => ({
        ...failureOutcome(failure),
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
provides {@link ComputerControl}, so a person's take and every Bot's actions meet at the computer's one
door, {@link FileTransfers}, so a person's files are audited in the same trail, {@link SecretRequests},
where a person answers the secret a Bot asked for, and {@link ApprovalRequests}, where they answer an
action a rule asks them about.
*/
export const gatewayLayer = Layer.effectContext(
  Effect.gen(function* () {
    const audit = yield* AuditLog;
    const bots = yield* Bots;
    const policy = yield* Policy;
    const rows = yield* auditRows("person");
    const computers = yield* Computers;
    const snapshots = yield* snapshotStore;
    const doors = yield* controlDoors;
    const transfers = yield* fileTransfers;
    const secrets = yield* secretRequests;
    const approvals = yield* approvalRequests;
    const turns = yield* LiveTurns;

    /**
    Closes a question an earlier run left open, in rows the deployment writes at start-up on the authority
    of the person it asked.
    */
    const closeInTrail = ({ approval, bot, actorId, tool, rule, answered }: LeftOpen) => {
      const byDeployment = (decision: Decision, action: AuditAction, detail: Schema.JsonObject) =>
        audit.record({
          traceId: Option.none(),
          initiatorKind: "deployment",
          actorId,
          decision,
          action,
          detail,
        });

      return Effect.andThen(
        answered
          ? Effect.void
          : byDeployment("answered", "approval.answered", {
              bot,
              approval,
              answer: "no",
              by: serverStopped,
            }),
        byDeployment("deny", auditAction(tool), { bot, rule, approval, reason: serverStopped }),
      );
    };

    // Before anything is forwarded: a call an earlier run allowed and never heard back from is
    // recorded as unknown, never run again.
    const unfinished = yield* audit.settleUnfinished;

    if (unfinished > 0) {
      yield* Effect.logWarning(
        "Allowed calls from an earlier run had no outcome; recorded unknown",
      ).pipe(Effect.annotateLogs({ calls: unfinished }));
    }

    // Before any question is asked: one an earlier run left open, still waiting for the person or with
    // its yes never spent, is answered no and refused, so every ask row in the trail is closed.
    const leftOpen = yield* approvals.closeLeftOpen(closeInTrail);

    if (leftOpen.length > 0) {
      yield* Effect.logWarning(
        "Questions from an earlier run were left open; answered no and refused",
      ).pipe(Effect.annotateLogs({ questions: leftOpen.length }));
    }

    const refuse = Effect.fn("Gateway.refuse")(function* (refusal: Refusal) {
      yield* rows
        .decide("deny", refusal.action, {
          bot: refusal.bot,
          agent: refusal.agent,
          request: refusal.detail,
        })
        .pipe(Effect.orDie);
    });

    const targetOf = Effect.fn("Gateway.resolveRef")(function* (bot: BotId, ref: string) {
      const latest = yield* snapshots.latest.pipe(
        Effect.mapError(() => new UnknownRef({ ref, reason: unreadSnapshot })),
      );

      if (Option.isNone(latest)) {
        return yield* new UnknownRef({ ref, reason: "there is no snapshot yet" });
      }

      // The role and name come from this snapshot, so the computer's check against the page it shows
      // passes for any ref in it, also one from a page this Bot read before another Bot navigated.
      if (latest.value.readBy !== bot) {
        return yield* new UnknownRef({ ref, reason: readByAnother });
      }

      const shown = snapshotRefs(latest.value.snapshot).get(ref);

      if (shown === undefined) {
        return yield* new UnknownRef({ ref, reason: "not in the latest snapshot" });
      }

      return { target: { ...shown, url: latest.value.url }, path: latest.value.path };
    });

    /** `act` on the element `ref` names for `bot`, and the host and path of the page that element is on. */
    const onElement = <A extends ToolAction>(
      bot: BotId,
      ref: string,
      act: (target: RefTarget) => A,
    ) =>
      Effect.map(targetOf(bot, ref), ({ target, path }) => ({
        action: act(target),
        host: hostOf(target.url),
        path,
      }));

    /** The host of the page the latest snapshot read, whichever Bot read it, or `""` before any. */
    const latestHost = snapshots.latest.pipe(
      Effect.map(Option.match({ onNone: () => "", onSome: ({ url }) => hostOf(url) })),
      Effect.mapError(() => new UnknownPage()),
    );

    const forward = (
      computer: Computer,
      bot: BotId,
      action: ComputerAction,
    ): Effect.Effect<string, ComputerActFailed | ComputerLost> => {
      const browse = (page: PageAction) =>
        computer.browse(page).pipe(
          Effect.tap((read) =>
            snapshots.save(read, bot).pipe(
              // Its refs then resolve against an older page, which the computer refuses as stale.
              Effect.catchTag("SqlError", (error) =>
                Effect.logWarning("The latest snapshot could not be stored").pipe(
                  Effect.annotateLogs({ action: read.action, reason: error.message }),
                ),
              ),
            ),
          ),
          Effect.map(presentPage),
        );

      const files = (file: FileAction) =>
        computer.files(file).pipe(
          Effect.tap((answer) => Effect.annotateCurrentSpan(fileAttributes(answer))),
          Effect.map(presentFile),
        );

      return ComputerAction.match(action, {
        navigate: browse,
        snapshot: browse,
        click: browse,
        type: browse,
        press: browse,
        type_secret: browse,
        run: (command) =>
          computer.run(command).pipe(
            Effect.tap(({ end }) => Effect.annotateCurrentSpan(endAttributes(end))),
            Effect.map(presentCommand),
          ),
        read_file: files,
        write_file: files,
        list_files: files,
      });
    };

    /** A file action as it is, unless its path leaves the workspace. Links only the computer can see. */
    const inWorkspace = (file: FileAction) =>
      escapesWorkspace(file.path)
        ? Effect.fail(new OutsideWorkspace({ action: file }))
        : Effect.succeed(file);

    /**
    `request` as the computer is sent it, and the host of the page it acts on, `""` for none, unless the
    safety list hands it to the person, judged by the path of the page the element it names is on. Every
    call that carries an action out resolves it here, a yes already given included: the page can have
    moved on since the person was asked, to one where the same element is theirs.
    */
    const resolve = (
      bot: BotId,
      request: DirectRequest,
    ): Effect.Effect<
      { readonly action: DirectAction; readonly host: string },
      UnknownRef | UnknownPage | OutsideWorkspace | HandedOff
    > => {
      const offThePage = (action: DirectAction) => Effect.succeed({ action, host: "", path: "" });

      const resolved = DirectRequest.match(request, {
        navigate: (navigate) =>
          Effect.succeed({ action: navigate, host: hostOf(navigate.url), path: "" }),
        snapshot: (snapshot) =>
          Effect.map(latestHost, (host) => ({ action: snapshot, host, path: "" })),
        click: ({ ref }) => onElement(bot, ref, (target) => ({ action: "click", target })),
        type: ({ ref, text }) =>
          onElement(bot, ref, (target) => ({ action: "type", target, text })),
        press: ({ ref, key }) =>
          onElement(bot, ref, (target) => ({ action: "press", target, key })),
        run: offThePage,
        read_file: (file) => Effect.flatMap(inWorkspace(file), offThePage),
        write_file: (file) => Effect.flatMap(inWorkspace(file), offThePage),
        list_files: (file) => Effect.flatMap(inWorkspace(file), offThePage),
      });

      return Effect.flatMap(resolved, ({ action, host, path }) =>
        Option.match(safetyOf(action, path), {
          onNone: () => Effect.succeed({ action, host }),
          onSome: (safety) => Effect.fail(new HandedOff({ action, path, safety })),
        }),
      );
    };

    /**
    The verdict that allows `bot` taking `action` on a page at `host`, naming the ask rule that asks the
    person first when one holds, or a {@link RuleRefused}. A rule that failed is logged by its name and
    list only, never its error, which can echo what the action holds. A refusal's deny row keeps the error
    of every rule that failed, capped; an allowed action's rules that failed are only logged.
    */
    const allowedBy = (
      bot: BotId,
      action: ToolAction,
      host: string,
    ): Effect.Effect<Allowed, RuleRefused> => {
      const failed = (list: "deny" | "allow" | "ask", rule: string) =>
        Effect.logWarning("A rule failed while it was checked").pipe(
          Effect.annotateLogs({ rule, list, action: action.action }),
        );

      const failedRules = (broken: ReadonlyArray<{ readonly rule: string }>) =>
        Effect.forEach(broken, ({ rule }) => failed("allow", rule), { discard: true });

      const refused = (verdict: Refused) => Effect.fail(new RuleRefused({ action, verdict }));

      return Effect.flatMap(CurrentActor, (actor) =>
        Verdict.match(policy.judge(actionFacts(bot, action, host, actor)), {
          Allowed: (allowed) =>
            failedRules(allowed.broken).pipe(
              Effect.andThen(
                Option.match(
                  Option.filter(allowed.ask, (ask) => ask.failed),
                  {
                    onNone: () => Effect.void,
                    onSome: (ask) => failed("ask", ask.rule),
                  },
                ),
              ),
              Effect.as(allowed),
            ),
          Denied: refused,
          DenyRuleFailed: (failure) =>
            Effect.andThen(failed("deny", failure.rule), refused(failure)),
          NoneAllowed: (none) => Effect.andThen(failedRules(none.broken), refused(none)),
        }),
      );
    };

    /** Writes a refusal's row, and only logs it when it cannot be written: the refusal stands. */
    type RefusalRow = (
      decision: RefusalDecision,
      audited: AuditAction,
      detail: Schema.JsonObject,
    ) => Effect.Effect<void>;

    /** Records a `decision` row as `audited` with `write` and tells the model `answer`. */
    const refuseAs = Effect.fnUntraced(function* (
      decision: RefusalDecision,
      audited: AuditAction,
      detail: Schema.JsonObject,
      answer: string,
      write: RefusalRow = rows.refuse,
    ) {
      yield* Effect.annotateCurrentSpan({
        "gateway.decision": decision,
        "gateway.outcome": decision,
      });
      yield* write(decision, audited, detail);

      return yield* new ToolFailed({ message: answer });
    });

    /**
    Writes the `decision` row as `audited`; the action does not go ahead when it fails. Once the person is
    asked, that is refused like any refusal after asking, so a `deny` row closes the question.
    */
    const record = (decision: Decision, audited: AuditAction, detail: Schema.JsonObject) =>
      rows
        .decide(decision, audited, detail)
        .pipe(
          Effect.tapError((error) =>
            Effect.logError(
              "An audit row could not be written, so the action was not forwarded",
            ).pipe(Effect.annotateLogs({ action: audited, decision, reason: error.message })),
          ),
        );

    /** The `allow` row of `action`, allowed by the allow rule `allowRule`, with `more` in its detail. */
    const allowRow = (bot: BotId, action: ToolAction, allowRule: string, more: Detail) =>
      record("allow", auditAction(action.action), {
        bot,
        ...auditDetail(action),
        rule: allowRule,
        ...more,
      });

    /** Marks the call's span as allowed by the allow rule `allowRule`. */
    const allowedByRule = (allowRule: string) =>
      Effect.annotateCurrentSpan({ "gateway.decision": "allow", "gateway.rule": allowRule });

    /**
    Writes the `allow` row of `action`, allowed by the allow rule `allowRule`, with `more` in its detail.
    When it fails, the model is told, and the call has no decision.
    */
    const allow = (bot: BotId, action: ToolAction, allowRule: string, more: Detail) =>
      allowRow(bot, action, allowRule, more).pipe(
        Effect.mapError(() => new ToolFailed({ message: unrecordedAnswer(action.action) })),
        Effect.tap(allowedByRule(allowRule)),
      );

    /** Forwards `action` for `tool`, writes its outcome row on `allowRow`, and answers what the model reads. */
    const forwardAndSettle = Effect.fnUntraced(function* (
      bot: BotId,
      tool: ToolName,
      action: ComputerAction,
      allowRow: AuditRowId,
    ) {
      const forwarded = yield* Effect.gen(function* () {
        const computer = yield* computers.ensure;

        return yield* forward(computer, bot, action).pipe(toolResult(forwarding[action.action]));
      }).pipe(
        Effect.result,
        Effect.onInterrupt(() => rows.settle(allowRow, "unknown", { bot, reason: turnStopped })),
      );

      const settled = settle(action.action, tool, forwarded);
      yield* Effect.annotateCurrentSpan({ "gateway.outcome": settled.outcome });
      yield* rows.settle(allowRow, settled.outcome, { bot, ...settled.detail });

      return yield* Effect.fromResult(settled.answer);
    });

    /**
    Resolves `request`, hands it to the person when the safety list covers it, judges it by the rules,
    writes its `allow` row and forwards it. An action an ask rule holds for leaves the door as
    {@link NeedsApproval}, before any row is written.
    */
    const carryOut = Effect.fnUntraced(function* (bot: BotId, request: DirectRequest) {
      // A ref is resolved before any rule, so the rules judge the element the server's snapshot names,
      // and a ref that does not resolve is denied for that. A path outside the workspace is denied here;
      // the computer still confines every path itself.
      const { action, host } = yield* resolve(bot, request);

      const allowed = yield* allowedBy(bot, action, host);

      if (Option.isSome(allowed.ask)) {
        return yield* new NeedsApproval({
          action,
          host,
          allowRule: allowed.rule,
          askRule: allowed.ask.value.rule,
        });
      }

      const allowRow = yield* allow(bot, action, allowed.rule, {});

      return yield* forwardAndSettle(bot, action.action, action, allowRow);
    });

    /**
    Writes the row of each refusal `self` fails with, `base` first in its detail, with `write`, and tells
    the model why `tool` did not run. A `ToolFailed` is already what the model reads, so it passes on.
    */
    const recordRefusals =
      (tool: ToolName, base: Detail, write: RefusalRow = rows.refuse) =>
      <A, R>(self: Effect.Effect<A, ToolFailed | Denial, R>): Effect.Effect<A, ToolFailed, R> =>
        Effect.catchTag(self, "ToolFailed", Effect.fail, refused(tool, base, write));

    /** The row of `refusal`, `base` first in its detail, written with `write`, and why `tool` did not run. */
    const refused = (tool: ToolName, base: Detail, write: RefusalRow) => {
      const deny = (detail: Detail, answer: string) =>
        refuseAs("deny", auditAction(tool), { ...base, ...detail }, answer, write);

      const notRun = (why: string) => `${tool} did not run: ${why}.`;

      const unrecorded = () => deny({ reason: "not recorded" }, unrecordedAnswer(tool));

      return Match.typeTags<Denial, Effect.Effect<never, ToolFailed>>()({
        TurnEnded: () =>
          deny(
            { reason: "turn ended" },
            notRun("your turn has ended, so nothing more runs in it. Stop calling tools"),
          ),
        AlreadyAsked: () => deny({ reason: "already asked" }, alreadyAskedAnswer),
        NotGranted: ({ claim }) =>
          deny({ reason: `not granted to ${claimedName(claim)}` }, notGrantedAnswer(tool, claim)),
        PersonHasControl: () =>
          spanEvent("control.refused").pipe(
            Effect.andThen(deny({ reason: "a person has control" }, personHasControlAnswer(tool))),
          ),
        UnknownRef: (unknown) =>
          deny({ ref: unknown.ref, reason: unknown.reason }, unknownRefAnswer(tool, unknown)),
        UnknownPage: () => deny({ reason: unreadSnapshot }, unknownPageAnswer(tool)),
        HandedOff: ({ action, path, safety }) =>
          Effect.annotateCurrentSpan({
            "decision.source": "safety",
            "gateway.safety": safety,
          }).pipe(
            Effect.andThen(
              refuseAs(
                "hand_off",
                auditAction(tool),
                { ...base, ...auditDetail(action), path, safety },
                handedOffAnswer(tool, safety),
                write,
              ),
            ),
          ),
        RuleRefused: ({ action, verdict }) => {
          const { detail, why } = ruleRefusal(verdict);

          return Effect.andThen(
            Refused.guards.NoneAllowed(verdict)
              ? Effect.void
              : Effect.annotateCurrentSpan({ "gateway.rule": verdict.rule }),
            deny({ ...auditDetail(action), ...detail }, ruleRefusedAnswer(tool, why)),
          );
        },
        OutsideWorkspace: ({ action }) =>
          deny(
            { ...fileTarget(action.path), reason: "outside workspace" },
            outsideWorkspaceAnswer(action),
          ),
        NoTextField: ({ action }) =>
          deny({ ...auditDetail(action), reason: "not a text field" }, noTextFieldAnswer(action)),
        NoSite: ({ action }) =>
          deny({ ...auditDetail(action), reason: "no site" }, noSiteAnswer(action)),
        NoPerson: () =>
          deny(
            { reason: "no person to act for" },
            notRun(
              "it came from no conversation a person started, and a Bot acts only for its person",
            ),
          ),
        AlreadyWaiting: () =>
          deny(
            { reason: "already waiting" },
            notRun(
              "you already asked your person and they have not answered. Wait for that answer",
            ),
          ),
        Declined: ({ by }) =>
          deny({ reason: declined[by].reason }, `${notRun(declined[by].why)} ${holdOff}`),
        DeclinedEarlier: () =>
          deny(
            { reason: "declined earlier" },
            notRun(
              "your person already said no to this in this conversation. Do not ask again until they write to you",
            ),
          ),
        OutcomeUnknown: () =>
          deny(
            { reason: "outcome unknown" },
            notRun(
              "an action like it that your person approved was started, and its turn ended before you were told what became of it, so whether it happened is unknown, and it was not run again. Check what became of it, for example with ls or a snapshot, before asking again",
            ),
          ),
        ActionChanged: ({ action }) =>
          deny(
            { ...auditDetail(action), reason: "action changed" },
            notRun(
              "what it acts on changed after your person answered, so their answer does not cover it. Take a snapshot and ask again",
            ),
          ),
        AlreadySpent: () =>
          deny(
            { reason: "already spent" },
            notRun("your person's yes was already used once. Ask again"),
          ),
        LedgerFailed: unrecorded,
        AuditWriteFailed: unrecorded,
      });
    };

    /**
    Who `turn` runs for, or {@link TurnEnded} once it no longer runs. Read as a call starts and again once
    the door lets it in, since a command may wait there for the one before it while its turn ends.
    */
    const actorOfTurn = ({ conversation, run }: TurnRef) =>
      Effect.flatMap(
        turns.actorOf(conversation, run),
        Option.match({
          onNone: () => Effect.fail(new TurnEnded()),
          onSome: Effect.succeed,
        }),
      );

    /**
    `effect`, an action of `tool` in `turn`, through the door once its turn is checked again. Commands run
    one at a time, in the order they were asked for, and one cut off while it waits runs `leftQueue`.
    */
    const enter = <A, E, R>(
      tool: ToolName,
      turn: TurnRef,
      effect: Effect.Effect<A, E, R>,
      leftQueue: Effect.Effect<void>,
    ) => {
      const checked = Effect.andThen(actorOfTurn(turn), effect);

      return tool === "run" ? doors.queue(checked, leftQueue) : doors.admit(checked);
    };

    /**
    Writes the row that ends `approval` without its action, in one write with lapsing it. When that fails,
    the question stays open in the ledger, and the next start-up closes it in the trail.
    */
    const closing =
      (approval: OpenApproval): RefusalRow =>
      (decision, audited, detail) =>
        approval
          .close(rows.decide(decision, audited, detail))
          .pipe(
            Effect.ignore({ log: "Error", message: "A refused question could not be closed" }),
            Effect.annotateLogs({ action: audited, approval: approval.id }),
          );

    /**
    Shows `question` to the person and takes their answer to `approval`, in a span of its own that names
    the ask rule `askRule`, the answer and who gave it. A turn stopped meanwhile answers no.
    */
    const askPerson = (bot: BotId, askRule: string, approval: OpenApproval, question: string) =>
      approval
        .ask(question, approvalWaitLimit, ({ answer, by }) =>
          record("answered", "approval.answered", { bot, approval: approval.id, answer, by }),
        )
        .pipe(
          Effect.tap(({ answer, by }) =>
            Effect.annotateCurrentSpan({ "approval.answer": answer, "approval.by": by }),
          ),
          Effect.onInterrupt(() =>
            Effect.annotateCurrentSpan({ "approval.answer": "no", "approval.by": turnStopped }),
          ),
          Effect.withSpan("Gateway.awaitApproval", { attributes: { "gateway.rule": askRule } }),
        );

    /**
    Carries out `request` once its person said yes to `approval`, only as the action they were asked
    about, and once: its `allow` row names the allow rule `allowRule`, the ask rule `askRule` and the
    approval. A turn stopped after the yes was spent leaves it spent, so the next run is told its outcome
    is unknown.
    */
    const carryOutApproved = Effect.fnUntraced(function* (
      bot: BotId,
      request: DirectRequest,
      approval: OpenApproval,
      allowRule: string,
      askRule: string,
    ) {
      const { action, host } = yield* resolve(bot, request);

      const allowRowId = yield* approval.spend(
        { bot, action, host },
        allowRow(bot, action, allowRule, { asked: askRule, approval: approval.id }),
      );

      yield* allowedByRule(allowRule);

      return yield* forwardAndSettle(bot, action.action, action, allowRowId).pipe(
        Effect.onExit((exit) => (Exit.hasInterrupts(exit) ? Effect.void : approval.finish)),
      );
    });

    /**
    An action the ask rule of `needs` holds for, put to the person in the conversation of `turn`, outside
    the door, before it runs once on their yes. From its `ask` row on, every way it ends is a row that
    names the approval: its `allow` row, or a `deny` row, also when the turn is stopped before it ran.
    */
    const askThenCarryOut = (
      bot: BotId,
      turn: TurnRef,
      request: DirectRequest,
      needs: NeedsApproval,
    ) => {
      const { action, host, askRule, allowRule } = needs;
      const tool = action.action;
      const asked = { bot, ...auditDetail(action), rule: askRule };

      const answerThenCarryOut = Effect.fnUntraced(function* (approval: OpenApproval) {
        const { answer, by } = yield* askPerson(bot, askRule, approval, questionOf(action));

        if (answer === "no") return yield* new Declined({ by });

        // A command cut off while it waits closes its approval, as anything cut off after the ask does.
        return yield* enter(
          tool,
          turn,
          carryOutApproved(bot, request, approval, allowRule, askRule),
          Effect.void,
        );
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const approval = yield* approvals.open(turn, askRule, { bot, action, host }, (id) =>
            record("ask", auditAction(tool), { ...asked, approval: id, allowedBy: allowRule }),
          );

          yield* Effect.annotateCurrentSpan({
            "gateway.decision": "ask",
            "gateway.asked": askRule,
          });

          const named = { ...asked, approval: approval.id };
          const closed = closing(approval);

          return yield* answerThenCarryOut(approval).pipe(
            Effect.onInterrupt(() =>
              Effect.flatMap(approval.spent, (spent) =>
                spent
                  ? Effect.void
                  : closed("deny", auditAction(tool), { ...named, reason: turnStopped }),
              ),
            ),
            recordRefusals(tool, named, closed),
          );
        }),
      ).pipe(recordRefusals(tool, asked));
    };

    /**
    Types what the person gave for `request` into its field, through the door, as `secret.supplied` with
    the secret's length. A person who holds the computer by now keeps it, and nothing is typed.
    */
    const supply = (bot: BotId, request: SecretRequest, secret: SecretValue, allowRule: string) =>
      doors
        .admit(
          Effect.gen(function* () {
            const allowRow = yield* record("allow", "secret.supplied", {
              bot,
              ...auditDetail(request),
              chars: Redacted.value(secret).length,
              rule: allowRule,
            }).pipe(
              Effect.mapError(
                () => new ToolFailed({ message: unrecordedAnswer("request_secret") }),
              ),
            );

            const page = yield* forwardAndSettle(
              bot,
              "request_secret",
              { action: "type_secret", target: request.target, secret },
              allowRow,
            );

            return suppliedAnswer(request, page);
          }),
        )
        .pipe(
          Effect.catchTag("PersonHasControl", () =>
            spanEvent("control.refused").pipe(
              Effect.andThen(
                refuseAs(
                  "deny",
                  "secret.supplied",
                  { bot, reason: "a person has control" },
                  "Your person gave the secret, but a person has control of your computer now, so nothing was typed. Wait until they hand it back, then take a snapshot and ask again.",
                ),
              ),
            ),
          ),
        );

    /**
    A Bot's request for a secret, held for the Bot and its turn's person first, so a second one of theirs
    is refused before anything is judged. Its ref is resolved, checked to name a text field and judged
    through the door like any action, and its `secret.requested` row written; only then is it shown to
    the person, as its field on the host of its page, and it waits for their answer outside the door, so
    a person can take the computer meanwhile. Its row's outcome says how the person answered, and what they typed is forwarded
    as `type_secret`, through the door again. Under an ask rule, the secret card is the person's question
    in the conversation of `turn`: it holds that conversation as an approval card would, and their no to
    it, or no answer, is a no to that rule for the rest of the run.
    */
    const askForSecret = (bot: BotId, turn: TurnRef, ref: string, field: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const open = yield* secrets.open(bot);

          const { action, host, allowRow, allowRule, question } = yield* doors.admit(
            Effect.gen(function* () {
              const asked = yield* onElement(bot, ref, (target): SecretRequest => ({
                action: "request_secret",
                target,
                field,
              }));

              if (!secretRoles.has(asked.action.target.role)) {
                return yield* new NoTextField({ action: asked.action });
              }

              if (asked.host === "") return yield* new NoSite({ action: asked.action });

              const allowed = yield* allowedBy(bot, asked.action, asked.host);
              const askRule = Option.map(allowed.ask, ({ rule }) => rule);

              const question = Option.isSome(askRule)
                ? Option.some(
                    yield* approvals.hold(turn, askRule.value).pipe(
                      recordRefusals("request_secret", {
                        bot,
                        ...auditDetail(asked.action),
                        rule: askRule.value,
                      }),
                    ),
                  )
                : Option.none<HeldQuestion>();

              // The secret card already asks the person, so an ask rule only names itself in the row.
              const allowRow = yield* allow(
                bot,
                asked.action,
                allowed.rule,
                Option.match(askRule, {
                  onNone: () => ({}),
                  onSome: (named) => ({ asked: named }),
                }),
              );

              return { ...asked, allowRow, allowRule: allowed.rule, question };
            }),
          );

          const answered = yield* open.ask(capText(field, fieldLimit), host).pipe(
            Effect.andThen(open.wait(secretWaitLimit)),
            Effect.onInterrupt(() => rows.settle(allowRow, "failed", { bot, reason: turnStopped })),
          );

          const unanswered = (reason: string, message: string) =>
            Effect.annotateCurrentSpan({ "gateway.outcome": "failed" }).pipe(
              Effect.andThen(
                Option.match(question, {
                  onNone: () => rows.settle(allowRow, "failed", { bot, reason }),
                  onSome: (held) =>
                    held
                      .declined(
                        bot,
                        "request_secret",
                        rows.outcome(allowRow, "failed", { bot, reason }),
                      )
                      .pipe(
                        Effect.ignore({
                          log: "Warn",
                          message: "A declined secret could not be recorded",
                        }),
                      ),
                }),
              ),
              Effect.andThen(Effect.fail(new ToolFailed({ message }))),
            );

          return yield* Option.match(answered, {
            onNone: () => unanswered("no answer", noAnswerAnswer(action)),
            onSome: SecretAnswer.match({
              Declined: () => unanswered("declined", declinedAnswer(action)),
              Supplied: ({ value }) =>
                rows
                  .settle(allowRow, "succeeded", { bot })
                  .pipe(Effect.andThen(supply(bot, action, value, allowRule))),
            }),
          });
        }),
      );

    /** The Bot `claim` names, when the server knows it and it was granted `tool`. */
    const grant = (claim: Claim, tool: ToolName): Effect.Effect<BotId, NotGranted> => {
      const known = Claim.guards.Named(claim) ? bots.get(claim.bot) : Option.none();

      return Option.match(
        Option.filter(known, (bot) => isGranted(bot, tool)),
        {
          onNone: () => Effect.fail(new NotGranted({ claim })),
          onSome: (bot) => Effect.succeed(bot.id),
        },
      );
    };

    /**
    Cuts `self` off once the turn stops, with an answer and no row of its own: what was cut off records
    how it ended, as it does when the turn's own fiber is interrupted, an allowed call as `unknown`, a
    question to the person as answered no, and a command still waiting for the one before it as denied.
    */
    const untilStopped =
      (tool: ToolName, turn: Option.Option<TurnRef>) =>
      <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | ToolFailed, R> =>
        Option.match(turn, {
          onNone: () => self,
          onSome: ({ conversation, run }) =>
            Effect.raceFirst(
              self,
              Effect.andThen(
                turns.stopped(conversation, run),
                Effect.fail(new ToolFailed({ message: `${tool} was cut off: ${turnStopped}.` })),
              ),
            ),
        });

    const act = Effect.fn("Gateway.act")(function* (claim: Claim, request: BotRequest) {
      const named = namedBot(claim);
      yield* Effect.annotateCurrentSpan({ "gateway.action": request.action });

      if (Option.isSome(named)) {
        yield* Effect.annotateCurrentSpan({ "gateway.bot": named.value });
      }

      // A row's JSON says null for a call that named no Bot by its id.
      const bot = Option.getOrNull(named);

      const turn = turnOf(claim);

      const carried = Effect.gen(function* () {
        const granted = yield* grant(claim, request.action);

        // Every turn runs for a person, so a call that names none is no person's.
        const ofPerson = yield* Option.match(turn, {
          onNone: () => Effect.fail(new NoPerson()),
          onSome: Effect.succeed,
        });

        // A command cut off while it waits has written nothing yet, so its turn's end is its deny row.
        const leftQueue = Effect.fail(new TurnEnded()).pipe(
          recordRefusals(request.action, { bot }),
          Effect.ignore,
        );

        return yield* BotRequest.guards.request_secret(request)
          ? askForSecret(granted, ofPerson, request.ref, request.field)
          : enter(request.action, ofPerson, carryOut(granted, request), leftQueue).pipe(
              Effect.catchTag("NeedsApproval", (needs) =>
                askThenCarryOut(granted, ofPerson, request, needs),
              ),
            );
      });

      // Every row and rule below names the person the turn runs for, so a call from an `api` runtime and
      // one from an `acp` CLI over `/mcp` name the same person. A call that names no turn is the
      // deployment's, refused as NoPerson; one whose turn ended is refused before anyone is named, so
      // its row is the deployment's too.
      const actor = yield* Option.match(turn, {
        onNone: () => Effect.succeed(deployment),
        onSome: actorOfTurn,
      }).pipe(recordRefusals(request.action, { bot }));

      return yield* carried.pipe(
        untilStopped(request.action, turn),
        recordRefusals(request.action, { bot }),
        Effect.provideService(CurrentActor, actor),
      );
    });

    return Context.make(Gateway, Gateway.of({ refuse, act })).pipe(
      Context.add(ComputerControl, doors.control),
      Context.add(FileTransfers, transfers),
      Context.add(SecretRequests, secrets.requests),
      Context.add(ApprovalRequests, approvals.requests),
    );
  }),
);
