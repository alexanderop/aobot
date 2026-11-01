import { keepFirst } from "@aobot/domain";
import { Duration, Effect, Schema } from "effect";
import { markUntrusted } from "./untrusted.ts";

/** The longest tool result the model is shown, in UTF-16 code units, before the truncation note. */
export const toolResultLimit = 20_000;

/** A tool call that did not do what was asked, in words the model can read and act on. */
export class ToolFailed extends Schema.TaggedError<ToolFailed>()("ToolFailed", {
  message: Schema.String,
}) {}

/** The tool took longer than its limit and was stopped. Whether its action happened is not known. */
export class ToolTimedOut extends Schema.TaggedError<ToolTimedOut>()("ToolTimedOut", {
  timeoutMs: Schema.Number,
}) {}

/** `text` cut to `limit` code units with a note saying how much was cut. Never splits a surrogate pair. */
export function capText(text: string, limit: number = toolResultLimit): string {
  if (text.length <= limit) return text;

  const kept = keepFirst(text, limit);

  return `${kept}\n[truncated: ${text.length - kept.length} characters]`;
}

/** Text from outside, as the model is shown it: capped, then marked untrusted. */
export function outsideText(content: string, source: string): string {
  return markUntrusted(capText(content), source);
}

/**
The one seam every tool result passes: `work` is stopped after `timeout`, and what it returns reaches the
model as {@link outsideText} from `source`.
*/
export function toolResult(options: {
  readonly source: string;
  readonly timeout: Duration.Duration;
}) {
  return <E, R>(work: Effect.Effect<string, E, R>): Effect.Effect<string, E | ToolTimedOut, R> =>
    work.pipe(
      Effect.timeoutOrElse({
        duration: options.timeout,
        orElse: () =>
          Effect.fail(new ToolTimedOut({ timeoutMs: Duration.toMillis(options.timeout) })),
      }),
      Effect.map((content) => outsideText(content, options.source)),
    );
}
