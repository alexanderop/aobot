import {
  type ComputerAction,
  ComputerActError,
  CommandRan,
  type PageAction,
  PageRead,
  type RunCommand,
} from "@aobot/domain";
import { Context, Effect, type Redacted, Schema } from "effect";
import { type HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** The computer could not be started or reached, so the action was never sent. */
export class ComputerUnavailable extends Schema.TaggedError<ComputerUnavailable>()(
  "ComputerUnavailable",
  { message: Schema.String },
) {}

/** The computer answered that it did not carry out the action: it refused, or it tried and failed. */
export class ComputerActFailed extends Schema.TaggedError<ComputerActFailed>()(
  "ComputerActFailed",
  { reason: Schema.Literals(["refused", "failed"]), message: Schema.String },
) {}

/** The action was sent and no answer we can read came back. Whether it happened is not known. */
export class ComputerLost extends Schema.TaggedError<ComputerLost>()("ComputerLost", {
  message: Schema.String,
}) {}

/** A running computer, ready for actions. Each answers only in the shape its action promises. */
export interface Computer {
  readonly browse: (
    action: PageAction,
  ) => Effect.Effect<PageRead, ComputerActFailed | ComputerLost>;
  readonly run: (
    command: RunCommand,
  ) => Effect.Effect<CommandRan, ComputerActFailed | ComputerLost>;
}

/** What `list` reports about one computer. */
export interface ComputerStatus {
  readonly name: string;
  readonly running: boolean;
}

/**
The computers Bots act on. One shared computer for now; one per person arrives with E3-3. Only the
gateway may use this.
*/
export class Computers extends Context.Service<
  Computers,
  {
    /** The computer, started if it is not running, once it answers its health check. */
    readonly ensure: Effect.Effect<Computer, ComputerUnavailable>;
    readonly stop: Effect.Effect<void, ComputerUnavailable>;
    /** Throws the computer away, so the next `ensure` starts a fresh one. */
    readonly reset: Effect.Effect<void, ComputerUnavailable>;
    readonly list: Effect.Effect<ReadonlyArray<ComputerStatus>, ComputerUnavailable>;
  }
>()("aobot/computers/Computers") {}

/** Where a computer is: a URL and a token (decision 6), whichever provider started it. */
export interface ComputerAddress {
  readonly url: string;
  readonly token: Redacted.Redacted<string>;
}

const decodeRefusal = HttpClientResponse.schemaBodyJson(ComputerActError);

function lost(error: { readonly message: string }) {
  return new ComputerLost({ message: error.message });
}

/**
What the computer's answer to `POST /act` says: a 200 read by `decode`, or why it did not carry the action
out. A 200 that `decode` cannot read, such as a page answering a command, is lost: something ran, and what
became of it is not known.
*/
function answered<A>(
  response: HttpClientResponse.HttpClientResponse,
  decode: (
    answer: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, { readonly message: string }>,
): Effect.Effect<A, ComputerActFailed | ComputerLost> {
  const refused = (answer: HttpClientResponse.HttpClientResponse) =>
    decodeRefusal(answer).pipe(
      Effect.mapError(lost),
      Effect.flatMap((error) => Effect.fail(new ComputerActFailed(error))),
    );

  return HttpClientResponse.matchStatus(response, {
    200: (answer) => decode(answer).pipe(Effect.mapError(lost)),
    403: refused,
    502: refused,
    // Any other 4xx turned the request away before it ran; anything else may have run partway.
    "4xx": (answer) =>
      Effect.fail(
        new ComputerActFailed({
          reason: "refused",
          message: `The computer turned the request away with status ${answer.status}.`,
        }),
      ),
    orElse: (answer) =>
      Effect.fail(lost({ message: `The computer answered status ${answer.status}.` })),
  });
}

const decodePage = HttpClientResponse.schemaBodyJson(PageRead);

const decodeCommand = HttpClientResponse.schemaBodyJson(CommandRan);

/**
The computer at `address`, spoken to over `POST /act`. The client sends `traceparent` from the current
span, so the computer's work lands inside the gateway's.
*/
export function computerAt(address: ComputerAddress, client: HttpClient.HttpClient): Computer {
  const send = (action: ComputerAction) =>
    client
      .execute(
        HttpClientRequest.post(new URL("/act", address.url)).pipe(
          HttpClientRequest.bearerToken(address.token),
          HttpClientRequest.bodyJsonUnsafe(action),
        ),
      )
      .pipe(Effect.mapError(lost));

  return {
    browse: Effect.fn("Computer.act")(function* (action: PageAction) {
      return yield* answered(yield* send(action), decodePage);
    }),
    run: Effect.fn("Computer.act")(function* (command: RunCommand) {
      return yield* answered(yield* send(command), decodeCommand);
    }),
  };
}
