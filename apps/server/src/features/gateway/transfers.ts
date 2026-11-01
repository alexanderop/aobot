import { escapesWorkspace, type FileSaved, fileTransferLimit } from "@aobot/domain";
import {
  Clock,
  Context,
  Effect,
  Exit,
  Match,
  Ref,
  Schema,
  type Scope,
  Stream,
  type Tracer,
} from "effect";
import type { AuditRowId, Outcome } from "../audit/public.ts";
import { Computers } from "../computers/public.ts";
import { capText } from "../../shared/tool-result.ts";
import { fileTarget } from "./file-target.ts";
import {
  type ComputerFailure,
  computerMessageLimit,
  failureOutcome,
  personAudit,
} from "./person-audit.ts";

/**
Why a person's upload or download did not happen. `refused`: it was never tried, because the path leaves
the workspace or the computer would not touch it. `too_large`: past {@link fileTransferLimit}. `failed`: it
was tried, or could not be recorded.
*/
export class TransferFailed extends Schema.TaggedError<TransferFailed>()("TransferFailed", {
  reason: Schema.Literals(["refused", "too_large", "failed"]),
  message: Schema.String,
}) {}

/** The person's upload broke off before all of it reached the computer, so nothing was saved. */
class UploadStopped extends Schema.TaggedError<UploadStopped>()("UploadStopped", {}) {}

/** A file on its way to a person: the name to save it as, its size, and its bytes as they arrive. */
interface FileDownload {
  readonly name: string;
  readonly bytes: number;
  readonly body: Stream.Stream<Uint8Array, TransferFailed>;
}

/** A person putting a file into the Bot's workspace, or taking one out, each an audited call of its own. */
export class FileTransfers extends Context.Service<
  FileTransfers,
  {
    /** Saves the `bytes` long `body` at `path` in the workspace, starting the computer if none runs. */
    readonly upload: <E>(
      path: string,
      bytes: number,
      body: Stream.Stream<Uint8Array, E>,
    ) => Effect.Effect<FileSaved, TransferFailed>;
    /**
    The file at `path` in the workspace of the computer that runs. Never starts one. Its span and its
    outcome wait for the scope to close: `succeeded` only when every byte of `body` was read by then.
    */
    readonly download: (path: string) => Effect.Effect<FileDownload, TransferFailed, Scope.Scope>;
  }
>()("aobot/gateway/FileTransfers") {}

type Action = "file.uploaded" | "file.downloaded";

const notRecorded = new TransferFailed({
  reason: "failed",
  message: "The file did not move: it could not be recorded, and nothing happens unrecorded.",
});

/** The outcome row and the person's answer for a transfer that did not happen as asked. */
const transferOutcome = Match.typeTags<
  ComputerFailure | UploadStopped,
  {
    readonly outcome: Outcome;
    readonly detail: Schema.JsonObject;
    readonly error: TransferFailed;
  }
>()({
  ComputerUnavailable: (failure) => ({
    ...failureOutcome(failure),
    error: new TransferFailed({
      reason: "failed",
      message: capText(failure.message, computerMessageLimit),
    }),
  }),
  ComputerActFailed: (failure) => ({
    ...failureOutcome(failure),
    error: new TransferFailed({
      reason: failure.reason,
      message: capText(failure.message, computerMessageLimit),
    }),
  }),
  ComputerLost: (failure) => ({
    ...failureOutcome(failure),
    error: new TransferFailed({
      reason: "failed",
      message: "The computer stopped answering, so whether the file moved is unknown.",
    }),
  }),
  // The computer saves an upload only once all of it arrived, so one that stopped saved nothing.
  UploadStopped: () => ({
    outcome: "failed",
    detail: { reason: "the upload stopped partway" },
    error: new TransferFailed({ reason: "failed", message: "The upload stopped partway." }),
  }),
});

function outsideWorkspace(path: string): TransferFailed {
  return new TransferFailed({ reason: "refused", message: `${path} is outside the workspace.` });
}

/** Ends `span` with `exit`, now. */
function endSpan(span: Tracer.Span, exit: Exit.Exit<unknown, unknown>) {
  return Effect.flatMap(Clock.currentTimeNanos, (now) => Effect.sync(() => span.end(now, exit)));
}

/**
The person's {@link FileTransfers}. Each one is a `deny` row when it is refused before it starts, or an
`allow` row with the file's path, name, extension and size, then its outcome. Never what the file holds.
*/
export const fileTransfers = Effect.gen(function* () {
  const rows = yield* personAudit;
  const computers = yield* Computers;

  const refuse = (action: Action, detail: Schema.JsonObject, error: TransferFailed) =>
    Effect.andThen(rows.deny(action, detail), Effect.fail(error));

  const allow = (action: Action, detail: Schema.JsonObject) =>
    rows.decide("allow", action, detail).pipe(Effect.mapError(() => notRecorded));

  /** What became of the transfer `allowRow` allowed, once `work` answered, and that answer. */
  const carriedOut = <A, R>(
    allowRow: AuditRowId,
    work: Effect.Effect<A, ComputerFailure | UploadStopped, R>,
  ) =>
    work.pipe(
      Effect.onInterrupt(() =>
        rows.settle(allowRow, "unknown", { reason: "the transfer was stopped" }),
      ),
      Effect.catch((failure) => {
        const { outcome, detail, error } = transferOutcome(failure);

        return rows.settle(allowRow, outcome, detail).pipe(Effect.andThen(Effect.fail(error)));
      }),
    );

  const upload = Effect.fn("FileTransfers.upload")(function* <E>(
    path: string,
    bytes: number,
    body: Stream.Stream<Uint8Array, E>,
  ) {
    yield* Effect.annotateCurrentSpan({
      "gateway.action": "file.uploaded",
      "gateway.file_bytes": bytes,
    });

    const detail = { ...fileTarget(path), bytes };

    if (escapesWorkspace(path)) {
      return yield* refuse(
        "file.uploaded",
        { ...detail, reason: "outside workspace" },
        outsideWorkspace(path),
      );
    }

    if (bytes > fileTransferLimit) {
      return yield* refuse(
        "file.uploaded",
        { ...detail, reason: "too large" },
        new TransferFailed({
          reason: "too_large",
          message: `That file is ${bytes} bytes, and an upload may hold at most ${fileTransferLimit}.`,
        }),
      );
    }

    const allowRow = yield* allow("file.uploaded", detail);
    const sent = Stream.mapError(body, () => new UploadStopped());

    const saved = yield* carriedOut(
      allowRow,
      Effect.flatMap(computers.ensure, (computer) => computer.upload(path, sent)),
    );

    yield* rows.settle(allowRow, "succeeded", { bytes: saved.bytes });

    return saved;
  });

  /** The file at `path` as the computer sends it, and the `allow` row its outcome settles. */
  const fetched = Effect.fnUntraced(function* (path: string) {
    yield* Effect.annotateCurrentSpan({ "gateway.action": "file.downloaded" });

    const target = fileTarget(path);

    if (escapesWorkspace(path)) {
      return yield* refuse(
        "file.downloaded",
        { ...target, reason: "outside workspace" },
        outsideWorkspace(path),
      );
    }

    const allowRow = yield* allow("file.downloaded", { ...target });

    const file = yield* carriedOut(
      allowRow,
      Effect.flatMap(computers.running, (computer) => computer.download(path)),
    );

    yield* Effect.annotateCurrentSpan({ "gateway.file_bytes": file.bytes });

    return { name: target.name, allowRow, file };
  });

  const download = (path: string) =>
    // Uninterruptible until the finalizer that settles the row and ends the span is in place.
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // Made by hand, not by `Effect.fn`, so it ends with the download rather than when the bytes start.
        const span = yield* Effect.makeSpan("FileTransfers.download");

        const { name, allowRow, file } = yield* restore(
          fetched(path).pipe(Effect.withParentSpan(span)),
        ).pipe(Effect.onError((cause) => endSpan(span, Exit.failCause(cause))));

        const delivered = yield* Ref.make(false);

        // `succeeded` only once the last byte was read. A body read partway or not at all, as for a person
        // who went away, is `unknown`.
        yield* Effect.addFinalizer((closed) =>
          Effect.gen(function* () {
            yield* (yield* Ref.get(delivered))
              ? rows.settle(allowRow, "succeeded", { bytes: file.bytes })
              : rows.settle(allowRow, "unknown", { reason: "the download stopped partway" });
            yield* endSpan(span, closed);
          }),
        );

        const body = file.body.pipe(
          Stream.onEnd(Ref.set(delivered, true)),
          Stream.mapError(
            () =>
              new TransferFailed({ reason: "failed", message: "The download stopped partway." }),
          ),
        );

        return { name, bytes: file.bytes, body } satisfies FileDownload;
      }),
    );

  return FileTransfers.of({ upload, download });
});
