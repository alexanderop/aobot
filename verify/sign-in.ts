import { browser, waitFor } from "./browser.ts";

/** The password of every person the verify stack's Dex knows (`dex/config.yaml`). */
const dexPassword = "password";

/** Whether the page shows the sign-in screen. */
export function onSignInScreen(): boolean {
  return browser("get", "count", ".sign-in__button") !== "0";
}

/**
Signs in at `baseUrl` as `email` the way a person does: Sign in with your company account, then Dex's
login form. Returns once the browser is back at the app, signed in or refused.
*/
export async function signIn(baseUrl: string, email: string): Promise<void> {
  browser("open", baseUrl);
  await waitFor("the sign-in screen", 15_000, onSignInScreen);
  browser("click", ".sign-in__button");

  await waitFor("Dex's login form", 15_000, () => browser("get", "count", "#login") !== "0");
  browser("fill", "#login", email);
  browser("fill", "#password", dexPassword);
  browser("click", "#submit-login");

  await waitFor("the way back to the app", 20_000, () => browser("get", "url").startsWith(baseUrl));

  // After the redirects through Dex's origin, agent-browser's clicks and key presses no longer reach
  // the page in that tab, though scripts on it still run. A new tab of the same browser keeps the
  // session cookie and takes input again.
  const throughDex = currentTab();
  browser("tab", "new", browser("get", "url"));
  browser("tab", "close", throughDex);
}

/** The id of the tab agent-browser acts on, such as `t1`. */
function currentTab(): string {
  const current = browser("tab", "list")
    .split("\n")
    .find((line) => line.trimStart().startsWith("→"));

  return /\[(t\d+)\]/u.exec(current ?? "")?.[1] ?? "";
}

/** Signs in as `email` and waits until the sidebar names them. */
export async function signInAs(baseUrl: string, email: string): Promise<void> {
  await signIn(baseUrl, email);

  await waitFor(
    `${email} to be signed in`,
    20_000,
    () =>
      browser("get", "count", ".person-bar") !== "0" &&
      browser("get", "text", ".person-bar").includes(email),
  );
}

/** Signs out from the person bar and waits for the sign-in screen. */
export async function signOut(): Promise<void> {
  browser("find", "role", "button", "click", "--name", "Sign out");
  await waitFor("the sign-in screen after signing out", 15_000, onSignInScreen);
}

/** Signs out, then in again at `baseUrl` as `email`, on the same browser. */
export async function signOutAndInAs(baseUrl: string, email: string): Promise<void> {
  await signOut();
  await signInAs(baseUrl, email);
}

/** The `Cookie` header of the browser's session, for a request a scenario sends without the browser. */
export function sessionCookieHeader(): string {
  const session = browser("cookies", "get")
    .split("\n")
    .find((line) => line.startsWith("aobot_session="));

  return session?.split(/\s/u, 1)[0] ?? "";
}
