import type { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ClientDecision, decideClientRequest } from "./client-requests.ts";
import { methodNotFound, Reply } from "./wire.ts";

const refusedWith = (detail: Schema.JsonObject, reply: Reply) =>
  ClientDecision.Refuse({ detail, reply });

const notOffered = Reply.Error({ code: -32000, message: expect.stringContaining("gateway") });

describe("decideClientRequest", () => {
  it("refuses a terminal and records only the length of the command", () => {
    const decision = decideClientRequest("terminal/create", {
      sessionId: "s",
      command: "env",
      args: ["-0"],
    });

    expect(decision).toEqual(refusedWith({ command: "[6 chars]" }, notOffered));
  });

  it.each(["terminal/output", "terminal/wait_for_exit", "terminal/kill", "terminal/release"])(
    "refuses %s",
    (method) => {
      expect(decideClientRequest(method, { sessionId: "s", terminalId: "t" })).toEqual(
        refusedWith({}, notOffered),
      );
    },
  );

  it("refuses reading a file and records only the length of its path", () => {
    expect(
      decideClientRequest("fs/read_text_file", { sessionId: "s", path: "/etc/passwd" }),
    ).toEqual(refusedWith({ path: "[11 chars]" }, notOffered));
  });

  it("refuses writing a file and records neither its path nor its content", () => {
    const decision = decideClientRequest("fs/write_text_file", {
      sessionId: "s",
      path: "/tmp/x",
      content: "secret",
    });

    expect(decision).toEqual(refusedWith({ path: "[6 chars]", content: "[6 chars]" }, notOffered));
  });

  it("refuses a permission with the agent's own reject choice, keeping the kind and the title's length", () => {
    const decision = decideClientRequest("session/request_permission", {
      sessionId: "s",
      toolCall: { toolCallId: "t", title: "cat /etc/passwd", kind: "execute" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });

    expect(decision).toEqual(
      refusedWith(
        { kind: "execute", title: "[15 chars]" },
        Reply.Result({ result: { outcome: { outcome: "selected", optionId: "no" } } }),
      ),
    );
  });

  it("refuses a permission that offers no way to reject by cancelling it", () => {
    const decision = decideClientRequest("session/request_permission", {
      sessionId: "s",
      toolCall: { toolCallId: "t" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_always" }],
    });

    expect(decision).toEqual(
      refusedWith(
        { kind: null, title: null },
        Reply.Result({ result: { outcome: { outcome: "cancelled" } } }),
      ),
    );
  });

  it("refuses a request whose params it cannot read, recording nothing about them", () => {
    expect(decideClientRequest("terminal/create", "not an object")).toEqual(
      refusedWith({}, notOffered),
    );
  });

  it("answers a method ACP clients do not have with method not found", () => {
    expect(decideClientRequest("_claude/something", {})).toEqual(
      ClientDecision.Unknown({
        reply: Reply.Error({
          code: methodNotFound,
          message: "Method not found: _claude/something",
        }),
      }),
    );
  });
});
