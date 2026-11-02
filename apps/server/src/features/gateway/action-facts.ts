import { type BotId, ComputerAction, type RefTarget } from "@aobot/domain";
import type { Facts } from "../policy/public.ts";
import { fileTarget } from "./file-target.ts";
import { singleUser } from "./person-audit.ts";

/**
The host of `url` as the computer reads it when it opens it, lower-cased and without its port, or `""` for
an address the computer would refuse as no web address.
*/
export function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).hostname : "";
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
