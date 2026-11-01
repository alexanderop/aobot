import { Array, Data, Option, Schema } from "effect";
import { redact } from "../../../shared/redact.ts";
import { methodNotFound, Reply } from "./wire.ts";

/** What we do with one request an agent sends us. */
export type ClientDecision = Data.TaggedEnum<{
  /** A request we never grant outside the gateway: write a `deny` row, then answer with `reply`. */
  Refuse: { readonly detail: Schema.JsonObject; readonly reply: Reply };
  /** A method we do not speak. */
  Unknown: { readonly reply: Reply };
}>;

/** Constructors and matchers for {@link ClientDecision}. */
export const ClientDecision = Data.taggedEnum<ClientDecision>();

/** How one method is refused: what its audit row says, and how the agent is answered. */
interface RefusalRule {
  readonly refuse: (params: Schema.Json) => ClientDecision;
}

const notOffered = Reply.Error({
  code: -32000,
  message:
    "aobot does not offer files or terminals to agents. A Bot acts only through the gateway's tools.",
});

/**
A rule that reads the request's params with `schema`. Params that do not match are refused all the same,
with nothing recorded about them.
*/
function refusal<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  detail: (params: S["Type"]) => Schema.JsonObject,
  reply: (params: Option.Option<S["Type"]>) => Reply,
): RefusalRule {
  const decode = Schema.decodeUnknownOption(schema);

  return {
    refuse: (params) => {
      const read = decode(params);

      return ClientDecision.Refuse({
        detail: Option.match(read, { onNone: () => ({}), onSome: detail }),
        reply: reply(read),
      });
    },
  };
}

const PermissionRequest = Schema.Struct({
  toolCall: Schema.Struct({
    title: Schema.OptionFromOptionalKey(Schema.NullOr(Schema.String)),
    kind: Schema.OptionFromOptionalKey(Schema.NullOr(Schema.String)),
  }),
  options: Schema.Array(Schema.Struct({ optionId: Schema.String, kind: Schema.String })),
});

/** Pick the agent's own "reject" choice; without one, `cancelled` is the only refusal ACP has. */
function rejectPermission(request: Option.Option<typeof PermissionRequest.Type>): Reply {
  const reject = Option.flatMap(request, ({ options }) =>
    Array.findFirst(
      options,
      (option) => option.kind === "reject_once" || option.kind === "reject_always",
    ),
  );

  return Reply.Result({
    result: Option.match(reject, {
      onNone: () => ({ outcome: { outcome: "cancelled" } }),
      onSome: ({ optionId }) => ({ outcome: { outcome: "selected", optionId } }),
    }),
  });
}

const nothingToRecord = Schema.Struct({});

/**
Every client-side method of ACP, all refused. The CLI's built-in tools are switched off at launch, so a
request here is the CLI trying to act outside the gateway anyway. Gateway tools arrive over MCP, never
through these methods.
*/
const clientRequests: ReadonlyMap<string, RefusalRule> = new Map([
  [
    "session/request_permission",
    refusal(
      PermissionRequest,
      ({ toolCall }) => ({
        kind: Option.getOrNull(Option.flatMap(toolCall.kind, Option.fromNullOr)),
        // A title such as "cat /etc/passwd" spells out what the Bot typed.
        title: Option.getOrNull(
          Option.map(Option.flatMap(toolCall.title, Option.fromNullOr), redact),
        ),
      }),
      rejectPermission,
    ),
  ],
  [
    "fs/read_text_file",
    refusal(
      Schema.Struct({ path: Schema.String }),
      ({ path }) => ({ path: redact(path) }),
      () => notOffered,
    ),
  ],
  [
    "fs/write_text_file",
    refusal(
      Schema.Struct({ path: Schema.String, content: Schema.String }),
      ({ path, content }) => ({ path: redact(path), content: redact(content) }),
      () => notOffered,
    ),
  ],
  [
    "terminal/create",
    refusal(
      Schema.Struct({
        command: Schema.String,
        args: Schema.OptionFromOptionalKey(Schema.Array(Schema.String)),
      }),
      ({ command, args }) => ({
        command: redact([command, ...Option.getOrElse(args, () => [])].join(" ")),
      }),
      () => notOffered,
    ),
  ],
  [
    "terminal/output",
    refusal(
      nothingToRecord,
      () => ({}),
      () => notOffered,
    ),
  ],
  [
    "terminal/wait_for_exit",
    refusal(
      nothingToRecord,
      () => ({}),
      () => notOffered,
    ),
  ],
  [
    "terminal/kill",
    refusal(
      nothingToRecord,
      () => ({}),
      () => notOffered,
    ),
  ],
  [
    "terminal/release",
    refusal(
      nothingToRecord,
      () => ({}),
      () => notOffered,
    ),
  ],
]);

/** Decide what to do with the agent's request `method`. Pure: the caller writes the audit row. */
export function decideClientRequest(method: string, params: Schema.Json): ClientDecision {
  return Option.match(Option.fromUndefinedOr(clientRequests.get(method)), {
    onNone: () =>
      ClientDecision.Unknown({
        reply: Reply.Error({ code: methodNotFound, message: `Method not found: ${method}` }),
      }),
    onSome: (rule) => rule.refuse(params),
  });
}
