import { Data, type Result, Schema } from "effect";

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
