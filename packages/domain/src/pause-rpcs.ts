import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { UnknownBot } from "./bot.ts";
import { BotId } from "./ids.ts";
import { SignedIn } from "./people.ts";

/** Names one Bot. */
const BotRef = Schema.Struct({ botId: BotId });

/** The Bot is paused, so none of its turns starts until an admin resumes it. */
export class BotPaused extends Schema.TaggedError<BotPaused>()("BotPaused", { botId: BotId }) {}

/**
The server could not read whether the Bot is paused, so it started nothing: a Bot that may have been
paused never runs on a guess.
*/
export class PauseUnknown extends Schema.TaggedError<PauseUnknown>()("PauseUnknown", {
  botId: BotId,
}) {}

/**
A pause or a resume of the Bot, as `change` says, did not happen: it could not be stored together with
the rows that record it.
*/
export class PauseNotChanged extends Schema.TaggedError<PauseNotChanged>()("PauseNotChanged", {
  botId: BotId,
  change: Schema.Literals(["pause", "resume"]),
}) {}

/**
Pausing a Bot, as an admin. `Pause.watch` streams the paused Bots, now and then each change, and never
fails. `Pause.pause` stores the pause and stops every turn of the Bot at once on this server, and within
seconds on any other; `Pause.resume` lets its turns start again. Pausing a paused Bot or resuming a
running one changes nothing.
*/
export class PauseRpcs extends RpcGroup.make(
  Rpc.make("Pause.watch", { success: Schema.Array(BotId), stream: true }),
  Rpc.make("Pause.pause", {
    payload: BotRef,
    error: Schema.Union([UnknownBot, PauseNotChanged]),
  }),
  Rpc.make("Pause.resume", {
    payload: BotRef,
    error: Schema.Union([UnknownBot, PauseNotChanged]),
  }),
).middleware(SignedIn) {}
