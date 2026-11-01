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
