import { describe, expect, it } from "vite-plus/test";
import { Incoming, readLine, Reply, replyLine, requestLine } from "./wire.ts";

describe("readLine", () => {
  it("reads a request the agent sends us", () => {
    expect(
      readLine('{"jsonrpc":"2.0","id":7,"method":"terminal/create","params":{"command":"env"}}'),
    ).toEqual(Incoming.Request({ id: 7, method: "terminal/create", params: { command: "env" } }));
  });

  it("reads a notification", () => {
    expect(readLine('{"jsonrpc":"2.0","method":"session/update","params":{"x":1}}')).toEqual(
      Incoming.Notification({ method: "session/update", params: { x: 1 } }),
    );
  });

  it("reads an answer, including a null one", () => {
    expect(readLine('{"jsonrpc":"2.0","id":0,"result":null}')).toEqual(
      Incoming.Answered({ id: 0, result: null }),
    );
  });

  it("reads a refusal", () => {
    expect(
      readLine(
        '{"jsonrpc":"2.0","id":"a","error":{"code":-32000,"message":"Authentication required"}}',
      ),
    ).toEqual(Incoming.Failed({ id: "a", code: -32000, message: "Authentication required" }));
  });

  it.each(["npm warn deprecated", "", "{}", '{"id":1}', "[1,2]"])("skips %j", (line) => {
    expect(readLine(line)).toEqual(Incoming.Unreadable());
  });
});

describe("writing", () => {
  it("writes one JSON-RPC message per line", () => {
    expect(requestLine(1, "initialize", { protocolVersion: 1 })).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n',
    );
    expect(replyLine("x", Reply.Error({ code: -32601, message: "Method not found" }))).toBe(
      '{"jsonrpc":"2.0","id":"x","error":{"code":-32601,"message":"Method not found"}}\n',
    );
  });
});
