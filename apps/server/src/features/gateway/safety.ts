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
  /** What the list covers, as the Bot is told it, such as "paying, buying, subscribing or moving money". */
  readonly about: string;
  readonly pattern: RegExp;
}

/**
One case-insensitive Unicode pattern that matches where any of `alternatives` does. It joins their sources,
so an alternative's own flags would be dropped and change what it means: it refuses any.
*/
const anyOf = (...alternatives: ReadonlyArray<RegExp>): RegExp => {
  const flagged = alternatives.find(({ flags }) => flags !== "");

  if (flagged !== undefined) {
    throw new Error(`anyOf matches with "iu": drop the flags of ${String(flagged)}`);
  }

  return new RegExp(alternatives.map(({ source }) => source).join("|"), "iu");
};

/**
Each safety list, matched in this order. Deliberately broad: a false hand-off costs the person one click,
a missed one costs them their account or their money. Fixed in code, so no rule or setting turns one off.
*/
const safetyLists = {
  credentials: {
    about: "entering or changing a password, PIN, one-time code or other credential",
    pattern: anyOf(
      /pass(word|code|phrase)|passwd|passwort|kennwort/,
      /one[-_ ]?time[-_ ]?(code|password)|\botp\b|verification[-_ ]?code/,
      // A PIN only as a field or with what is done to it: a "Pin" button pins a message, and Pinterest
      // keeps its pages under /pin/, so a field's match starts at its role and stops at the first slash.
      /^(textbox|spinbutton)\b[^/]*\bpin\b|\bpin[-_ ]?(code|number)\b|\b(enter|change|reset|forgot)[-_ ]?(your[-_ ]?)?pin\b/,
      /security[-_ ]?question|credential|sign[-_ ]?in[-_ ]?method/,
      // Credentials are matched before payments, so a card's security code is a credential.
      /security[-_ ]?code/,
      // From a word's start: a "Cost center code" is not a code to enter.
      /\benter[-_ ]?(the[-_ ]?)?(\d[-_ ]?digit[-_ ]?)?code\b/,
    ),
  },
  security: {
    about:
      "changing a security setting, such as two-factor sign-in, passkeys, recovery codes, API keys, sessions or who has access",
    pattern: anyOf(
      /\b2fa\b|two[-_ ]?factor|\bmfa\b|\b(2|two)[-_ ]?step|authenticator|passkey/,
      /recovery[-_ ]?(code|key|email|phone)/,
      /api[-_ ]?key|access[-_ ]?token|ssh[-_ ]?key|\/settings\/(tokens|keys|ssh)/,
      /security[-_ ]?settings?|\/settings\/security|account[-_ ]?security/,
      /\brevoke\b|\b(sign|log)[-_ ]?out[-_ ]?(of[-_ ]?)?(all|every|other)/,
      /change[-_ ]?(your[-_ ]?)?e-?mail/,
      /sharing[-_ ]?settings?|share[-_ ]?with[-_ ]?(anyone|public)|make[-_ ]?public/,
      /admin[-_ ]?role|grant[-_ ]?admin|make[-_ ]?(an?[-_ ]?)?admin|permission[-_ ]?settings?/,
      /\binvite\b|add[-_ ]?(a[-_ ]?)?(member|collaborator|people)/,
      /change[-_ ]?role|\bto[-_ ]?owner\b|transfer[-_ ]?ownership/,
      // A whole word: "Authorized dealers" lists shops, it grants nothing.
      /\bauthori[sz]e\b|(allow|grant)[-_ ]?access|connected[-_ ]?apps?/,
      /delete[-_ ]?(my[-_ ]?)?account|close[-_ ]?account|deactivate[-_ ]?(my[-_ ]?)?account/,
      /zwei[-_ ]?faktor|konto[-_ ]?(löschen|schließen)|e-?mail(-adresse)?[-_ ]?ändern/,
    ),
  },
  payments: {
    about: "paying, buying, subscribing or moving money",
    pattern: anyOf(
      /payment|\bpay(ing)?\b|pay[-_ ]?now|checkout|purchase|billing/,
      /\bbuy\b|place[-_ ]?(your[-_ ]?)?order|order[-_ ]?now/,
      // From a word's start: "Notebook now in stock" books nothing.
      /(complete|confirm|submit)[-_ ]?(your[-_ ]?)?(order|purchase|booking)|\bbook[-_ ]?now/,
      /\bsubscri(be|ptions?)\b|upgrade[-_ ]?(your[-_ ]?)?(plan|account|subscription)/,
      /kaufen|bestellen|bezahlen|zahlung|abonnieren|überweis/,
      /(add|update|change|remove)[-_ ]?(a[-_ ]?)?card\b|name[-_ ]?on[-_ ]?card|card[-_ ]?(details|number)/,
      /(credit|debit)[-_ ]?card|\bcv[cv]\b|expir(y|ation)/,
      /karte[-_ ]?hinzufügen|kartennummer|prüfnummer|ablaufdatum/,
      // The send page, not every Send button: "Send message" sends a message.
      /\btransfers?\b|withdraw|send[-_ ]?money|\/send\b|donat(e|ion)/,
      /bank[-_ ]?account|\biban\b|routing[-_ ]?number/,
      // A wire of money, not a news wire: "Business Wire" is where press releases go out.
      /(?<!\b(business|news|press)[-_ ]?)\bwire\b/,
    ),
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
