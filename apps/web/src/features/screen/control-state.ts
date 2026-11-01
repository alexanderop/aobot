import {
  type ComputerNotStarted,
  Control,
  type ControlNotChanged,
  type InputFailed,
  type NotInControl,
  type ScreenPoint,
} from "@aobot/domain";
import { Data, Option, Predicate } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { RpcClientError } from "effect/rpc";

/** What a person asks of the Bot's computer. */
export type ControlCommand = Data.TaggedEnum<{
  Take: Record<never, never>;
  HandBack: Record<never, never>;
  Click: { readonly at: ScreenPoint };
}>;

/** Constructors and matchers for {@link ControlCommand}. */
export const ControlCommand = Data.taggedEnum<ControlCommand>();

/** Why a command did not happen, as the server or the connection said. */
type CommandFailure = Pick<
  | ControlNotChanged
  | ComputerNotStarted
  | NotInControl
  | InputFailed
  | RpcClientError.RpcClientError,
  "_tag" | "message"
>;

/** A command the person sent, and who held the computer when they sent it. */
export interface Sent {
  readonly command: ControlCommand;
  readonly sentWhile: Control["_tag"];
}

/**
How the person's last command was answered: who held the computer when they sent it, and why it failed,
if it did.
*/
export interface Answered {
  readonly sentWhile: Control["_tag"];
  readonly failure: Option.Option<CommandFailure>;
}

/**
Who holds the computer once `failure` is in. A take that held the computer but could not start it leaves
the person holding it; any other failure changed nothing.
*/
function leftWith(answered: Answered, failure: CommandFailure): Control["_tag"] {
  return Predicate.isTagged(failure, "ComputerNotStarted") ? "Person" : answered.sentWhile;
}

/**
Why the person's last command failed, while that still bears on their next step: only the last command
counts, and only while the computer is held as the failure left it. A take that failed is past once the
person holds the computer some other way; a click that failed is past once they hand back.
*/
export function problem(
  control: Control,
  last: AsyncResult.AsyncResult<Answered>,
): Option.Option<string> {
  if (last.waiting) return Option.none();

  return AsyncResult.value(last).pipe(
    Option.flatMap((answered) =>
      Option.filter(answered.failure, (failure) => leftWith(answered, failure) === control._tag),
    ),
    Option.map((failure) => failure.message),
  );
}

/**
Whether the panel is open: while the Bot uses its computer this turn, while a person holds it or is taking
it, and while there is a problem to show, so a take that failed from the folded rail is not silent.
*/
export function panelOpen(
  usesComputer: boolean,
  control: Control,
  shown: Option.Option<string>,
): boolean {
  return usesComputer || !Control.guards.Bot(control) || Option.isSome(shown);
}
