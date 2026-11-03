import { Schema } from "effect";
import { signInRefusalWords } from "../../packages/domain/src/people.ts";
import { ModelStep } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, evaluate, waitFor } from "../browser.ts";
import { ask, everyAuditRow, script } from "../chat.ts";
import { onSignInScreen, signIn, signInAs } from "../sign-in.ts";
import { composeOutput } from "../stack.ts";
import { attribute, traceSpans } from "../tempo.ts";

/** This scenario signs in itself: it starts signed out. */
export const signedIn = false;

const page = "http://fixture:8080/link";

/** How many people rows the server's database holds for `email`. */
function peopleRowsOf(email: string): number {
  const read = `const { DatabaseSync } = require("node:sqlite");
const [{ n }] = new DatabaseSync("/data/aobot.db")
  .prepare("SELECT count(*) AS n FROM people WHERE email = ?").all(process.argv[1]);
console.log(n);`;

  return Number(composeOutput("exec", "-T", "server", "node", "-e", read, email));
}

/** The status the server answers for `path` to a request with no cookie, as from a script, not a page. */
async function statusWithoutSession(baseUrl: string, path: string): Promise<number> {
  return (await fetch(`${baseUrl}${path}`, { redirect: "manual" })).status;
}

/** The status the page's own fetch of `path` gets, with whatever cookie the browser holds. */
function statusFromPage(path: string): number {
  return evaluate(Schema.Number, `fetch(${JSON.stringify(path)}).then((r) => r.status)`);
}

const ShownRows = Schema.Array(Schema.Struct({ person: Schema.String, shown: Schema.String }));

/** Every row the audit page shows: its person, and its action and decision in words. */
function shownRows() {
  return evaluate(
    ShownRows,
    `[...document.querySelectorAll(".audit__row")].map((row) => ({
      person: row.cells[2].textContent,
      shown: row.cells[3].textContent + " · " + row.cells[4].textContent,
    }))`,
  );
}

/**
E3-1: the page opens signed out and asks to sign in, opening no RPC socket, and the server refuses
whatever is asked of it without a session. mallory@other.com signs in at Dex and is refused before she is
recorded. alice@example.com signs in, the Bot opens a page for her, and its rows, the audit page filtered
to her and the turn's Chat.turn span all name her. Signing out shows the sign-in screen again and the
server refuses the page.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  browser("open", baseUrl);
  await waitFor("the sign-in screen", 15_000, onSignInScreen);
  assert(
    evaluate(
      Schema.Number,
      "performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/rpc')).length",
    ) === 0,
    "the signed-out page opened no RPC socket",
  );

  for (const path of ["/audit/rows", "/files?path=notes.txt", "/auth/session"]) {
    const status = await statusWithoutSession(baseUrl, path);
    const open = path === "/auth/session";

    assert(
      open ? status === 200 : status === 401,
      `without a session ${path} answers ${open ? 200 : 401} (${status})`,
    );
  }

  await signIn(baseUrl, "mallory@other.com");
  await waitFor("mallory to be refused", 15_000, () =>
    browser("get", "text", "body").includes(signInRefusalWords.domain),
  );
  assert(onSignInScreen(), "mallory is back on the sign-in screen, told why");
  assert(peopleRowsOf("mallory@other.com") === 0, "mallory was refused before she was recorded");

  await signInAs(baseUrl, "alice@example.com");
  assert(peopleRowsOf("alice@example.com") === 1, "alice is recorded once she signed in");

  await script([
    ModelStep.CallTools({ calls: [{ name: "navigate", params: { url: page } }] }),
    ModelStep.Say({ words: ["I", " opened", " it."] }),
  ]);
  await ask(`Open ${page}`, 0, "I opened it.");

  const rows = everyAuditRow();

  const row = (action: string, decision: string) =>
    rows.find((candidate) => candidate.action === action && candidate.decision === decision);

  const navigated = row("navigate", "allow");

  assert(
    navigated?.actor_id === "alice@example.com" &&
      row("navigate", "succeeded")?.actor_id === "alice@example.com",
    `the Bot's navigate is alice's in the audit trail (${JSON.stringify(navigated)})`,
  );
  assert(
    row("auth.signed_in", "allow")?.actor_id === "alice@example.com" &&
      row("auth.admin_granted", "allow")?.actor_id === "alice@example.com",
    "signing alice in, and making her an admin by configuration, are in the trail",
  );
  assert(
    row("auth.refused", "deny")?.actor_id === "mallory@other.com",
    "mallory's refused sign-in is in the trail under her address",
  );

  const traceId = navigated?.trace_id ?? "";
  let turnActor: string | undefined;
  await waitFor("the turn's Chat.turn span in Tempo", 30_000, async () => {
    const spans = await traceSpans(grafanaUrl, traceId).catch(() => []);
    const turn = spans.find((span) => span.name === "Chat.turn");
    turnActor = turn === undefined ? undefined : attribute(turn, "actor.id");

    return turn !== undefined;
  });
  assert(turnActor === "alice@example.com", `the turn's Chat.turn says actor.id ${turnActor}`);

  browser("open", `${baseUrl}/audit?person=${encodeURIComponent("alice@example.com")}`);
  await waitFor("the audit page filtered to alice", 30_000, () =>
    shownRows().some(({ shown }) => shown === "Open a page · Allowed"),
  );
  const shown = shownRows();
  assert(
    shown.every(({ person }) => person.startsWith("alice@example.com")) &&
      shown.some(({ shown: words }) => words === "Sign in · Allowed"),
    `the audit page filtered to alice shows only hers, her navigate and her sign-in among them (${JSON.stringify(shown)})`,
  );

  browser("open", baseUrl);
  await waitFor("the person bar", 15_000, () => browser("get", "count", ".person-bar") !== "0");
  browser("find", "role", "button", "click", "--name", "Sign out");
  await waitFor("the sign-in screen after signing out", 15_000, onSignInScreen);
  assert(statusFromPage("/audit/rows") === 401, "after signing out the server refuses the page");
}
