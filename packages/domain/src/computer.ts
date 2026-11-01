import { Schema } from "effect";

/** The longest snapshot the computer returns, in UTF-16 code units. A longer one is cut and marked `truncated`. */
export const snapshotLimit = 12_000;

/** One thing a Bot asks its computer to do. The body of `POST /act`, discriminated by `action`. */
export const ComputerAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("navigate"), url: Schema.String }),
  Schema.Struct({ action: Schema.Literal("snapshot") }),
]).pipe(Schema.toTaggedUnion("action"));

/** A decoded {@link ComputerAction}. */
export type ComputerAction = typeof ComputerAction.Type;

/** What the computer answers to a {@link ComputerAction} it carried out, with status 200. */
export const ComputerActResult = Schema.Union([
  Schema.Struct({ action: Schema.Literal("navigate"), url: Schema.String, title: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("snapshot"),
    url: Schema.String,
    title: Schema.String,
    snapshot: Schema.String,
    truncated: Schema.Boolean,
  }),
]).pipe(Schema.toTaggedUnion("action"));

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
