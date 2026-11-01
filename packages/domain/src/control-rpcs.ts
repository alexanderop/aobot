import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  ComputerNotStarted,
  Control,
  ControlNotChanged,
  InputFailed,
  NotInControl,
  ScreenPoint,
} from "./control.ts";

/**
Taking the mouse from the Bot. `Control.watch` streams who holds its computer, the current holder first,
and never fails. `Control.take` answers once the Bot's actions already running are done and the computer
runs, and `Control.handBack` once the Bot holds it again; asking for what already holds changes nothing,
except that a take starts a computer that is not running.
`Control.click` clicks at a point of the screen the page shows, only while the person holds it.
*/
export class ControlRpcs extends RpcGroup.make(
  Rpc.make("Control.watch", { success: Control, stream: true }),
  Rpc.make("Control.take", {
    success: Control,
    error: Schema.Union([ControlNotChanged, ComputerNotStarted]),
  }),
  Rpc.make("Control.handBack", { success: Control, error: ControlNotChanged }),
  Rpc.make("Control.click", {
    payload: ScreenPoint,
    error: Schema.Union([NotInControl, InputFailed]),
  }),
) {}
