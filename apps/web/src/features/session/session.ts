import { SignInRefusalCode, signInRefusalWords } from "@aobot/domain";
import { Option, Schema } from "effect";

const decodeCode = Schema.decodeUnknownOption(SignInRefusalCode);

/** What the sign-in screen says of a sign-in the server refused, from the page's query `search`. */
export function refusalOf(search: string): Option.Option<string> {
  return Option.map(Option.fromNullishOr(new URLSearchParams(search).get("signin")), (code) =>
    Option.match(decodeCode(code), {
      onNone: () => "Sign-in did not work. Try again.",
      onSome: (known) => signInRefusalWords[known],
    }),
  );
}

/** Where a sign-in started on the page at `url` returns to: the same page, without the last refusal. */
export function signInHref(url: URL): string {
  const back = new URL(url.href);
  back.searchParams.delete("signin");

  return `/auth/sign-in?return=${encodeURIComponent(back.pathname + back.search)}`;
}
