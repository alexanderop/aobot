import { Data, Option, Schema } from "effect";

/** A JSON-RPC request id. We number ours; an agent may use strings for its own. */
const RequestId = Schema.Union([Schema.Number, Schema.String]);

/** A decoded {@link RequestId}. */
export type RequestId = typeof RequestId.Type;

/** Every field any JSON-RPC 2.0 message may carry. Which ones are present says what it is. */
const WireMessage = Schema.Struct({
  id: Schema.OptionFromOptionalKey(RequestId),
  method: Schema.OptionFromOptionalKey(Schema.String),
  params: Schema.OptionFromOptionalKey(Schema.Json),
  result: Schema.OptionFromOptionalKey(Schema.Json),
  error: Schema.OptionFromOptionalKey(
    Schema.Struct({ code: Schema.Number, message: Schema.String }),
  ),
});

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(WireMessage));

/** One line from the agent's stdout, read as what it is. */
export type Incoming = Data.TaggedEnum<{
  /** The agent asks us something and waits for a reply, such as `session/request_permission`. */
  Request: { readonly id: RequestId; readonly method: string; readonly params: Schema.Json };
  /** The agent tells us something, such as `session/update`. */
  Notification: { readonly method: string; readonly params: Schema.Json };
  /** The agent answered one of our requests. */
  Answered: { readonly id: RequestId; readonly result: Schema.Json };
  /** The agent turned one of our requests down. */
  Failed: { readonly id: RequestId; readonly code: number; readonly message: string };
  /** Not JSON-RPC: a log line on stdout, or a broken message. */
  Unreadable: {};
}>;

/** Constructors and matchers for {@link Incoming}. */
export const Incoming = Data.taggedEnum<Incoming>();

/** Read one line of newline-delimited JSON-RPC. */
export function readLine(line: string): Incoming {
  return Option.match(decodeLine(line), {
    onNone: () => Incoming.Unreadable(),
    onSome: (message) => {
      const params = Option.getOrElse(message.params, () => null);

      if (Option.isSome(message.method)) {
        const method = message.method.value;

        return Option.match(message.id, {
          onNone: () => Incoming.Notification({ method, params }),
          onSome: (id) => Incoming.Request({ id, method, params }),
        });
      }

      if (Option.isNone(message.id)) return Incoming.Unreadable();
      const id = message.id.value;

      if (Option.isSome(message.error)) {
        return Incoming.Failed({ id, ...message.error.value });
      }

      return Option.match(message.result, {
        onNone: () => Incoming.Unreadable(),
        onSome: (result) => Incoming.Answered({ id, result }),
      });
    },
  });
}

/** How we answer a request the agent sent us. */
export type Reply = Data.TaggedEnum<{
  Result: { readonly result: Schema.Json };
  Error: { readonly code: number; readonly message: string };
}>;

/** Constructors and matchers for {@link Reply}. */
export const Reply = Data.taggedEnum<Reply>();

/** JSON-RPC's "Method not found". */
export const methodNotFound = -32601;

const jsonrpc = "2.0";

function line(message: Schema.JsonObject): string {
  return `${JSON.stringify(message)}\n`;
}

/** Our request, as one line for the agent's stdin. */
export function requestLine(id: number, method: string, params: Schema.Json): string {
  return line({ jsonrpc, id, method, params });
}

/** Our notification, as one line for the agent's stdin. */
export function notificationLine(method: string, params: Schema.Json): string {
  return line({ jsonrpc, method, params });
}

/** Our reply to the agent's request `id`, as one line for its stdin. */
export function replyLine(id: RequestId, reply: Reply): string {
  return Reply.$match(reply, {
    Result: ({ result }) => line({ jsonrpc, id, result }),
    Error: ({ code, message }) => line({ jsonrpc, id, error: { code, message } }),
  });
}
