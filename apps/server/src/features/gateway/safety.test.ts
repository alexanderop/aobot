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
