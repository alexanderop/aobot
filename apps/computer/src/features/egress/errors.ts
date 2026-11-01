import { Schema } from "effect";

/** The computer never connects to this destination, so nothing was sent. */
export class DestinationRefused extends Schema.TaggedError<DestinationRefused>()(
  "DestinationRefused",
  { message: Schema.String },
) {}

/** The destination may be reached, but its name did not resolve to an address. */
export class DestinationUnreachable extends Schema.TaggedError<DestinationUnreachable>()(
  "DestinationUnreachable",
  { message: Schema.String },
) {}
