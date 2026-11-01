import { findRef, snapshotRefs } from "@aobot/domain";
import { Array, Data, Option, Predicate, Record, Result, Schema } from "effect";

/** One tool the model asks to run, with the input it passes. */
export interface ScriptedToolCall {
  readonly name: string;
  readonly params: Schema.JsonObject;
}

/** What the model answers on one call: text, streamed word by word, or tools to run. */
export type ModelStep = Data.TaggedEnum<{
  Say: { readonly words: ReadonlyArray<string> };
  CallTools: { readonly calls: ReadonlyArray<ScriptedToolCall> };
}>;

/** Constructors and matchers for {@link ModelStep}. */
export const ModelStep = Data.taggedEnum<ModelStep>();

/**
The model's answers in order, one per model call. The scripted `LanguageModel` (tier 2) and the mock
model server (tiers 3 and 4) both replay one, so a test says what the model does once.
*/
export type ModelScript = ReadonlyArray<ModelStep>;

/** A {@link ModelScript} as JSON: `[{ "_tag": "CallTools", "calls": [...] }, { "_tag": "Say", "words": [...] }]`. */
const ModelScriptJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Union([
      Schema.TaggedStruct("Say", { words: Schema.Array(Schema.String) }),
      Schema.TaggedStruct("CallTools", {
        calls: Schema.Array(Schema.Struct({ name: Schema.String, params: Schema.JsonObject })),
      }),
    ]),
  ),
);

/** Read a script sent as JSON, such as the body of the mock model's `PUT /mock/script`. */
export const decodeModelScript: (json: string) => Result.Result<ModelScript, Schema.SchemaError> =
  Schema.decodeUnknownResult(ModelScriptJson);

/** Why a test model was called more often than its script has answers. */
export function scriptOverrun(script: ModelScript, call: number): string {
  return `The model script has ${script.length} answer(s), but the model was called ${call} times. Add a step to the script.`;
}

const RefMarker = Schema.Struct({
  $refTo: Schema.Struct({ role: Schema.String, name: Schema.String }),
});

const isRefMarker = Schema.is(RefMarker);

/**
A tool input the mock model fills in as it answers: the ref of the first element with this role and name
on the latest page in the request it received. A live page's refs are not known when a script is written.
*/
export function refTo(role: string, name: string): Schema.JsonObject {
  return { $refTo: { role, name } };
}

/**
`params` with each {@link refTo} marker replaced by its ref, read from the last of `texts` that holds a
snapshot, or what the script asked for that no page showed.
*/
export function fillRefs(
  params: Schema.JsonObject,
  texts: ReadonlyArray<string>,
): Result.Result<Schema.JsonObject, string> {
  const page = Array.findLast(texts, (text) => snapshotRefs(text).size > 0);

  return Result.all(
    Record.map(params, (value): Result.Result<Schema.Json, string> => {
      if (!isRefMarker(value)) return Result.succeed(value);

      const { role, name } = value.$refTo;

      return Option.match(
        Option.flatMap(page, (snapshot) => findRef(snapshot, { role, name })),
        {
          onNone: () =>
            Result.fail(
              `The script asks for the ref of the ${role} "${name}", but the latest page the model was shown has none.`,
            ),
          onSome: (target) => Result.succeed(target.ref),
        },
      );
    }),
  );
}

/** Every string in a JSON value, in the order it was written: where a model request carries its tool results. */
export function jsonStrings(value: Schema.Json): ReadonlyArray<string> {
  if (Predicate.isString(value)) return [value];

  if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value)) return [];

  return Object.values(value).flatMap(jsonStrings);
}
