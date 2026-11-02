import { filledFields } from "@aobot/domain";
import { Effect } from "effect";
import type { Locator, Page } from "playwright";

/** The attribute a field gets once a person's secret is typed into it. */
const secretAttribute = "data-aobot-secret";

/**
Every field whose value no read of the page shows. Playwright's snapshot prints what a field holds, a
password field's included (`textbox "Password" [ref=e6]: hunter2`), so a password, a one-time code, and
any field a person's secret was typed into are hidden by what they are, not by how the page draws them.
*/
const sensitiveFields = [
  "input[type=password]",
  'input[autocomplete~="one-time-code"]',
  'input[autocomplete~="current-password"]',
  'input[autocomplete~="new-password"]',
  `[${secretAttribute}]`,
].join(", ");

/**
The little of a page's element the functions below use there. The computer is built without the DOM's
types, and Playwright hands a page function the element itself, which has all of these.
*/
interface PageField {
  matches(selector: string): boolean;
  setAttribute(name: string, value: string): void;
  readonly style: { setProperty(name: string, value: string, priority: string): void };
}

/**
The fields a secret may be typed into: a `<textarea>`, or an `<input>` that takes text. What a
contenteditable element holds is page text, which no read hides, and a button, checkbox or file input
takes no text at all.
*/
const secretInputs = [
  "textarea",
  "input:not([type])",
  ...["text", "password", "email", "search", "tel", "url", "number"].map(
    (type) => `input[type=${type} i]`,
  ),
].join(", ");

/** Whether `field` is one a secret may be typed into, as {@link secretInputs} says. */
export function takesSecret(field: Locator): Promise<boolean> {
  return field.evaluate(
    // SAFETY: Playwright hands a page function the field itself, see PageField.
    (element, selector) => (element as PageField).matches(selector),
    secretInputs,
    { timeout: markTimeoutMs },
  );
}

/** How long the page may take to say whether one field is sensitive. */
const askTimeoutMs = 1_000;

/** How long marking a field may wait for it. */
const markTimeoutMs = 5_000;

/**
The refs of the filled fields in `tree` whose value must not be shown, asked of the page itself. A field
the page does not answer for is hidden too: hiding an ordinary value costs little, and showing a
password does not.
*/
export const sensitiveRefs = Effect.fn("Browser.sensitiveRefs")(function* (
  page: Page,
  tree: string,
) {
  const hidden = yield* Effect.forEach(
    filledFields(tree),
    ({ ref }) =>
      Effect.promise(() =>
        page
          .locator(`aria-ref=${ref}`)
          .evaluate(
            // SAFETY: Playwright hands a page function the field itself, see PageField.
            (field, selector) => (field as PageField).matches(selector),
            sensitiveFields,
            { timeout: askTimeoutMs },
          )
          .catch(() => true),
      ).pipe(Effect.map((sensitive) => (sensitive ? [ref] : []))),
    { concurrency: "unbounded" },
  );

  return new Set(hidden.flat());
});

/**
Marks `field` as holding a secret, before the secret is typed, so every later read of the page hides its
value, and the live screen draws it as dots even where it is no password field.
*/
export function markSecret(field: Locator): Promise<void> {
  return field.evaluate(
    (element, attribute) => {
      // SAFETY: Playwright hands a page function the field itself, see PageField.
      const field = element as PageField;
      field.setAttribute(attribute, "");
      field.style.setProperty("-webkit-text-security", "disc", "important");
    },
    secretAttribute,
    { timeout: markTimeoutMs },
  );
}
