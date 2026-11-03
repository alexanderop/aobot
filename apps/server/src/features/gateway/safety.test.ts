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
  ] as const)("hands off an action that %s", (_case, action, path, list) => {
    expect(safetyOf(action, path)).toEqual(Option.some(list));
  });

  it.each([
    ["types a search for a password manager", type("searchbox", "Search", "password manager"), "/"],
    ["reads an order", click("link", "Order #1234"), "/orders"],
    ["signs in", click("button", "Sign in"), "/login"],
    ["types a username", type("textbox", "Username", "ada"), "/login"],
    ["opens a press release on Business Wire", click("link", "Business Wire"), "/news"],
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
