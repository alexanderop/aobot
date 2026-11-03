import { Schema } from "effect";
import { ModelStep } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, evaluate, waitFor } from "../browser.ts";
import { answers, ask, modelRequests, script, send } from "../chat.ts";
import { onSignInScreen, signInAs } from "../sign-in.ts";

const Rows = Schema.Array(
  Schema.Struct({ conversation: Schema.String, preview: Schema.String, unread: Schema.Boolean }),
);

/** Every conversation the sidebar lists: its id, as its link names it, its preview, and its dot. */
function listed() {
  return evaluate(
    Rows,
    `[...document.querySelectorAll(".conversation-list__row")].map((row) => ({
      conversation: new URL(row.href).searchParams.get("c"),
      preview: row.querySelector(".conversation-list__preview").textContent,
      unread: row.querySelector(".conversation-list__unread") !== null,
    }))`,
  );
}

/** Whether the sidebar says the person has no conversation. */
function noConversations(): boolean {
  return browser("get", "count", ".conversation-list__empty") !== "0";
}

/** The conversation the page has open, as its URL names it. */
function openConversation(): string {
  return new URL(browser("get", "url")).searchParams.get("c") ?? "";
}

/** Clicks the sidebar's row of `conversation` and waits until the page has it open. */
async function openFromSidebar(conversation: string): Promise<void> {
  browser("click", `.conversation-list__row[href*="c=${conversation}"]`);
  await waitFor(
    `conversation ${conversation} to open`,
    10_000,
    () => openConversation() === conversation,
  );
}

/** Waits until the open conversation's turn has ended, so its composer takes a message again. */
async function turnEnded(): Promise<void> {
  await waitFor(
    "the turn to end",
    30_000,
    () => browser("get", "count", '[aria-label="Stop"]') === "0",
  );
}

/** Says `words` a word at a time as the Bot's next answer. */
const saying = (words: string) => script([ModelStep.Say({ words: words.split(/(?= )/u) })]);

async function signOutAndInAs(baseUrl: string, email: string): Promise<void> {
  browser("find", "role", "button", "click", "--name", "Sign out");
  await waitFor("the sign-in screen", 15_000, onSignInScreen);
  await signInAs(baseUrl, email);
}

/**
E3-2: alice starts two conversations with Assistant from the sidebar's New, and each is listed with
its last message. bob signs in on the same browser and sees no conversation, and opening alice's by its
address shows him a new one with none of her messages. alice signs in again, opens her first
conversation from the sidebar and continues it: the model is sent that conversation's earlier messages
and not the other's, and the Bot answers from them. An answer that arrives while she reads her other
conversation leaves a dot on the first until she opens it.
*/
export default async function scenario(baseUrl: string): Promise<void> {
  browser("open", baseUrl);
  await waitFor("the conversation list", 15_000, () => noConversations());

  await saying("Noted: the code word is falcon.");
  await ask("Remember the code word falcon.", 0, "Noted: the code word is falcon.");
  const first = openConversation();
  await turnEnded();

  browser("find", "role", "button", "click", "--name", "New conversation with Assistant");
  await waitFor("a new conversation", 10_000, () => openConversation() !== first);
  const second = openConversation();
  await saying("Lunch is at noon.");
  await ask("When is lunch?", 0, "Lunch is at noon.");

  await turnEnded();

  const both = JSON.stringify([
    { conversation: second, preview: "Lunch is at noon.", unread: false },
    { conversation: first, preview: "Noted: the code word is falcon.", unread: false },
  ]);

  await waitFor(
    `both conversations in the sidebar (${both})`,
    10_000,
    () => JSON.stringify(listed()) === both,
  );
  assert(
    JSON.stringify(listed()) === both,
    "alice's two conversations are listed newest first with their last message, read",
  );

  await signOutAndInAs(baseUrl, "bob@example.com");
  await waitFor("bob's conversation list", 15_000, () => noConversations());
  assert(listed().length === 0, "bob sees none of alice's conversations");

  browser("open", `${baseUrl}/?bot=assistant&c=${first}`);
  await waitFor("bob's page to leave alice's conversation", 15_000, () => {
    const now = openConversation();

    return now !== "" && now !== first;
  });
  await waitFor(
    "the composer",
    10_000,
    () => browser("get", "count", '[placeholder="Message Assistant"]') !== "0",
  );
  assert(
    !browser("get", "text", "body").includes("falcon") &&
      browser("get", "count", ".bubble") === "0",
    "alice's address shows bob a new conversation with none of her messages",
  );

  await signOutAndInAs(baseUrl, "alice@example.com");
  browser("reload");
  await waitFor("alice's conversations after a reload", 15_000, () => listed().length === 2);
  await openFromSidebar(first);
  await waitFor("the first conversation's messages", 10_000, () =>
    answers().includes("Noted: the code word is falcon."),
  );

  await saying("The code word is falcon.");
  await ask("What was the code word?", 1, "The code word is falcon.");

  const [request] = await modelRequests();
  assert(
    request !== undefined &&
      request.includes("Remember the code word falcon.") &&
      request.includes("Noted: the code word is falcon.") &&
      !request.includes("When is lunch?"),
    "the model was sent the first conversation's earlier messages, and not the other's",
  );

  await turnEnded();
  await saying("Here is a long answer that takes a while to arrive in full.");
  send("Tell me something long.");
  await waitFor("the answer to start", 15_000, () => answers().length === 3);
  await openFromSidebar(second);
  await waitFor("a dot on the first conversation once its answer arrived", 30_000, () =>
    listed().some((row) => row.conversation === first && row.unread),
  );
  assert(
    listed().find((row) => row.conversation === first)?.preview ===
      "Here is a long answer that takes a while to arrive in full.",
    "the first conversation's preview is the answer that arrived while alice was away",
  );

  await openFromSidebar(first);
  await waitFor("the dot to clear once alice opened it", 10_000, () =>
    listed().every((row) => !row.unread),
  );
  assert(
    answers().at(-1) === "Here is a long answer that takes a while to arrive in full.",
    "opening the first conversation shows the answer that arrived, and clears its dot",
  );
}
