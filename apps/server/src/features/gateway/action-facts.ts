import {
  type BotId,
  canonicalHost,
  ComputerAction,
  type FileAction,
  type RefTarget,
} from "@aobot/domain";
import { blankFacts, type Facts } from "../policy/public.ts";
import { fileTarget } from "./file-target.ts";
import { singleUser } from "./person-audit.ts";

/**
The host of `url` in the one spelling the computer's egress checks it in, without its port: `SHOP.example.`
and `shop.example%2e` are `shop.example`, `[::1]` is `::1`. `""` for an address that does not parse.
*/
export function hostOf(url: string): string {
  return URL.canParse(url) ? canonicalHost(new URL(url).hostname) : "";
}

/** The facts only some actions have, each as {@link Facts} names it, so a misspelt one does not compile. */
type OwnFacts = Partial<Pick<Facts, "element" | "key" | "command" | "file">>;

const element = ({ role, name }: RefTarget): OwnFacts => ({ element: { role, name } });

const file = ({ path }: FileAction): OwnFacts => ({ file: fileTarget(path) });

/** The facts only some actions have: the element a ref names, the key, the command, the file. */
const ownFacts = ComputerAction.match({
  navigate: (): OwnFacts => ({}),
  snapshot: (): OwnFacts => ({}),
  click: ({ target }) => element(target),
  type: ({ target }) => element(target),
  press: ({ target, key }): OwnFacts => ({ ...element(target), key }),
  run: ({ command }): OwnFacts => ({ command }),
  read_file: file,
  write_file: file,
  list_files: file,
});

/**
What the rules see of `action`, which `bot` asked for on a page at `host`: its own facts, and `""` for every
fact it has none of.
*/
export function actionFacts(bot: BotId, action: ComputerAction, host: string): Facts {
  return {
    ...blankFacts,
    tool: { name: action.action },
    bot: { id: bot },
    actor: { id: singleUser },
    computer: { kind: "cloud" },
    page: { host },
    ...ownFacts(action),
  };
}
