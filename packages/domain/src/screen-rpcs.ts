import { Rpc, RpcGroup } from "effect/rpc";
import { Screen } from "./computer.ts";

/**
The screen API. `Screen.watch` streams the computer's screen for as long as the caller stays subscribed.
It never fails and never starts a computer. It sends `Blank` while no computer runs or answers, and before
a new one paints. Its first {@link Screen} is the current one, so a viewer who joins late sees the page at
once and not on its next repaint.
*/
export class ScreenRpcs extends RpcGroup.make(
  Rpc.make("Screen.watch", { success: Screen, stream: true }),
) {}
