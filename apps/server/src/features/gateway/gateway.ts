import {
  type AcpClientMethod,
  type ApprovalAnswer,
  type AuditAction,
  BotId,
  ComputerAction,
  ConversationId,
  commandTimeLimit,
  escapesWorkspace,
  FileAction,
  type PageAction,
  PressKey,
  type RefTarget,
  RunCommand,
  RunId,
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
import { AuditLog, type AuditRowId, type Decision, type Outcome } from "../audit/public.ts";
import { Bots, isGranted } from "../bots/public.ts";
import { Policy, Refused, Verdict } from "../policy/public.ts";
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
import { redact, redactCommand, redactUrl } from "../../shared/redact.ts";
import { actionFacts, hostOf } from "./action-facts.ts";
import { ApprovalRequests, approvals, digestOf, type OpenApproval } from "./approvals.ts";
import { ComputerControl, controlDoors } from "./control.ts";
import { type ComputerFailure, failureOutcome, personAudit } from "./person-audit.ts";
import { fileTarget } from "./file-target.ts";
import {
  endAttributes,
  fileAttributes,
  presentCommand,
  presentFile,
  presentPage,
} from "./present.ts";
import { snapshotStore } from "./snapshot-store.ts";
import { spanEvent } from "./span-event.ts";
import { secretRequests, SecretRequests } from "./secrets.ts";
import { auditAction, DirectAction, SecretRequest, ToolAction } from "./tool-action.ts";
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
The turn a call is made in: its conversation, and its run, which starts with each message the person
writes. A question a rule puts to the person is shown in that conversation, and their no holds for that run.
*/
export const TurnRef = Schema.Struct({ conversation: ConversationId, run: RunId });

/** A decoded {@link TurnRef}. */
export type TurnRef = typeof TurnRef.Type;

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
    Refuses the call when the Bot it claims was not granted its tool, or is no Bot the server knows,
    before anything else the gateway does. Then refuses it while a person holds the computer. Otherwise
    resolves its ref against the latest snapshot, judges it by the rules, records the call, forwards it
    to the computer, records what became of it, and answers what the model reads. `request_secret` waits
    for the person's answer outside the door, at most {@link secretWaitLimit}, before what they typed is
    forwarded. A call that could not be carried out is a `ToolFailed` the model reads, never a dead turn.
    */
    readonly act: (claim: Claim, request: BotRequest) => Effect.Effect<string, ToolFailed>;
  }
>()("aobot/gateway/Gateway") {}

/** What the computer is sent, by its action. */
type ActionName = ComputerAction["action"];

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
  askRule: Schema.String,
  allowRule: Schema.String,
}) {}

/** An ask rule holds for an action from a call that names no turn, so there is no person to ask. */
class NoOneToAsk extends Schema.TaggedError<NoOneToAsk>()("NoOneToAsk", {}) {}

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

/** What the model reads when it asks for a tool it was not granted. */
function notGrantedAnswer(action: ToolName, claim: Claim): string {
  return `${action} did not run: it is not granted to ${claimedName(claim)}. Use only the tools your instructions name.`;
}

/** What the model reads when it asks for a secret while its last request still waits. */
const alreadyAskedAnswer =
  "request_secret did not run: you already asked your person for a secret, and they have not answered yet. Wait for that answer before asking again.";

/** How long a Bot's request for a secret waits for its person. */
export const secretWaitLimit = Duration.minutes(10);

/** How long an action a rule asks the person about waits for their answer, which is no after it. */
export const approvalWaitLimit = Duration.minutes(10);

/** Who answered a question a rule put to the person, as its `approval.answered` row says. */
type AnsweredBy = "person" | "time limit" | "the turn was stopped";

/** What a Bot is told after its person, or the time limit, said no. */
const holdOff =
  "Do not try it, or another way to do it, until they write to you; tell them it did not run.";

/** Why an action a rule asks about did not run, as its deny row's reason and as the model reads it. */
const notAsked = {
  NoOneToAsk: {
    reason: "no one to ask",
    why: "a rule asks your person first, and this call came from no conversation they could answer in",
  },
  AlreadyWaiting: {
    reason: "already waiting",
    why: "you already asked your person and they have not answered. Wait for that answer",
  },
  DeclinedEarlier: {
    reason: "declined earlier",
    why: "your person already said no to this in this conversation. Do not ask again until they write to you",
  },
  OutcomeUnknown: {
    reason: "outcome unknown",
    why: "an action like it that your person approved was started before the server stopped; whether it happened is unknown, and it was not run again. Check, for example with ls, before asking again",
  },
  ActionChanged: {
    reason: "action changed",
    why: "what it acts on changed after your person answered, so their answer does not cover it. Take a snapshot and ask again",
  },
  AlreadySpent: {
    reason: "already spent",
    why: "your person's yes was already used once. Ask again",
  },
  LedgerFailed: {
    reason: "not recorded",
    why: "asking your person could not be recorded, and nothing runs unrecorded",
  },
} as const;

/** What the model reads when its person, or the time limit, said no to `tool`. */
function declinedApprovalAnswer(tool: ToolName, by: AnsweredBy): string {
  return by === "person"
    ? `${tool} did not run: your person said no. ${holdOff}`
    : `${tool} did not run: your person did not answer within ${Duration.format(approvalWaitLimit)}, which counts as no. ${holdOff}`;
}

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
The question a person is asked about an action: worded by the server from the action as it resolved, with
the same redaction as its audit row. Text a Bot would type is never shown, only its length.
*/
const questionOf = DirectAction.match({
  navigate: ({ url }) => `Open ${redactUrl(url)}?`,
  snapshot: () => "Read the page?",
  click: ({ target }) => `Click ${elementOn(target)}?`,
  type: ({ target, text }) => `Type ${text.length} characters into ${elementOn(target)}?`,
  press: ({ target, key }) => `Press ${key} on ${elementOn(target)}?`,
  run: ({ command }) => `Run \`${capText(redactCommand(command), auditCommandLimit)}\`?`,
  read_file: ({ path }) => `Read the file ${path}?`,
  write_file: ({ path, contents }) =>
    `Write ${new TextEncoder().encode(contents).length} bytes to the file ${path}?`,
  list_files: ({ path }) => `List the files in ${path}?`,
});

/** Why a forwarded call did not come back with a result. */
type ForwardFailure = ComputerFailure | ToolTimedOut;

/** What a forwarded call became: its outcome row, and what the model is told. */
interface Settled {
  readonly outcome: Outcome;
  readonly detail: Readonly<Record<string, Schema.Json>>;
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
door, {@link FileTransfers}, so a person's files are audited in the same trail, and {@link SecretRequests},
where a person answers the secret a Bot asked for.
*/
export const gatewayLayer = Layer.effectContext(
  Effect.gen(function* () {
    const audit = yield* AuditLog;
    const bots = yield* Bots;
    const policy = yield* Policy;
    const rows = yield* personAudit;
    const computers = yield* Computers;
    const snapshots = yield* snapshotStore;
    const doors = yield* controlDoors;
    const transfers = yield* fileTransfers;
    const secrets = yield* secretRequests;
    const asking = yield* approvals;

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

      return { ...shown, url: latest.value.url };
    });

    /** `act` on the element `ref` names for `bot`, and the host of the page that element is on. */
    const onElement = <A extends ToolAction>(
      bot: BotId,
      ref: string,
      act: (target: RefTarget) => A,
    ) =>
      Effect.map(targetOf(bot, ref), (target) => ({
        action: act(target),
        host: hostOf(target.url),
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

    /** `request` as the computer is sent it, and the host of the page it acts on, `""` for none. */
    const resolve = (
      bot: BotId,
      request: DirectRequest,
    ): Effect.Effect<
      { readonly action: DirectAction; readonly host: string },
      UnknownRef | UnknownPage | OutsideWorkspace
    > => {
      const offThePage = (action: DirectAction) => Effect.succeed({ action, host: "" });

      return DirectRequest.match(request, {
        navigate: (navigate) => Effect.succeed({ action: navigate, host: hostOf(navigate.url) }),
        snapshot: (snapshot) => Effect.map(latestHost, (host) => ({ action: snapshot, host })),
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
    };

    /**
    The allow rule that allows `bot` taking `action` on a page at `host`, and the ask rule that asks the
    person first when one holds, or a {@link RuleRefused}. A rule that failed is logged by its name and
    list only, never its error, which can echo what the action holds. A refusal's deny row keeps the error
    of every rule that failed, capped; an allowed action's rules that failed are only logged.
    */
    const allowedBy = (bot: BotId, action: ToolAction, host: string) => {
      const failed = (list: "deny" | "allow" | "ask", rule: string) =>
        Effect.logWarning("A rule failed while it was checked").pipe(
          Effect.annotateLogs({ rule, list, action: action.action }),
        );

      const failedRules = (broken: ReadonlyArray<{ readonly rule: string }>) =>
        Effect.forEach(broken, ({ rule }) => failed("allow", rule), { discard: true });

      const refused = (verdict: Refused) => Effect.fail(new RuleRefused({ action, verdict }));

      return Verdict.match(policy.judge(actionFacts(bot, action, host)), {
        Allowed: ({ rule, broken }) =>
          Effect.as(failedRules(broken), { allowRule: rule, askRule: Option.none<string>() }),
        Ask: ({ askRule, allowRule, broken, failed: askFailed }) =>
          failedRules(broken).pipe(
            Effect.andThen(askFailed ? failed("ask", askRule) : Effect.void),
            Effect.as({ allowRule, askRule: Option.some<string>(askRule) }),
          ),
        Denied: refused,
        DenyRuleFailed: (failure) => Effect.andThen(failed("deny", failure.rule), refused(failure)),
        NoneAllowed: (none) => Effect.andThen(failedRules(none.broken), refused(none)),
      });
    };

    /** Records a `deny` row as `audited` and tells the model `answer`. */
    const denyAs = Effect.fnUntraced(function* (
      audited: AuditAction,
      detail: Schema.JsonObject,
      answer: string,
    ) {
      yield* Effect.annotateCurrentSpan({ "gateway.decision": "deny", "gateway.outcome": "deny" });
      yield* rows.deny(audited, detail);

      return yield* new ToolFailed({ message: answer });
    });

    /** Records a `deny` row for the tool `action` and tells the model `answer`. */
    const deny = (action: ToolName, detail: Schema.JsonObject, answer: string) =>
      denyAs(auditAction(action), detail, answer);

    /** Writes the `decision` row for `tool` as `audited`, or tells the model it did not run. */
    const record = (
      tool: ToolName,
      decision: Decision,
      audited: AuditAction,
      detail: Schema.JsonObject,
    ): Effect.Effect<AuditRowId, ToolFailed> =>
      rows.decide(decision, audited, detail).pipe(
        Effect.tapError((error) =>
          Effect.logError(
            "An audit row could not be written, so the action was not forwarded",
          ).pipe(Effect.annotateLogs({ action: audited, decision, reason: error.message })),
        ),
        Effect.mapError(
          () =>
            new ToolFailed({
              message: `${tool} did not run: it could not be recorded, and nothing runs unrecorded.`,
            }),
        ),
      );

    /** Writes the `allow` row of `action`, allowed by the allow rule `allowRule`, with `more` in its detail. */
    const allow = Effect.fnUntraced(function* (
      bot: BotId,
      action: ToolAction,
      allowRule: string,
      more: Readonly<Record<string, Schema.Json>>,
    ) {
      const tool = action.action;

      const allowRow = yield* record(tool, "allow", auditAction(tool), {
        bot,
        ...auditDetail(action),
        rule: allowRule,
        ...more,
      });

      yield* Effect.annotateCurrentSpan({ "gateway.decision": "allow", "gateway.rule": allowRule });

      return allowRow;
    });

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
        Effect.onInterrupt(() =>
          rows.settle(allowRow, "unknown", { bot, reason: "the turn was stopped" }),
        ),
      );

      const settled = settle(action.action, tool, forwarded);
      yield* Effect.annotateCurrentSpan({ "gateway.outcome": settled.outcome });
      yield* rows.settle(allowRow, settled.outcome, { bot, ...settled.detail });

      return yield* Effect.fromResult(settled.answer);
    });

    /**
    Resolves `request`, judges it by the rules, writes its `allow` row and forwards it. An action an ask
    rule holds for leaves the door as {@link NeedsApproval}, before any row is written.
    */
    const carryOut = Effect.fnUntraced(function* (bot: BotId, request: DirectRequest) {
      // A ref is resolved before any rule, so the rules judge the element the server's snapshot names,
      // and a ref that does not resolve is denied for that. A path outside the workspace is denied here;
      // the computer still confines every path itself.
      const { action, host } = yield* resolve(bot, request);

      const { allowRule, askRule } = yield* allowedBy(bot, action, host);

      if (Option.isSome(askRule)) {
        return yield* new NeedsApproval({ action, host, askRule: askRule.value, allowRule });
      }

      const allowRow = yield* allow(bot, action, allowRule, {});

      return yield* forwardAndSettle(bot, action.action, action, allowRow);
    });

    /** Writes who answered `approval`, and how. */
    const recordAnswer = (
      tool: ToolName,
      bot: BotId,
      approval: OpenApproval,
      answer: ApprovalAnswer,
      by: AnsweredBy,
    ) => record(tool, "answered", "approval.answered", { bot, approval: approval.id, answer, by });

    /**
    Shows `question` to the person and takes their answer to `approval`, in a span of its own that names
    the ask rule `askRule`, the answer and who gave it. Its `approval.answered` row is written however the
    wait ends; a turn stopped meanwhile answers no.
    */
    const askPerson = (
      tool: ToolName,
      bot: BotId,
      askRule: string,
      approval: OpenApproval,
      question: string,
    ) =>
      approval.ask(tool, question, approvalWaitLimit).pipe(
        Effect.tap(({ answer, by }) =>
          Effect.annotateCurrentSpan({ "approval.answer": answer, "approval.by": by }),
        ),
        Effect.onInterrupt(() =>
          Effect.annotateCurrentSpan({
            "approval.answer": "no",
            "approval.by": "the turn was stopped",
          }).pipe(
            Effect.andThen(recordAnswer(tool, bot, approval, "no", "the turn was stopped")),
            Effect.ignore,
          ),
        ),
        Effect.withSpan("Gateway.awaitApproval", { attributes: { "gateway.rule": askRule } }),
        Effect.tap(({ answer, by }) => recordAnswer(tool, bot, approval, answer, by)),
      );

    /**
    Carries out `request` once its person said yes to `approval`: resolved again, through the door, and
    spent on the action only when it resolves to the action they were asked about. It then runs once,
    its `allow` row naming the allow rule `allowRule`, the ask rule `askRule` and the approval. Whatever became of
    it, the approval is finished once the Bot is told; a turn stopped meanwhile leaves it spent, so the
    next run is told its outcome is unknown.
    */
    const carryOutApproved = Effect.fnUntraced(function* (
      bot: BotId,
      request: DirectRequest,
      approval: OpenApproval,
      allowRule: string,
      askRule: string,
    ) {
      const { action, host } = yield* resolve(bot, request);
      yield* approval.spend(digestOf(bot, action, host));

      const allowRow = yield* allow(bot, action, allowRule, {
        asked: askRule,
        approval: approval.id,
      });

      return yield* forwardAndSettle(bot, action.action, action, allowRow).pipe(
        Effect.onExit((exit) => (Exit.hasInterrupts(exit) ? Effect.void : approval.finish)),
      );
    });

    /**
    An action the ask rule of `needs` holds for, put to the person in the conversation of `turn` before it
    runs. It is held for that conversation first, and refused before anything is shown while another
    question waits there, after a no to that rule in this run, or once after an earlier run spent a yes
    on it and never said what became of it. Its `ask` row and its ledger row are written, then it is shown
    and waits for the person outside the door, at most {@link approvalWaitLimit}. A no, or no answer,
    refuses it; a yes carries it out.
    */
    const askThenCarryOut = (
      bot: BotId,
      turn: Option.Option<TurnRef>,
      request: DirectRequest,
      needs: NeedsApproval,
      queued: boolean,
    ) => {
      const { action, host, askRule, allowRule } = needs;
      const tool = action.action;
      const asked = { bot, ...auditDetail(action), rule: askRule };

      const notRun = ({ _tag }: { readonly _tag: keyof typeof notAsked }) =>
        deny(
          tool,
          { ...asked, reason: notAsked[_tag].reason },
          `${tool} did not run: ${notAsked[_tag].why}.`,
        );

      return Effect.scoped(
        Effect.gen(function* () {
          if (Option.isNone(turn)) return yield* new NoOneToAsk();

          const approval = yield* asking.open(turn.value, askRule, digestOf(bot, action, host));

          yield* record(tool, "ask", auditAction(tool), {
            ...asked,
            allowedBy: allowRule,
            approval: approval.id,
          });
          yield* Effect.annotateCurrentSpan({
            "gateway.decision": "ask",
            "gateway.asked": askRule,
          });
          const { answer, by } = yield* askPerson(tool, bot, askRule, approval, questionOf(action));

          if (answer === "no") {
            return yield* deny(
              tool,
              {
                ...asked,
                approval: approval.id,
                reason: by === "person" ? "declined" : "no answer",
              },
              declinedApprovalAnswer(tool, by),
            );
          }

          return yield* doors.admit(carryOutApproved(bot, request, approval, allowRule, askRule), {
            queued,
          });
        }),
      ).pipe(
        Effect.catchTags({
          NoOneToAsk: notRun,
          AlreadyWaiting: notRun,
          DeclinedEarlier: notRun,
          OutcomeUnknown: notRun,
          ActionChanged: notRun,
          AlreadySpent: notRun,
          LedgerFailed: notRun,
        }),
      );
    };

    /**
    Types what the person gave for `request` into its field, through the door, as `secret.supplied` with
    the secret's length. A person who holds the computer by now keeps it, and nothing is typed.
    */
    const supply = (bot: BotId, request: SecretRequest, secret: SecretValue, allowRule: string) =>
      doors
        .admit(
          Effect.gen(function* () {
            const allowRow = yield* record("request_secret", "allow", "secret.supplied", {
              bot,
              ...auditDetail(request),
              chars: Redacted.value(secret).length,
              rule: allowRule,
            });

            const page = yield* forwardAndSettle(
              bot,
              "request_secret",
              { action: "type_secret", target: request.target, secret },
              allowRow,
            );

            return suppliedAnswer(request, page);
          }),
          { queued: false },
        )
        .pipe(
          Effect.catchTag("PersonHasControl", () =>
            spanEvent("control.refused").pipe(
              Effect.andThen(
                denyAs(
                  "secret.supplied",
                  { bot, reason: "a person has control" },
                  "Your person gave the secret, but a person has control of your computer now, so nothing was typed. Wait until they hand it back, then take a snapshot and ask again.",
                ),
              ),
            ),
          ),
        );

    /**
    A Bot's request for a secret, held for the Bot first, so a second one is refused before anything is
    judged. Its ref is resolved, checked to name a text field and judged through the door like any
    action, and its `secret.requested` row written; only then is it shown to the person, as its field on
    the host of its page, and it waits for their answer outside the door, so a person can take the
    computer meanwhile. Its row's outcome says how the person answered, and what they typed is forwarded
    as `type_secret`, through the door again.
    */
    const askForSecret = (bot: BotId, ref: string, field: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const open = yield* secrets.open(bot);

          const { action, host, allowRow, allowRule } = yield* doors.admit(
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

              const { allowRule, askRule } = yield* allowedBy(bot, asked.action, asked.host);

              // The secret card already asks the person, so an ask rule only names itself in the row.
              const allowRow = yield* allow(
                bot,
                asked.action,
                allowRule,
                Option.match(askRule, {
                  onNone: () => ({}),
                  onSome: (named) => ({ asked: named }),
                }),
              );

              return { ...asked, allowRow, allowRule };
            }),
            { queued: false },
          );

          const answered = yield* open.ask(capText(field, fieldLimit), host).pipe(
            Effect.andThen(open.wait(secretWaitLimit)),
            Effect.onInterrupt(() =>
              rows.settle(allowRow, "failed", { bot, reason: "the turn was stopped" }),
            ),
          );

          const unanswered = (reason: string, message: string) =>
            Effect.annotateCurrentSpan({ "gateway.outcome": "failed" }).pipe(
              Effect.andThen(rows.settle(allowRow, "failed", { bot, reason })),
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

    const act = Effect.fn("Gateway.act")(function* (claim: Claim, request: BotRequest) {
      const named = namedBot(claim);
      yield* Effect.annotateCurrentSpan({ "gateway.action": request.action });

      if (Option.isSome(named)) {
        yield* Effect.annotateCurrentSpan({ "gateway.bot": named.value });
      }

      // A row's JSON says null for a call that named no Bot by its id.
      const bot = Option.getOrNull(named);

      // Commands run one at a time, in the order they were asked for.
      const queued = request.action === "run";

      return yield* Effect.gen(function* () {
        const granted = yield* grant(claim, request.action);

        return yield* BotRequest.guards.request_secret(request)
          ? askForSecret(granted, request.ref, request.field)
          : doors
              .admit(carryOut(granted, request), { queued })
              .pipe(
                Effect.catchTag("NeedsApproval", (needs) =>
                  askThenCarryOut(granted, turnOf(claim), request, needs, queued),
                ),
              );
      }).pipe(
        Effect.catchTags({
          AlreadyAsked: () =>
            deny(request.action, { bot, reason: "already asked" }, alreadyAskedAnswer),
          NotGranted: (refused) =>
            deny(
              request.action,
              { bot, reason: `not granted to ${claimedName(refused.claim)}` },
              notGrantedAnswer(request.action, refused.claim),
            ),
          PersonHasControl: () =>
            spanEvent("control.refused").pipe(
              Effect.andThen(
                deny(
                  request.action,
                  { bot, reason: "a person has control" },
                  personHasControlAnswer(request.action),
                ),
              ),
            ),
          UnknownRef: (unknown) =>
            deny(
              request.action,
              { bot, ref: unknown.ref, reason: unknown.reason },
              unknownRefAnswer(request.action, unknown),
            ),
          UnknownPage: () =>
            deny(
              request.action,
              { bot, reason: unreadSnapshot },
              unknownPageAnswer(request.action),
            ),
          RuleRefused: ({ action, verdict }) => {
            const { detail, why } = ruleRefusal(verdict);

            return Effect.andThen(
              Refused.guards.NoneAllowed(verdict)
                ? Effect.void
                : Effect.annotateCurrentSpan({ "gateway.rule": verdict.rule }),
              deny(
                action.action,
                { bot, ...auditDetail(action), ...detail },
                ruleRefusedAnswer(action.action, why),
              ),
            );
          },
          OutsideWorkspace: ({ action }) =>
            deny(
              action.action,
              { bot, ...fileTarget(action.path), reason: "outside workspace" },
              outsideWorkspaceAnswer(action),
            ),
          NoTextField: ({ action }) =>
            deny(
              action.action,
              { bot, ...auditDetail(action), reason: "not a text field" },
              noTextFieldAnswer(action),
            ),
          NoSite: ({ action }) =>
            deny(
              action.action,
              { bot, ...auditDetail(action), reason: "no site" },
              noSiteAnswer(action),
            ),
        }),
      );
    });

    return Context.make(Gateway, Gateway.of({ refuse, act })).pipe(
      Context.add(ComputerControl, doors.control),
      Context.add(FileTransfers, transfers),
      Context.add(SecretRequests, secrets.requests),
      Context.add(ApprovalRequests, asking.requests),
    );
  }),
);
