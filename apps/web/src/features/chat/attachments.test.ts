import { ConversationId, fileTransferLimit } from "@aobot/domain";
import { Effect, Layer, Option, type Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Attachment, without } from "./attachment-state.ts";
import { makeAttachments } from "./attachments.ts";

/**
A server that answers every upload with `status` and `json`, or an empty body, and keeps the URL and length
of each.
*/
function serverAnswering(status: number, json?: Schema.Json) {
  const received: Array<string> = [];

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      received.push(
        `${request.method} ${url.pathname}${url.search} ${request.headers["content-length"]}`,
      );

      return HttpClientResponse.fromWeb(
        request,
        new Response(json === undefined ? null : JSON.stringify(json), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://aobot.test")));

  return { received, runtime: Atom.runtime(Layer.succeed(HttpClient.HttpClient, client)) };
}

const registries: AtomRegistry.AtomRegistry[] = [];

afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
});

const conversation = ConversationId.make("c1");

/** The chips of `conversation` once `ready` holds of them. */
function chipsWhen(
  registry: AtomRegistry.AtomRegistry,
  chips: Atom.Atom<ReadonlyArray<Attachment>>,
  ready: (chips: ReadonlyArray<Attachment>) => boolean,
) {
  return Atom.toStream(chips).pipe(
    Stream.filter(ready),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.provideService(AtomRegistry.AtomRegistry, registry),
    Effect.runPromise,
  );
}

/** A registry with `runtime`'s attachments, disposed after the test. */
function composer(runtime: Atom.AtomRuntime<HttpClient.HttpClient>) {
  const registry = AtomRegistry.make();
  registries.push(registry);

  const { attachments, attach } = makeAttachments(runtime);
  registry.mount(attach(conversation));

  return { registry, attachments, pick: (file: File) => registry.set(attach(conversation), file) };
}

/** Picks `file` and waits until nothing is uploading, then answers the chips the composer shows. */
function pick(runtime: Atom.AtomRuntime<HttpClient.HttpClient>, file: File) {
  const shown = composer(runtime);
  shown.pick(file);

  return chipsWhen(
    shown.registry,
    shown.attachments(conversation),
    (chips) => chips.length > 0 && !chips.some(Attachment.$is("Uploading")),
  );
}

const expenses = new File(["date,amount\n2026-10-01,12.50\n"], "expenses.csv", {
  type: "text/csv",
});

describe("given a file the person picked", () => {
  describe("when the server saves it", () => {
    it("uploads it under its name with its length, and shows it ready at the path it got", async () => {
      const server = serverAnswering(200, { path: "expenses.csv", bytes: 29 });

      const [chip] = await pick(server.runtime, expenses);

      expect(server.received).toEqual(["PUT /files?path=expenses.csv 29"]);
      expect(chip).toEqual(
        Attachment.Ready({ id: expect.any(String), name: "expenses.csv", path: "expenses.csv" }),
      );
    });
  });

  describe("when the server refuses it", () => {
    it("shows why on the chip", async () => {
      const server = serverAnswering(413, { message: "That file is too large." });

      const [chip] = await pick(server.runtime, expenses);

      expect(chip).toEqual(
        Attachment.Failed({
          id: expect.any(String),
          name: "expenses.csv",
          message: "That file is too large.",
        }),
      );
    });
  });

  describe("when the server refuses it without saying why", () => {
    it.each([
      [403, "The server refused an upload from this page."],
      [413, "The file is too large for the server."],
      [500, "The server turned the upload away with status 500."],
    ])("shows a %i as %j on the chip", async (status, message) => {
      const [chip] = await pick(serverAnswering(status).runtime, expenses);

      expect(chip).toEqual(
        Attachment.Failed({ id: expect.any(String), name: "expenses.csv", message }),
      );
    });
  });

  describe("when it is past the limit", () => {
    it("says so without sending a byte of it", async () => {
      const server = serverAnswering(200, {});
      const huge = new File([], "huge.zip");
      Object.defineProperty(huge, "size", { value: fileTransferLimit + 1 });

      const [chip] = await pick(server.runtime, huge);

      expect(server.received).toEqual([]);
      expect(chip).toEqual(
        Attachment.Failed({
          id: expect.any(String),
          name: "huge.zip",
          message: "huge.zip is 101 MB, and a file may be at most 100 MB.",
        }),
      );
    });
  });
});

describe("given a file still uploading", () => {
  describe("when the person takes its chip out", () => {
    it("stops the upload, and the chip stays gone", async () => {
      const aborted: Array<string> = [];

      const hanging = HttpClient.make((request) =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => aborted.push(request.url)))),
      ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://aobot.test")));

      const shown = composer(Atom.runtime(Layer.succeed(HttpClient.HttpClient, hanging)));
      const chips = shown.attachments(conversation);
      shown.pick(expenses);

      const [uploading] = await chipsWhen(shown.registry, chips, (current) => current.length > 0);
      shown.registry.set(chips, without(shown.registry.get(chips), uploading?.id ?? ""));

      await expect.poll(() => aborted).toEqual(["http://aobot.test/files?path=expenses.csv"]);
      expect(shown.registry.get(chips)).toEqual([]);
    });
  });
});

describe("given two conversations", () => {
  it("shows a file picked in one only in that one", async () => {
    const server = serverAnswering(200, { path: "expenses.csv", bytes: 29 });
    const shown = composer(server.runtime);
    shown.pick(expenses);

    await chipsWhen(shown.registry, shown.attachments(conversation), (chips) =>
      chips.some(Attachment.$is("Ready")),
    );

    expect(shown.registry.get(shown.attachments(ConversationId.make("c2")))).toEqual([]);
  });
});
