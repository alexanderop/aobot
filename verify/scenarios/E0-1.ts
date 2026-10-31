import { assert, browser, waitFor } from "../browser.ts";

/** The mock model's scripted answer, streamed one word at a time (`verify/mock-model.ts`). */
const answer = "Hi there, nice to meet you!";

/** The words of `answer` the page shows right now. */
function wordsShown(): number {
  const text = browser("get", "text", "body");
  const words = answer.split(" ");
  let shown = 0;
  while (shown < words.length && text.includes(words.slice(0, shown + 1).join(" "))) shown++;
  return shown;
}

/** E0-1: send a message, watch the answer stream in word by word, reload, and see it kept. */
export default async function scenario(baseUrl: string): Promise<void> {
  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");
  const url = browser("get", "url");
  assert(/[?&]c=/.test(url), `the page keeps the conversation id in the URL (${url})`);

  browser("find", "placeholder", "Message Assistant", "fill", "Say hi in five words");
  browser("press", "Enter");

  await waitFor("my message to appear", 5_000, () =>
    browser("get", "text", "body").includes("Say hi in five words"),
  );

  const seen = new Set<number>();
  await waitFor("the whole answer", 20_000, () => {
    const shown = wordsShown();
    seen.add(shown);
    return shown === answer.split(" ").length;
  });

  const partial = [...seen].filter((count) => count > 0 && count < answer.split(" ").length);
  assert(partial.length >= 2, `the answer appeared word by word (saw ${[...seen].join(", ")})`);

  browser("reload");
  browser("wait", "--load", "networkidle");
  await waitFor("the conversation after reload", 10_000, () => {
    const text = browser("get", "text", "body");
    return text.includes("Say hi in five words") && text.includes(answer);
  });
  assert(browser("get", "url") === url, "the reload reopened the same conversation");
  assert(true, "the conversation is still there after a reload");
}
