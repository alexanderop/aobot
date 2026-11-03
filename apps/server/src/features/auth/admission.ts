import type { Email, SignInRefusalCode } from "@aobot/domain";
import { Option } from "effect";
import { domainOf } from "./email.ts";

/** Why an address is not let in. */
export type NotAdmitted = Extract<SignInRefusalCode, "domain" | "removed">;

/**
Why `email` may not sign in, or none when it may: its domain must be one of `allowedDomains` exactly, no
subdomain of one, and it must not have been removed. The one rule, read before a person is recorded, when
a session is made, and on every request.
*/
export function admission(
  email: Email,
  allowedDomains: ReadonlyArray<string>,
  removed: boolean,
): Option.Option<NotAdmitted> {
  if (!allowedDomains.includes(domainOf(email))) return Option.some("domain");

  return removed ? Option.some("removed") : Option.none();
}
