import { Schema } from "effect";

/** The longest snapshot the computer returns, in UTF-16 code units. A longer one is cut and marked `truncated`. */
export const snapshotLimit = 12_000;

/** An element of a page as the gateway resolved it from the Bot's latest snapshot. */
export const RefTarget = Schema.Struct({
  /** The element's ref in that snapshot, such as `e12`. */
  ref: Schema.String,
  role: Schema.String,
  /** Its accessible name, or `""` when the snapshot shows none. */
  name: Schema.String,
});

/** A decoded {@link RefTarget}. */
export type RefTarget = typeof RefTarget.Type;

/** One thing a Bot asks its computer to do. The body of `POST /act`, discriminated by `action`. */
export const ComputerAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("navigate"), url: Schema.String }),
  Schema.Struct({ action: Schema.Literal("snapshot") }),
]).pipe(Schema.toTaggedUnion("action"));

/** A decoded {@link ComputerAction}. */
export type ComputerAction = typeof ComputerAction.Type;

/**
What the computer answers to a {@link ComputerAction} it carried out, with status 200: the page as it is
after the action, read afresh, so the Bot's refs always come from the page it is looking at.
*/
export const ComputerActResult = Schema.Struct({
  action: Schema.Literals(["navigate", "snapshot"]),
  url: Schema.String,
  title: Schema.String,
  snapshot: Schema.String,
  truncated: Schema.Boolean,
});

/** A decoded {@link ComputerActResult}. */
export type ComputerActResult = typeof ComputerActResult.Type;

/**
Why the computer did not carry out an action. `refused` (status 403) means it never tried, for example a
private address; `failed` (status 502) means it tried and the browser failed.
*/
export const ComputerActError = Schema.Struct({
  reason: Schema.Literals(["refused", "failed"]),
  message: Schema.String,
});

/** A decoded {@link ComputerActError}. */
export type ComputerActError = typeof ComputerActError.Type;
