import type { BotId, ToolName } from "@aobot/domain";
import { Environment } from "@marcbachmann/cel-js";

/**
What a rule sees of one action. Every field is bound on every action, `""` where the action has none, so a
rule that names a field another tool sets answers false instead of throwing. The gateway fills it in after
it resolved the action, so `element` is what the server's own snapshot says the ref names, never what the
Bot claimed.
*/
export interface Facts {
  readonly tool: { readonly name: ToolName };
  readonly bot: { readonly id: BotId };
  /** The person on whose authority the action runs: `single-user` until E3 brings sign-in. */
  readonly actor: { readonly id: string };
  readonly computer: { readonly kind: "cloud" };
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
  /** The file a file action names: its path inside the workspace, its name, and its lower-case extension. */
  readonly file: { readonly path: string; readonly name: string; readonly extension: string };
}

/** The CEL type of each field of `T`, nested as `T` is, so it names every field and nothing else. */
type CelFields<T> = {
  readonly [Field in keyof T]: T[Field] extends string ? "string" : CelFields<T[Field]>;
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
export const factsEnvironment: Environment = Object.entries(factFields).reduce(
  (environment, [name, field]) =>
    field === "string"
      ? environment.registerVariable(name, field)
      : environment.registerVariable({ name, schema: field }),
  new Environment(),
);
