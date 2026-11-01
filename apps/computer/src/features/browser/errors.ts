import { Schema } from "effect";

/** The computer would not carry out an action, so it never tried. Answered as `refused` (403). */
export class ActionRefused extends Schema.TaggedError<ActionRefused>()("ActionRefused", {
  message: Schema.String,
}) {}

/** The computer tried an action and the browser or the network failed. Answered as `failed` (502). */
export class ActionFailed extends Schema.TaggedError<ActionFailed>()("ActionFailed", {
  message: Schema.String,
}) {}
