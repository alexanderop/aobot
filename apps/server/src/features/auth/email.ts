import { domainToASCII } from "node:url";
import { Email } from "@aobot/domain";
import { Option, Schema } from "effect";

const decodeEmail = Schema.decodeUnknownOption(Email);

/** Labels of letters, digits and hyphens, joined by dots: what an address's domain is once in ASCII. */
const asciiDomain = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u;

/**
A domain as sign-in compares it: lower-cased and in ASCII, so `Exämple.com` is `xn--exmple-cua.com`. None
for anything no address has after its `@`, such as `*.example.com` or the root dot of `example.com.`.
*/
export function normalizeDomain(raw: string): Option.Option<string> {
  return Option.liftPredicate(domainToASCII(raw.trim().toLowerCase()), (domain) =>
    asciiDomain.test(domain),
  );
}

/**
`raw` as sign-in compares an address: split at its last `@`, its domain in ASCII, and lower-cased. Only
`A` to `Z` are lower-cased in the part before the `@`: Unicode case folding reads the Kelvin sign `K` as
`k`, so another account's `Kate@` would sign in as `kate@`. None for anything that is not an address, a
part before the `@` outside ASCII included.
*/
export function normalizeEmail(raw: string): Option.Option<Email> {
  const at = raw.lastIndexOf("@");

  const local = raw
    .slice(0, at)
    .trim()
    .replace(/[A-Z]/gu, (letter) => letter.toLowerCase());

  return at <= 0
    ? Option.none()
    : Option.flatMap(normalizeDomain(raw.slice(at + 1)), (domain) =>
        decodeEmail(`${local}@${domain}`),
      );
}

/** The domain of `email`, after its last `@`. */
export function domainOf(email: Email): string {
  return email.slice(email.lastIndexOf("@") + 1);
}
