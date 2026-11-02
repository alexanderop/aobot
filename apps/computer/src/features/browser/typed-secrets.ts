import { hiddenValue } from "@aobot/domain";

/**
The shortest secret a read is cleaned of. A shorter one, such as a three-digit PIN, is too likely to be
ordinary text on the page, a year or a price, and every place it appears would be hidden.
*/
const shortestHidden = 4;

/** Each way a page can show `secret`: as typed, in an address or a form sent by GET, and quoted in a snapshot. */
function spellings(secret: string): ReadonlyArray<string> {
  return [
    secret,
    encodeURIComponent(secret),
    new URLSearchParams({ s: secret }).toString().slice("s=".length),
    JSON.stringify(secret).slice(1, -1),
  ];
}

/**
`text` with every place one of `secrets` appears in it shown as {@link hiddenValue}: a one-time code a page
writes into its address after a form sent by GET, or a page that echoes what was typed. Longest first, so
a secret that holds another is hidden whole. A filter: a page that shows a secret some other way, such as
reversed, still shows it.
*/
export function hideTyped(text: string, secrets: ReadonlyArray<string>): string {
  const hidden = secrets
    .filter((secret) => secret.length >= shortestHidden)
    .flatMap(spellings)
    .sort((a, b) => b.length - a.length);

  return hidden.reduce((shown, secret) => shown.replaceAll(secret, hiddenValue), text);
}

/**
`url` with {@link hideTyped} after its origin, which stays as it was: the server judges the page by its
host and the computer checks a ref against its origin, so a host that holds a secret is still that host.
An address on an opaque origin, such as a `data:` page, is cleaned whole.
*/
export function hideTypedInAddress(url: string, secrets: ReadonlyArray<string>): string {
  const origin = URL.parse(url)?.origin ?? "null";

  return origin !== "null" && url.startsWith(origin)
    ? `${origin}${hideTyped(url.slice(origin.length), secrets)}`
    : hideTyped(url, secrets);
}
