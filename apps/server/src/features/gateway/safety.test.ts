import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { safetyOf } from "./safety.ts";
import type { ToolAction } from "./tool-action.ts";

const on = (role: string, name: string, origin = "https://shop.example") => ({
  ref: "e1",
  role,
  name,
  url: origin,
});

const click = (role: string, name: string, origin?: string): ToolAction => ({
  action: "click",
  target: on(role, name, origin),
});

const type = (role: string, name: string, text: string): ToolAction => ({
  action: "type",
  target: on(role, name),
  text,
});

describe("safetyOf", () => {
  it.each([
    ["clicks Change password", click("button", "Change password"), "/account", "credentials"],
    ["types a new password", type("textbox", "New password", "s3cret!"), "/account", "credentials"],
    [
      "presses Enter to confirm a password",
      { action: "press", target: on("textbox", "Confirm password"), key: "Enter" },
      "/account",
      "credentials",
    ],
    [
      "turns on two-factor sign-in",
      click("button", "Enable two-factor authentication"),
      "/settings",
      "security",
    ],
    ["makes an API key", click("button", "Generate API key"), "/developers", "security"],
    ["saves the security settings page", click("button", "Save"), "/settings/security", "security"],
    ["types a card number", type("textbox", "Card number", "4242"), "/checkout", "payments"],
    ["adds a card", click("button", "Add card"), "/wallet", "payments"],
    ["buys now", click("button", "Buy now"), "/products/42", "payments"],
    ["continues on the checkout page", click("button", "Continue"), "/checkout", "payments"],
    ["sends a wire", click("button", "Send wire"), "/transfers", "payments"],
    [
      "types a verification code",
      type("textbox", "Verification code", "123456"),
      "/verify",
      "credentials",
    ],
    ["types a PIN", type("textbox", "PIN", "1234"), "/card", "credentials"],
    ["changes a password in German", click("button", "Passwort ändern"), "/konto", "credentials"],
    [
      "types a new password in German",
      type("textbox", "Neues Passwort", "s3cret!"),
      "/konto",
      "credentials",
    ],
    [
      "changes a password by its other German name",
      click("button", "Kennwort ändern"),
      "/konto",
      "credentials",
    ],
    ["adds a passkey", click("button", "Add a passkey"), "/account", "security"],
    ["creates a passkey", click("button", "Create passkey"), "/security-keys", "security"],
    [
      "turns on 2-Step Verification",
      click("button", "Turn on 2-Step Verification", "https://myaccount.google.com"),
      "/signinoptions",
      "security",
    ],
    [
      "generates a token on the tokens page",
      click("button", "Generate token", "https://github.com"),
      "/settings/tokens",
      "security",
    ],
    [
      "adds an SSH key",
      click("button", "Add SSH key", "https://github.com"),
      "/settings/ssh/new",
      "security",
    ],
    [
      "sets up an authenticator app",
      click("button", "Set up authenticator app"),
      "/account",
      "security",
    ],
    ["revokes all sessions", click("button", "Revoke all sessions"), "/account", "security"],
    ["changes the account's email", click("button", "Change email"), "/account", "security"],
    ["makes someone an admin", click("button", "Make admin"), "/team", "security"],
    ["buys", click("button", "Buy"), "/item/1", "payments"],
    ["buys at a price", click("button", "Buy for $9.99"), "/app/1", "payments"],
    ["buys with 1-Click", click("button", "Buy with 1-Click"), "/dp/B0", "payments"],
    [
      "places an Amazon order",
      click("button", "Place your order", "https://www.amazon.com"),
      "/gp/buy/spc/handlers/display.html",
      "payments",
    ],
    ["orders now", click("button", "Order now"), "/p/1", "payments"],
    ["subscribes", click("button", "Subscribe"), "/plans", "payments"],
    ["upgrades a plan", click("button", "Upgrade plan"), "/plans", "payments"],
    ["transfers", click("button", "Transfer"), "/accounts", "payments"],
    ["confirms a transfer", click("button", "Confirm transfer"), "/accounts", "payments"],
    ["withdraws", click("button", "Withdraw"), "/wallet", "payments"],
    ["donates", click("button", "Donate"), "/give", "payments"],
    ["adds a bank account", click("button", "Add bank account"), "/payouts", "payments"],
    ["updates a card", click("button", "Update card"), "/account", "payments"],
    ["types the name on a card", type("textbox", "Name on card", "Ada Lovelace"), "/x", "payments"],
    ["buys now in German", click("button", "Jetzt kaufen"), "/p/1", "payments"],
    [
      "orders with a duty to pay in German",
      click("button", "Zahlungspflichtig bestellen"),
      "/kasse",
      "payments",
    ],
    ["pays now in German", click("button", "Jetzt bezahlen"), "/kasse", "payments"],
    ["types a security code", type("textbox", "Security code", "123"), "/verify", "credentials"],
    [
      "types a card security code",
      type("textbox", "Card security code", "123"),
      "/checkout",
      "credentials",
    ],
    [
      "types a code it is asked to enter",
      type("textbox", "Enter code", "123456"),
      "/verify",
      "credentials",
    ],
    [
      "types the 6-digit code it is asked for",
      type("textbox", "Enter the 6-digit code", "123456"),
      "/login/challenge",
      "credentials",
    ],
    ["invites a member", click("button", "Invite member"), "/team", "security"],
    ["adds a collaborator", click("button", "Add collaborator"), "/settings/access", "security"],
    ["adds people to a document", click("button", "Add people"), "/document/d/1", "security"],
    [
      "changes someone's role to Owner",
      click("menuitem", "Change role to Owner"),
      "/team",
      "security",
    ],
    ["promotes someone to owner", click("menuitem", "Promote to owner"), "/team", "security"],
    ["transfers ownership", click("button", "Transfer ownership"), "/settings", "security"],
    [
      "authorizes an application",
      click("button", "Authorize application", "https://github.com"),
      "/login/oauth/authorize",
      "security",
    ],
    ["allows access", click("button", "Allow access"), "/oauth/consent", "security"],
    ["grants access", click("button", "Grant access"), "/share", "security"],
    ["opens the connected apps", click("link", "Connected apps"), "/settings", "security"],
    [
      "deactivates the account",
      click("button", "Deactivate account"),
      "/settings/account",
      "security",
    ],
    [
      "turns on two-factor sign-in in German",
      click("button", "Zwei-Faktor-Authentifizierung aktivieren"),
      "/konto",
      "security",
    ],
    ["deletes the account in German", click("button", "Konto löschen"), "/konto", "security"],
    [
      "changes the account's email in German",
      click("button", "E-Mail-Adresse ändern"),
      "/konto",
      "security",
    ],
    ["sends on the send page", click("button", "Send"), "/send", "payments"],
    ["types a card's expiry date", type("textbox", "Expiry date", "12/29"), "/wallet", "payments"],
    [
      "types a card's expiration",
      type("textbox", "Expiration (MM/YY)", "12/29"),
      "/wallet",
      "payments",
    ],
    ["completes an order", click("button", "Complete order"), "/cart", "payments"],
    ["confirms an order", click("button", "Confirm order"), "/cart", "payments"],
    ["submits an order", click("button", "Submit order"), "/cart", "payments"],
    ["books now", click("button", "Book now"), "/hotels/1", "payments"],
    ["subscribes in German", click("button", "Abonnieren"), "/kanal", "payments"],
    [
      "makes a transfer in German",
      click("button", "Überweisung ausführen"),
      "/banking",
      "payments",
    ],
    ["adds a card in German", click("button", "Karte hinzufügen"), "/wallet", "payments"],
    [
      "adds a credit card in German",
      click("button", "Kreditkarte hinzufügen"),
      "/wallet",
      "payments",
    ],
    [
      "types a card number in German",
      type("textbox", "Kartennummer", "4242"),
      "/wallet",
      "payments",
    ],
    [
      "types a card's check digits in German",
      type("textbox", "Kartenprüfnummer", "123"),
      "/wallet",
      "payments",
    ],
    [
      "types a card's expiry date in German",
      type("textbox", "Ablaufdatum", "12/29"),
      "/wallet",
      "payments",
    ],
    [
      "types a full-width password",
      type("textbox", "Ｐａｓｓｗｏｒｄ", "s3cret!"),
      "/account",
      "credentials",
    ],
    [
      "turns on two-factor sign-in spelt with a non-breaking hyphen",
      click("button", "Enable two\u2011factor authentication"),
      "/settings",
      "security",
    ],
    [
      "changes a password split by a soft hyphen",
      click("button", "Change Pass\u00ADword"),
      "/account",
      "credentials",
    ],
    [
      "continues on a percent-encoded transfer page",
      click("button", "Weiter"),
      "/%C3%BCberweisung",
      "payments",
    ],
    [
      "types a password split by a zero-width space",
      type("textbox", "Pass\u200Bword", "s3cret!"),
      "/account",
      "credentials",
    ],
    [
      "continues on a checkout page whose path has a malformed escape",
      click("button", "Weiter"),
      "/checkout/%E0%A4%A",
      "payments",
    ],
  ] as const)("hands off an action that %s", (_case, action, path, list) => {
    expect(safetyOf(action, path)).toEqual(Option.some(list));
  });

  it.each([
    ["types a search for a password manager", type("searchbox", "Search", "password manager"), "/"],
    ["reads an order", click("link", "Order #1234"), "/orders"],
    ["signs in", click("button", "Sign in"), "/login"],
    ["types a username", type("textbox", "Username", "ada"), "/login"],
    ["opens a press release on Business Wire", click("link", "Business Wire"), "/news"],
    ["opens gift ideas", click("link", "Gift ideas"), "/"],
    ["sends a message", click("button", "Send message"), "/chat"],
    ["opens a compass", click("link", "Compass"), "/tools"],
    ["uploads a file", click("button", "Upload file"), "/files"],
    ["opens card games", click("link", "Card games"), "/games"],
    ["opens the pinned messages", click("button", "Pinned"), "/chat"],
    ["pins a message", click("button", "Pin"), "/chat"],
    ["searches on a Pinterest pin", type("searchbox", "Search", "red shoes"), "/pin/42"],
    ["types a cost center code", type("textbox", "Cost center code", "4711"), "/expenses"],
    ["opens the invitations", click("link", "Invitations"), "/"],
    ["opens the authorized dealers", click("link", "Authorized dealers"), "/"],
    ["clicks a button that says Allowed", click("button", "Allowed"), "/"],
    ["opens book reviews", click("link", "Book reviews"), "/"],
    ["opens a notebook in stock", click("link", "Notebook now in stock"), "/"],
    ["opens expired posts", click("link", "Expired posts"), "/"],
  ] as const)("leaves an action that %s to the rules", (_case, action, path) => {
    expect(safetyOf(action, path)).toEqual(Option.none());
  });

  it.each([
    ["opens a checkout page", { action: "navigate", url: "https://shop.example/checkout" }],
    ["reads the page", { action: "snapshot" }],
    ["runs a command naming a password", { action: "run", command: "cat password.txt" }],
    ["reads a file of payments", { action: "read_file", path: "payments.csv" }],
    [
      "writes a file of payments",
      { action: "write_file", path: "payments.csv", contents: "card number,4242" },
    ],
    ["lists the billing folder", { action: "list_files", path: "billing" }],
    [
      "asks its person for a password",
      {
        action: "request_secret",
        target: on("textbox", "Password"),
        field: "the password for shop.example",
      },
    ],
  ] as const)("never hands off an action that %s", (_case, action) => {
    expect(safetyOf(action, "/account/password")).toEqual(Option.none());
  });

  it("reads the element and the page, never what the Bot typed", () => {
    expect(
      safetyOf(type("textbox", "Note", "Pay the invoice by card number 4242"), "/crm"),
    ).toEqual(Option.none());
  });
});
