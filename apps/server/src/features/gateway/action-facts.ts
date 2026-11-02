import { type BotId, canonicalHost, ComputerAction, type RefTarget } from "@aobot/domain";
import type { Facts } from "../policy/public.ts";
import { fileTarget } from "./file-target.ts";
import { singleUser } from "./person-audit.ts";

/**
The host of `url` in the one spelling the computer's egress checks it in, without its port: `SHOP.example.`
and `shop.example%2e` are `shop.example`, `[::1]` is `::1`. `""` for an address that does not parse.
*/
export function hostOf(url: string): string {
  return URL.canParse(url) ? canonicalHost(new URL(url).hostname) : "";
}

const element = ({ role, name }: RefTarget) => ({ element: { role, name } });

/** The facts only some actions have: the element a ref names, the key, the command, the file. */
const ownFacts = ComputerAction.match({
  navigate: () => ({}),
  snapshot: () => ({}),
  click: ({ target }) => element(target),
  type: ({ target }) => element(target),
  press: ({ target, key }) => ({ ...element(target), key }),
  run: ({ command }) => ({ command }),
  read_file: ({ path }) => ({ file: fileTarget(path) }),
  write_file: ({ path }) => ({ file: fileTarget(path) }),
  list_files: ({ path }) => ({ file: fileTarget(path) }),
});

/**
What the rules see of `action`, which `bot` asked for on a page at `host`: its own facts, and `""` for every
fact it has none of.
*/
export function actionFacts(bot: BotId, action: ComputerAction, host: string): Facts {
  return {
    tool: { name: action.action },
    bot: { id: bot },
    actor: { id: singleUser },
    computer: { kind: "cloud" },
    page: { host },
    element: { role: "", name: "" },
    key: "",
    command: "",
    file: { path: "", name: "", extension: "" },
    ...ownFacts(action),
  };
}
