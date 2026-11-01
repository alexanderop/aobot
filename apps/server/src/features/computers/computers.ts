import {
  type ComputerAction,
  ComputerActError,
  CommandRan,
  type FileAction,
  FileAnswer,
  FileSaved,
  type PageAction,
  PageRead,
  type PersonInput,
  type RunCommand,
  Screen,
  ScreenFrame,
} from "@aobot/domain";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Option,
  Redacted,
  Schedule,
  Schema,
  Queue,
  type Scope,
  Stream,
} from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { Socket } from "effect/socket";

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

/** A file the computer is sending: its size, and its bytes as they arrive. */
interface FileDownload {
  readonly bytes: number;
  readonly body: Stream.Stream<Uint8Array, ComputerLost>;
}

/** A running computer, ready for actions. Each answers only in the shape its action promises. */
export interface Computer {
  readonly browse: (
    action: PageAction,
  ) => Effect.Effect<PageRead, ComputerActFailed | ComputerLost>;
  readonly run: (
    command: RunCommand,
  ) => Effect.Effect<CommandRan, ComputerActFailed | ComputerLost>;
  /** A Bot's `read_file`, `write_file` or `list_files`, answered as that action's own result. */
  readonly files: (
    action: FileAction,
  ) => Effect.Effect<FileAnswer, ComputerActFailed | ComputerLost>;
  /**
  The exact bytes of a file in the workspace, over `GET /files`, for a person's download. The computer's
  answer is dropped when the scope closes, read to its end or not.
  */
  readonly download: (
    path: string,
  ) => Effect.Effect<FileDownload, ComputerActFailed | ComputerLost, Scope.Scope>;
  /**
  `body` saved at `path` in the workspace, over `PUT /files`, for a person's upload. A body that fails
  partway fails the upload with its own error, not as a lost computer.
  */
  readonly upload: <E>(
    path: string,
    body: Stream.Stream<Uint8Array, E>,
  ) => Effect.Effect<FileSaved, ComputerActFailed | ComputerLost | E>;
  /** What a person in control did on the screen, over `POST /input`. */
  readonly input: (input: PersonInput) => Effect.Effect<void, ComputerActFailed | ComputerLost>;
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
    /** The computer if one this server started is running. Never starts one. */
    readonly running: Effect.Effect<Computer, ComputerUnavailable>;
    readonly stop: Effect.Effect<void, ComputerUnavailable>;
    /** Throws the computer away, so the next `ensure` starts a fresh one. */
    readonly reset: Effect.Effect<void, ComputerUnavailable>;
    readonly list: Effect.Effect<ReadonlyArray<ComputerStatus>, ComputerUnavailable>;
    /**
    The running computer's screen for any number of viewers over one connection, as `Screen.watch`
    promises. The connection closes a while after the last viewer leaves.
    */
    readonly screen: Stream.Stream<Screen>;
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

/** What each of the computer's JSON routes takes. */
interface JsonRoutes {
  readonly "/act": ComputerAction;
  readonly "/input": PersonInput;
}

/** The status each route answers when the computer carried the request out. */
const done = { "/act": 200, "/input": 204, "/files": 200 } as const;

type Route = keyof typeof done;

/** What the computer answered, once it carried the request out. */
type ReadAnswer<A> = (
  answer: HttpClientResponse.HttpClientResponse,
) => Effect.Effect<A, { readonly message: string }>;

/** What `response` says of a request to `path`: `read` of it when the computer carried it out. */
function answered<A>(
  path: Route,
  response: HttpClientResponse.HttpClientResponse,
  read: ReadAnswer<A>,
): Effect.Effect<A, ComputerActFailed | ComputerLost> {
  const refused = (answer: HttpClientResponse.HttpClientResponse) =>
    decodeRefusal(answer).pipe(
      Effect.mapError(lost),
      Effect.flatMap((error) => Effect.fail(new ComputerActFailed(error))),
    );

  return HttpClientResponse.matchStatus(response, {
    [done[path]]: (answer: HttpClientResponse.HttpClientResponse) =>
      read(answer).pipe(Effect.mapError(lost)),
    403: refused,
    413: refused,
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

const decodeFile = HttpClientResponse.schemaBodyJson(FileAnswer);

const decodeSaved = HttpClientResponse.schemaBodyJson(FileSaved);

const decodeLength = Schema.decodeUnknownEffect(
  Schema.Struct({ "content-length": Schema.NumberFromString }),
);

/** A request to `/files` for the file at `path`, redacted so no client span records it. */
function fileRequest(
  method: "GET" | "PUT",
  url: URL,
  path: string,
): HttpClientRequest.HttpClientRequest {
  return HttpClientRequest.make(method)(url).pipe(
    HttpClientRequest.setUrlParam("path", Redacted.make(path)),
  );
}

/**
The computer at `address`, spoken to over `POST /act`, `POST /input` and `/files`. The client sends
`traceparent` from the current span, so the computer's work lands inside the gateway's.
*/
export function computerAt(address: ComputerAddress, client: HttpClient.HttpClient): Computer {
  const at = (path: Route) => new URL(path, address.url);

  /** Sends `request` to `path` with the token, and `read`s the answer once the computer carried it out. */
  const sendOver =
    <R>(over: HttpClient.HttpClient.With<HttpClientError.HttpClientError, R>) =>
    <A>(path: Route, request: HttpClientRequest.HttpClientRequest, read: ReadAnswer<A>) =>
      over.execute(HttpClientRequest.bearerToken(request, address.token)).pipe(
        Effect.mapError(lost),
        Effect.flatMap((response) => answered(path, response, read)),
      );

  const send = sendOver(client);

  // A download's answer is aborted with the scope, so one nobody reads to its end does not hold the computer.
  const sendScoped = sendOver(HttpClient.withScope(client));

  /** Posts `body` as JSON to `path`. */
  const post = <Path extends keyof JsonRoutes, A>(
    path: Path,
    body: JsonRoutes[Path],
    read: ReadAnswer<A>,
  ) =>
    send(path, HttpClientRequest.post(at(path)).pipe(HttpClientRequest.bodyJsonUnsafe(body)), read);

  return {
    browse: Effect.fn("Computer.act")(function* (action: PageAction) {
      return yield* post("/act", action, decodePage);
    }),
    run: Effect.fn("Computer.act")(function* (command: RunCommand) {
      return yield* post("/act", command, decodeCommand);
    }),
    files: Effect.fn("Computer.act")(function* (action: FileAction) {
      return yield* post("/act", action, (answer) =>
        decodeFile(answer).pipe(
          Effect.filterOrFail(
            (file) => file.action === action.action,
            (file) => ({ message: `The computer answered ${action.action} as ${file.action}.` }),
          ),
        ),
      );
    }),
    download: Effect.fn("Computer.download")(function* (path: string) {
      return yield* sendScoped("/files", fileRequest("GET", at("/files"), path), (answer) =>
        Effect.map(decodeLength(answer.headers), (headers) => ({
          bytes: headers["content-length"],
          body: answer.stream.pipe(Stream.mapError(lost)),
        })),
      );
    }),
    upload: Effect.fn("Computer.upload")(function* <E>(
      path: string,
      body: Stream.Stream<Uint8Array, E>,
    ) {
      // The client reads a body that fails as a broken connection, so its error is kept aside first.
      const brokeOff = yield* Deferred.make<never, E>();

      return yield* send(
        "/files",
        fileRequest("PUT", at("/files"), path).pipe(
          HttpClientRequest.bodyStream(
            Stream.tapError(body, (error) => Deferred.fail(brokeOff, error)),
          ),
        ),
        decodeSaved,
      ).pipe(
        Effect.catch((failure) =>
          Effect.flatMap(
            Deferred.poll(brokeOff),
            (body): Effect.Effect<never, E | ComputerActFailed | ComputerLost> =>
              Option.getOrElse(body, () => Effect.fail(failure)),
          ),
        ),
      );
    }),
    input: Effect.fn("Computer.input")(function* (input: PersonInput) {
      return yield* post("/input", input, () => Effect.void);
    }),
  };
}

/** The connection to a computer's screen dropped, failed or was refused. Holds no frame. */
class ScreenLost extends Schema.TaggedError<ScreenLost>()("ScreenLost", {
  message: Schema.String,
}) {}

const decodeFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(ScreenFrame));

/**
The frames of the computer at `address`: `GET /stream` as a WebSocket with the bearer token, only the
latest kept until it is read. A message that does not decode, or a socket that closes, even cleanly, fails
as {@link ScreenLost}, so the caller's retry dials again. The socket is read in a fiber of its own, so
hanging up interrupts the read before the socket closes: a stream that owned the socket would read its own
hang-up as a dropped connection.
*/
function screenAt(
  address: ComputerAddress,
): Stream.Stream<ScreenFrame, ScreenLost, Socket.WebSocketConstructor> {
  const url = new URL("/stream", address.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const decoder = new TextDecoder();

  return Stream.callback<ScreenFrame, ScreenLost, Socket.WebSocketConstructor>(
    (queue) =>
      Socket.makeWebSocket(url.href, {
        headers: { authorization: `Bearer ${Redacted.value(address.token)}` },
      }).pipe(
        Effect.flatMap((socket) =>
          Socket.toStream(socket).pipe(
            Stream.mapError((error) => new ScreenLost({ message: error.message })),
            Stream.mapEffect((message) =>
              decodeFrame(decoder.decode(message)).pipe(
                // The decoder's own message would quote the frame.
                Effect.mapError(
                  () =>
                    new ScreenLost({ message: "The computer sent something that is not a frame." }),
                ),
              ),
            ),
            Stream.runForEach((frame) => Queue.offer(queue, frame)),
          ),
        ),
      ),
    { bufferSize: 1, strategy: "sliding" },
  );
}

/** How long the connection to the computer outlives its last viewer, so the next turn shows the screen at once. */
const screenIdle = Duration.seconds(10);

const blank = Screen.cases.Blank.make({});

/** The live screen of whichever computer `addresses` names, for {@link Computers.screen}. */
export function liveScreen(
  addresses: Stream.Stream<Option.Option<ComputerAddress>>,
  idle: Duration.Input = screenIdle,
): Effect.Effect<Stream.Stream<Screen>, never, Scope.Scope | Socket.WebSocketConstructor> {
  return addresses.pipe(
    Stream.changes,
    Stream.switchMap(
      Option.match({
        onNone: () => Stream.make(blank),
        onSome: (address) =>
          screenAt(address).pipe(
            // A lost connection blanks the screen. A dial that never painted adds nothing, because
            // `Stream.retry` restarts its backoff at an attempt's first element.
            Stream.catch((lost) => Stream.make(blank).pipe(Stream.concat(Stream.fail(lost)))),
            Stream.dropWhile(Screen.guards.Blank),
            Stream.tapError(({ message }) =>
              Effect.logWarning("The screen connection dropped").pipe(
                Effect.annotateLogs({ reason: message }),
              ),
            ),
            Stream.retry(
              Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("8 seconds")]),
            ),
            Stream.orDie,
            Stream.prepend([blank]),
          ),
      }),
    ),
    Stream.share({ capacity: 1, strategy: "sliding", replay: 1, idleTimeToLive: idle }),
  );
}
