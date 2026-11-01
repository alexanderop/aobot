import { execFileSync } from "node:child_process";
import { Schema } from "effect";
import { ModelStep } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, evaluate, waitFor } from "../browser.ts";
import { answers, auditRows, doneCards, script, send } from "../chat.ts";
import { frameColours, panelState } from "../screen.ts";
import { computerContainer } from "../stack.ts";

/** Every WebSocket the page opens from now on, recorded by URL. */
function recordSockets(): void {
  browser(
    "eval",
    `(() => {
      window.openedSockets = [];
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url, protocols) {
          super(url, protocols);
          window.openedSockets.push(String(url));
        }
      };
    })()`,
  );
}

/** The computer's token, as Docker gave it to the container the server started. */
function computerToken(): string {
  const env = execFileSync(
    "docker",
    ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", computerContainer],
    { encoding: "utf8" },
  );

  return (
    env
      .split("\n")
      .find((line) => line.startsWith("COMPUTER_TOKEN="))
      ?.slice("COMPUTER_TOKEN=".length) ?? ""
  );
}

/**
E1-4: while the Bot opens example.com and keeps working, the panel beside the chat shows the page, drawn
from frames that came over the page's own socket to the server, and the computer's token is nowhere on the
page. When the turn ends, the panel folds away. Watching is not audited.
*/
export default async function scenario(baseUrl: string): Promise<void> {
  const keepsTheTurnRunning = ModelStep.CallTools({
    calls: [{ name: "run", params: { command: "sleep 8" } }],
  });

  await script([
    ModelStep.CallTools({ calls: [{ name: "navigate", params: { url: "https://example.com" } }] }),
    keepsTheTurnRunning,
    ModelStep.Say({ words: ["Done", "."] }),
  ]);

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");

  await waitFor("the panel to be drawn", 10_000, () => panelState() !== "none");
  assert(panelState() === "folded", "the panel is folded before the Bot works");

  recordSockets();
  send("Open example.com and keep working on it.");

  await waitFor("the navigate card to be done", 60_000, () => doneCards("navigate") === 1);
  assert(panelState() === "open", "the panel is open while the Bot works");

  await waitFor("the screen to show a page, not a blank one", 15_000, () => frameColours() > 1);

  const sockets = evaluate(Schema.Array(Schema.String), "window.openedSockets");

  assert(
    sockets.length > 0 && sockets.every((url) => url === `${baseUrl.replace(/^http/u, "ws")}/rpc`),
    `the screen came over the page's own /rpc socket and nothing else (${sockets.join(", ")})`,
  );

  const token = computerToken();
  const page = evaluate(Schema.String, "document.documentElement.outerHTML");

  assert(token !== "" && !page.includes(token), "the computer's token is nowhere on the page");

  await waitFor("the answer", 60_000, () => answers()[0] === "Done.");
  await waitFor("the panel to fold once the Bot is done", 5_000, () => panelState() === "folded");

  const allowed = auditRows()
    .filter((row) => row.decision === "allow")
    .map((row) => row.action);

  assert(
    allowed.join(",") === "navigate,run",
    `only the Bot's two actions are audited, not the watching (${allowed.join(",")})`,
  );
}
