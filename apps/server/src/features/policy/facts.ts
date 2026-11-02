import type { ToolName } from "@aobot/domain";
import { Environment } from "@marcbachmann/cel-js";

/**
What a rule sees of one action. Every field is bound on every action, `""` where the action has none, so a
rule that names a field another tool sets answers false instead of throwing. The gateway fills it in after
it resolved the action, so `element` is what the server's own snapshot says the ref names, never what the
Bot claimed.
*/
export interface Facts {
  readonly tool: { readonly name: ToolName };
  /** The Bot the call is for, by its id. */
  readonly bot: { readonly id: string };
  /** The person on whose authority the action runs: `single-user` until E3 brings sign-in. */
  readonly actor: { readonly id: string };
  /** The computer it acts on: `cloud` until the Mac arrives. */
  readonly computer: { readonly kind: string };
  /**
  The host `navigate` opens, or for the other browser actions the host of the page the latest snapshot
  read, spelt as `canonicalHost` spells it and without its port. `""` when there is none.
  */
  readonly page: { readonly host: string };
  /** The element a ref names in the latest snapshot. */
  readonly element: { readonly role: string; readonly name: string };
  /** The key `press` presses. */
  readonly key: string;
  /** The command `run` runs, as the Bot wrote it. */
  readonly command: string;
  /**
  The file a file action names: its path inside the workspace, its name, and its extension, lower-cased
  and without its dot.
  */
  readonly file: { readonly path: string; readonly name: string; readonly extension: string };
}

/**
{@link Facts} with every field `""` but the tool, which must be one: what an action that has none of them
shows a rule. The gateway starts every action's facts from it, and every rule is tried on it once when
the rules file is read.
*/
export const blankFacts: Facts = {
  tool: { name: "snapshot" },
  bot: { id: "" },
  actor: { id: "" },
  computer: { kind: "" },
  page: { host: "" },
  element: { role: "", name: "" },
  key: "",
  command: "",
  file: { path: "", name: "", extension: "" },
};

/** The CEL type of each field of `T`, nested as `T` is, so it names every field and nothing else. */
type CelFields<T> = {
  readonly [Field in keyof T]: T[Field] extends string
    ? "string"
    : T[Field] extends object
      ? CelFields<T[Field]>
      : never;
};

const factFields: CelFields<Facts> = {
  tool: { name: "string" },
  bot: { id: "string" },
  actor: { id: "string" },
  computer: { kind: "string" },
  page: { host: "string" },
  element: { role: "string", name: "string" },
  key: "string",
  command: "string",
  file: { path: "string", name: "string", extension: "string" },
};

/** The CEL environment a rule is checked and evaluated in: the {@link Facts} and nothing else. */
export const factsEnvironment = new Environment();

for (const [name, field] of Object.entries(factFields)) {
  if (field === "string") {
    factsEnvironment.registerVariable(name, field);
  } else {
    factsEnvironment.registerVariable({ name, schema: field });
  }
}
