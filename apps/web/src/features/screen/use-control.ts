import { useAtom, useAtomValue } from "@effect/atom-react";
import { Control, type ScreenPoint } from "@aobot/domain";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { control as controlAtom, lastCommand } from "./control.ts";
import { ControlCommand, problem } from "./control-state.ts";

/** Who holds the Bot's computer, and what the person can do about it. */
export interface UseControl {
  readonly holder: Control;
  /** Why the person's last command did not happen, as {@link problem} decides. */
  readonly problem: Option.Option<string>;
  /** Whether the person's last command, a click included, is still on its way. */
  readonly sending: boolean;
  readonly takeControl: () => void;
  readonly handBack: () => void;
  /** Click at a point of the screen, as fractions of it. Only while the person holds it. */
  readonly click: (at: ScreenPoint) => void;
}

/** What the page shows before the server has said who holds the computer. */
const botHolds = Control.cases.Bot.make({});

/** Follow who holds the Bot's computer while the calling component is mounted. Watches no frames. */
export function useControl(): UseControl {
  const holder = Option.getOrElse(AsyncResult.value(useAtomValue(controlAtom)), () => botHolds);
  const [last, send] = useAtom(lastCommand);
  const sentWhile = holder._tag;

  const issue = useCallback(
    (command: ControlCommand) => send({ command, sentWhile }),
    [send, sentWhile],
  );

  return {
    holder,
    problem: problem(holder, last),
    sending: last.waiting,
    takeControl: useCallback(() => issue(ControlCommand.Take()), [issue]),
    handBack: useCallback(() => issue(ControlCommand.HandBack()), [issue]),
    click: useCallback((at: ScreenPoint) => issue(ControlCommand.Click({ at })), [issue]),
  };
}
