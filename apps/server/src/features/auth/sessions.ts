import { createHash } from "node:crypto";
import { Duration, Option } from "effect";
import { Cookies, type Headers } from "effect/http";

/** How long a session lasts from its sign-in, however much it is used. */
export const sessionLifetime = Duration.days(7);

/** The cookie a person's session token is in. */
export const sessionCookie = "aobot_session";

/** The session token `headers` carry, if any. */
export function sessionToken(headers: Headers.Headers): Option.Option<string> {
  return Option.fromUndefinedOr(Cookies.parseHeader(headers["cookie"] ?? "")[sessionCookie]);
}

/** The hash a session's token is stored and looked up by. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
