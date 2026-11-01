import { Schema } from "effect";

const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/**
A point on the screen as fractions of its width and height, `{ x: 0, y: 0 }` its top left. Only the
computer knows its viewport's size, so only the computer turns a point into pixels.
*/
export const ScreenPoint = Schema.Struct({ x: Fraction, y: Fraction });

/** A decoded {@link ScreenPoint}. */
export type ScreenPoint = typeof ScreenPoint.Type;

/** What a person in control does on the Bot's screen. The body of the computer's `POST /input`. */
export const PersonInput = Schema.TaggedUnion({ Click: { at: ScreenPoint } });

/** A decoded {@link PersonInput}. */
export type PersonInput = typeof PersonInput.Type;

/**
Who holds a Bot's computer, as the page sees it. `Taking` while a person's take waits for the Bot's
actions already running to finish, `waitingFor` of them. While `Taking` or `Person`, every Bot action is
refused.
*/
export const Control = Schema.TaggedUnion({
  Bot: {},
  Taking: { waitingFor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) },
  Person: { since: Schema.DateTimeUtc },
});

/** A decoded {@link Control}. */
export type Control = typeof Control.Type;

/** Control did not change hands, because the change could not be recorded or stored. */
export class ControlNotChanged extends Schema.TaggedError<ControlNotChanged>()(
  "ControlNotChanged",
  { message: Schema.String },
) {}

/** The person holds the computer, but it could not be started, so its screen shows nothing to click. */
export class ComputerNotStarted extends Schema.TaggedError<ComputerNotStarted>()(
  "ComputerNotStarted",
  { message: Schema.String },
) {}

/** A person's input was refused, because they do not hold the computer. */
export class NotInControl extends Schema.TaggedError<NotInControl>()("NotInControl", {
  message: Schema.String,
}) {}

/** A person's input reached no computer, or the computer could not carry it out. */
export class InputFailed extends Schema.TaggedError<InputFailed>()("InputFailed", {
  message: Schema.String,
}) {}
