import type { RefTarget } from "@aobot/domain";
import { Array, Option, Schema } from "effect";
import { hostOf } from "./action-facts.ts";
import { ToolAction } from "./tool-action.ts";

/**
The kinds of action a Bot never takes on its own, whatever the rules say: entering or changing a credential,
changing a security setting, and paying. A `hand_off` row stores the list as `safety: "credentials"`,
which the audit page shows as `safety:credentials`.
*/
export const SafetyList = Schema.Literals(["credentials", "security", "payments"]);

/** A decoded {@link SafetyList}. */
export type SafetyList = typeof SafetyList.Type;

interface Safety {
  /** What the list covers, as the Bot is told it, such as "paying, buying or moving money". */
  readonly about: string;
  readonly pattern: RegExp;
}

/**
Each safety list, matched in this order. Deliberately broad: a false hand-off costs the person one click,
a missed one costs them their account or their money. Fixed in code, so no rule or setting turns one off.
*/
const safetyLists = {
  credentials: {
    about: "entering or changing a password, one-time code or other credential",
    pattern:
      /pass(word|code|phrase)|passwd|one[-_ ]?time[-_ ]?(code|password)|\botp\b|security[-_ ]?question|credential|sign[-_ ]?in[-_ ]?method/i,
  },
  security: {
    about:
      "changing a security setting, such as two-factor sign-in, recovery codes, API keys or who has access",
    pattern:
      /\b2fa\b|two[-_ ]?factor|\bmfa\b|recovery[-_ ]?(code|key|email|phone)|api[-_ ]?key|access[-_ ]?token|security[-_ ]?settings?|\/settings\/security|account[-_ ]?security|sharing[-_ ]?settings?|share[-_ ]?with[-_ ]?(anyone|public)|make[-_ ]?public|admin[-_ ]?role|grant[-_ ]?admin|permission[-_ ]?settings?|delete[-_ ]?(my[-_ ]?)?account|close[-_ ]?account/i,
  },
  payments: {
    about: "paying, buying or moving money",
    pattern:
      // A wire of money, not a news wire: "Business Wire" is where press releases go out.
      /payment|\bpay(ing)?\b|pay[-_ ]?now|checkout|purchase|place[-_ ]?order|buy[-_ ]?now|add[-_ ]?(a[-_ ]?)?card|(?<!\b(business|news|press)[-_ ]?)\bwire\b|bank[-_ ]?transfer|transfer[-_ ]?(money|funds)|send[-_ ]?money|credit[-_ ]?card|card[-_ ]?number|\bcv[cv]\b|\biban\b|routing[-_ ]?number|billing/i,
  },
} satisfies { readonly [List in SafetyList]: Safety };

/** What `list` covers, as the Bot is told it. */
export const safetyAbout = (list: SafetyList): string => safetyLists[list].about;

/** The first safety list `words` match. */
const listOf = (words: string): Option.Option<SafetyList> =>
  Array.findFirst(SafetyList.literals, (list) => safetyLists[list].pattern.test(words));

/** The element's role and name, and the host and path of the page it is on: never its query or fragment. */
const onPage = ({ role, name, url }: RefTarget, path: string) =>
  listOf([role, name, hostOf(url), path].join(" "));

/**
The safety list `action` falls under, read from the element it acts on as the server's snapshot names it
and the page at `path` that snapshot was read on, never from the text a Bot types or the key it presses:
what a Bot types is content, and a note about a customer's purchase is not a purchase. Only an action that
changes a page is subject to it. Opening or reading a page is not: reading a checkout page is not paying.
Commands and files are workspace tools, left to the rules: a command's text is a filter, not a boundary,
and the egress filter decides where it may reach. And `request_secret` is the person typing the credential
themselves, on a card that names the field and the site; the click or key that submits it is judged like
any other, so a "Change password" button is still the person's.
*/
export const safetyOf = (action: ToolAction, path: string): Option.Option<SafetyList> =>
  ToolAction.match(action, {
    navigate: () => Option.none(),
    snapshot: () => Option.none(),
    click: ({ target }) => onPage(target, path),
    type: ({ target }) => onPage(target, path),
    press: ({ target }) => onPage(target, path),
    run: () => Option.none(),
    read_file: () => Option.none(),
    write_file: () => Option.none(),
    list_files: () => Option.none(),
    request_secret: () => Option.none(),
  });
