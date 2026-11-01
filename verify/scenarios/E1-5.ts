import { ModelStep } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, waitFor } from "../browser.ts";
import {
  answers,
  auditRows,
  cardResult,
  doneCards,
  failedCards,
  modelRequests,
  script,
  send,
} from "../chat.ts";
import { centreColour, panelState, panelText } from "../screen.ts";
import { compose } from "../stack.ts";
import { traceSpans } from "../tempo.ts";

const linkPage = "http://fixture:8080/link";

/** Whether `colour` is the fixture link's blue, give or take the JPEG. */
function isLinkBlue(colour: string): boolean {
  const [red = 0, green = 0, blue = 0] = colour.split(",").map(Number);

  return blue > 150 && red < 80 && green < 110;
}

/** The names of the events on the spans named `name` in trace `traceId`, once Tempo has them. */
async function spanEvents(grafanaUrl: string, traceId: string, name: string) {
  let events: ReadonlyArray<string> = [];

  await waitFor(`${name} in Tempo`, 60_000, async () => {
    const spans = await traceSpans(grafanaUrl, traceId).catch(() => []);

    events = spans
      .filter((span) => span.name === name)
      .flatMap((span) => (span.events ?? []).map((event) => event.name));

    return events.length > 0;
  });

  return events;
}

/**
E1-5: with the Bot's page open and the chat idle, the person takes control from the folded panel. The Bot,
asked to navigate, is refused and says so; the person clicks the link on the screen themselves, hands
back, and the Bot reads the page the person left it on. The take, the refusal and the hand back are
audited in that order, and each is an event on its span. A person who still holds the computer when the
server restarts keeps it, and starts a fresh computer from the panel.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  await script([
    ModelStep.CallTools({ calls: [{ name: "navigate", params: { url: linkPage } }] }),
    ModelStep.Say({ words: ["The", " page", " is", " open."] }),
  ]);

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");
  // The rail's button slides while the panel folds, and a click mid-slide lands beside it. Reduced
  // motion folds it at once, as for a person who prefers that.
  browser("set", "media", "dark", "reduced-motion");

  send("Open the link page.");
  await waitFor("the first answer", 60_000, () => answers()[0] === "The page is open.");
  await waitFor("the panel to fold once the Bot is done", 5_000, () => panelState() === "folded");

  browser("find", "role", "button", "click", "--name", "Take control");

  await waitFor("the person to hold the computer", 15_000, () =>
    panelText().includes("You have control"),
  );
  assert(panelState() === "open", "the panel opens while the person holds the computer");

  await script([
    ModelStep.CallTools({
      calls: [{ name: "navigate", params: { url: "http://fixture:8080/injection" } }],
    }),
    ModelStep.Say({ words: ["A", " person", " has", " control,", " so", " I", " will", " wait."] }),
  ]);

  send("Open the opening hours.");
  await waitFor(
    "the second answer",
    60_000,
    () => answers()[1] === "A person has control, so I will wait.",
  );
  assert(failedCards("navigate") === 1, "the Bot's navigate is drawn as failed");

  const told = (await modelRequests()).at(-1) ?? "";

  assert(
    told.includes("navigate did not run: a person has control of your computer."),
    "the model was told its navigate did not run because a person has control",
  );
  assert(
    panelState() === "open",
    "the panel stays open after the Bot's turn, the person still holds it",
  );

  await waitFor("the screen to show the link", 15_000, () => isLinkBlue(centreColour()));
  browser("click", ".live-screen__frame");
  await waitFor("the person's click to follow the link", 15_000, () => {
    const colour = centreColour();

    return colour !== "none" && !isLinkBlue(colour);
  });
  assert(!isLinkBlue(centreColour()), "the person's click on the screen followed the link");

  browser("find", "role", "button", "click", "--name", "Hand back");
  await waitFor(
    "the panel to fold once the Bot holds its computer",
    15_000,
    () => panelState() === "folded",
  );

  await script([
    ModelStep.CallTools({ calls: [{ name: "snapshot", params: {} }] }),
    ModelStep.Say({ words: ["I", " am", " on", " Followed."] }),
  ]);

  send("Go on.");
  await waitFor("the third answer", 60_000, () => answers()[2] === "I am on Followed.");
  assert(doneCards("snapshot") === 1, "the Bot continues: its snapshot is done");
  assert(
    cardResult("snapshot").includes("Title: Followed"),
    "the Bot reads the page the person left it on",
  );

  const rows = auditRows();
  const trail = rows.map((row) => `${row.action} · ${row.decision}`);

  assert(
    trail.join(", ") ===
      [
        "navigate · allow",
        "navigate · succeeded",
        "control_taken · allow",
        "control_taken · succeeded",
        "navigate · deny",
        "control_released · allow",
        "control_released · succeeded",
        "snapshot · allow",
        "snapshot · succeeded",
      ].join(", "),
    `the take, the refused call and the hand back are audited in order (${trail.join(", ")})`,
  );

  const traceOf = (action: string, decision: string) =>
    rows.find((row) => row.action === action && row.decision === decision)?.trace_id ?? "";

  const taken = await spanEvents(
    grafanaUrl,
    traceOf("control_taken", "allow"),
    "ComputerControl.take",
  );

  assert(
    taken.join(",") === "control.door_closed,control.taken",
    `taking control is two events on its span (${taken.join(",")})`,
  );

  const refused = await spanEvents(grafanaUrl, traceOf("navigate", "deny"), "Gateway.act");
  assert(
    refused.includes("control.refused"),
    `the refusal is an event on Gateway.act (${refused.join(",")})`,
  );

  const released = await spanEvents(
    grafanaUrl,
    traceOf("control_released", "allow"),
    "ComputerControl.handBack",
  );

  assert(
    released.join(",") === "control.released",
    `handing back is an event on its span (${released.join(",")})`,
  );

  browser("find", "role", "button", "click", "--name", "Take control");
  await waitFor("the person to hold the computer again", 15_000, () =>
    panelText().includes("You have control"),
  );

  compose("up", "--detach", "--wait", "--no-deps", "--force-recreate", "server");
  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");

  await waitFor(
    "the restarted server to show the person holding a computer that runs no more",
    30_000,
    () => panelText().includes("the computer is not showing a page"),
  );
  assert(panelState() === "open", "the panel opens on a computer the person holds after a restart");

  browser("find", "role", "button", "click", "--name", "Start the computer");
  await waitFor("a fresh computer to show a page", 120_000, () => centreColour() !== "none");
  assert(
    panelText().includes("You have control. The Bot waits"),
    "the person holds a computer that shows a page again",
  );

  browser("find", "role", "button", "click", "--name", "Hand back");
  await waitFor(
    "the panel to fold once the Bot holds it again",
    15_000,
    () => panelState() === "folded",
  );
}
