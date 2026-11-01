import { Schema } from "effect";
import { ModelStep } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, evaluate, waitFor } from "../browser.ts";
import {
  answers,
  ask,
  auditRows,
  cardResult,
  failedCards,
  modelRequests,
  script,
} from "../chat.ts";

const ReasonDetail = Schema.fromJsonString(Schema.Struct({ reason: Schema.String }));

const refusal = "run did not run: it is not granted to researcher";

/** The Bots the sidebar shows, each as `name` with whether it is the one open. */
function sidebar() {
  return evaluate(
    Schema.Array(Schema.Struct({ name: Schema.String, open: Schema.Boolean })),
    `[...document.querySelectorAll('nav[aria-label="Bots"] a')].map((link) => ({ name: link.textContent, open: link.getAttribute("aria-current") === "page" }))`,
  );
}

/**
E2-1: Bots come from bots.yaml. Picked in the sidebar, Researcher (granted snapshot, navigate and click) is
asked to run ls. The gateway refuses it before anything runs, the transcript and the model both read the
refusal, and the audit has one `run · deny` saying `not granted to researcher` and no allow row.
*/
export default async function scenario(baseUrl: string): Promise<void> {
  await script([
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: "ls" } }] }),
    ModelStep.Say({ words: ["I", " may", " not", " run", " commands."] }),
  ]);

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");

  await waitFor("the sidebar to list the Bots", 30_000, () => sidebar().length > 0);
  assert(
    JSON.stringify(sidebar().map(({ name }) => name)) ===
      JSON.stringify(["Assistant", "Scribe", "Researcher", "Operator"]),
    `the sidebar lists the Bots in bots.yaml (${JSON.stringify(sidebar())})`,
  );
  assert(
    sidebar().find(({ open }) => open)?.name === "Assistant",
    "the first Bot in the file is open by default",
  );

  browser("find", "role", "link", "click", "--name", "Researcher");

  await waitFor("Researcher's conversation to open", 10_000, () =>
    browser("get", "url").includes("bot=researcher"),
  );
  assert(
    sidebar().find(({ open }) => open)?.name === "Researcher",
    "Researcher is the selected row",
  );

  await ask("Run ls in your workspace.", 0, "I may not run commands.", "Researcher");

  await waitFor("the run card to fail", 10_000, () => failedCards("run") === 1);
  assert(
    cardResult("run").includes(refusal),
    `the transcript shows the refusal (${cardResult("run")})`,
  );
  assert(
    (await modelRequests()).at(-1)?.includes(refusal) === true,
    "the model read why run did not run",
  );

  const rows = auditRows();
  assert(
    rows.length === 1 && rows[0]?.action === "run" && rows[0].decision === "deny",
    `the audit has one run · deny and no allow row (${JSON.stringify(rows)})`,
  );
  assert(
    Schema.decodeUnknownSync(ReasonDetail)(rows[0].detail).reason === "not granted to researcher",
    `run · deny says not granted to researcher (${rows[0].detail})`,
  );

  assert(answers()[0] === "I may not run commands.", "Researcher reported the refusal");
  assert(
    browser("get", "text", ".conversation__header") === "Researcher",
    "the header pill names Researcher",
  );

  const researchers = new URL(browser("get", "url"));

  browser("back");

  await waitFor("Back to return to Assistant", 10_000, () =>
    browser("get", "url").includes("bot=assistant"),
  );
  assert(sidebar().find(({ open }) => open)?.name === "Assistant", "Back selects Assistant again");
  await waitFor(
    "the header pill to name Assistant",
    10_000,
    () => browser("get", "text", ".conversation__header") === "Assistant",
  );

  const misnamed = new URL(researchers);
  misnamed.searchParams.set("bot", "assistant");
  browser("open", misnamed.href);

  await waitFor("a conversation opened with another Bot to follow its own", 10_000, () =>
    browser("get", "url").includes("bot=researcher"),
  );
  assert(
    new URL(browser("get", "url")).searchParams.get("c") === researchers.searchParams.get("c"),
    "the page follows Researcher's conversation to Researcher, not opening it as Assistant",
  );
  await waitFor(
    "the header pill to name Researcher again",
    10_000,
    () => browser("get", "text", ".conversation__header") === "Researcher",
  );
}
