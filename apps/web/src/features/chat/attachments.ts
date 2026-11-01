import { type ConversationId, FileSaved, fileTransferLimit } from "@aobot/domain";
import { Effect, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { Atom } from "effect/reactivity";
import { Attachment, settle } from "./attachment-state.ts";
import { fileHref } from "./files.ts";

const decodeSaved = HttpClientResponse.schemaBodyJson(FileSaved);

const decodeProblem = HttpClientResponse.schemaBodyJson(Schema.Struct({ message: Schema.String }));

/** What a person reads when the server turned an upload away without saying why, by its status. */
function unexplained(status: number): string {
  if (status === 403) return "The server refused an upload from this page.";

  if (status === 413) return "The file is too large for the server.";

  return `The server turned the upload away with status ${status}.`;
}

const megabytes = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MB`;

/** What became of uploading `file`: in the workspace at its own name, or why not. */
function upload(id: string, file: File) {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const response = yield* client.execute(
      HttpClientRequest.put(fileHref(file.name)).pipe(
        HttpClientRequest.setBody(
          HttpBody.raw(file, {
            contentType: file.type === "" ? "application/octet-stream" : file.type,
            contentLength: file.size,
          }),
        ),
      ),
    );

    if (response.status === 200) {
      const { path } = yield* decodeSaved(response);

      return Attachment.Ready({ id, name: file.name, path });
    }

    const { message } = yield* decodeProblem(response).pipe(
      Effect.orElseSucceed(() => ({ message: unexplained(response.status) })),
    );

    return Attachment.Failed({ id, name: file.name, message });
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        Attachment.Failed({
          id,
          name: file.name,
          message: "The upload did not reach the server. Try again.",
        }),
      ),
    ),
  );
}

/**
The composer's attachments in each conversation, over the HTTP client `runtime` gives: fetch on the page, a
fake one in a test. One family per atom, as the conversation's own atoms are.
*/
export function makeAttachments(runtime: Atom.AtomRuntime<HttpClient.HttpClient>) {
  /** Every file picked in a conversation since its last message went, in the order picked. */
  const attachments = Atom.family((_conversation: ConversationId) =>
    Atom.keepAlive(Atom.make<ReadonlyArray<Attachment>>([])),
  );

  /**
  Uploads a picked file at once, as a chip that says how it went. A file past the limit is refused here,
  before a byte is sent; the server refuses it too. Kept alive and concurrent, so every file picked goes
  up whatever the composer does meanwhile. Taking its chip out stops its upload.
  */
  const attach = Atom.family((conversation: ConversationId) =>
    Atom.keepAlive(
      runtime.fn(
        Effect.fnUntraced(function* (file: File, get: Atom.FnContext) {
          const chips = attachments(conversation);
          const id = crypto.randomUUID();

          if (file.size > fileTransferLimit) {
            get.set(chips, [
              ...get(chips),
              Attachment.Failed({
                id,
                name: file.name,
                message: `${file.name} is ${megabytes(file.size)}, and a file may be at most ${megabytes(fileTransferLimit)}.`,
              }),
            ]);

            return;
          }

          get.set(chips, [...get(chips), Attachment.Uploading({ id, name: file.name })]);

          const dismissed = get.stream(chips).pipe(
            Stream.filter((current) => !current.some((chip) => chip.id === id)),
            Stream.runHead,
          );

          yield* Effect.raceFirst(
            Effect.map(upload(id, file), (settled) => get.set(chips, settle(get(chips), settled))),
            dismissed,
          );
        }),
        { concurrent: true },
      ),
    ),
  );

  return { attachments, attach };
}

/** The page's attachments, uploaded with fetch to the server that served it. */
export const { attachments, attach } = makeAttachments(Atom.runtime(FetchHttpClient.layer));
