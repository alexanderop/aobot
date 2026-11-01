import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import { Destinations, DestinationUnreachable, makeDestinations } from "../egress/public.ts";
import { checkNavigation } from "./navigation.ts";

const dns = new Map([
  ["example.com", ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]],
  ["intranet.example", ["10.0.0.5"]],
  ["mixed.example", ["93.184.215.14", "169.254.169.254"]],
]);

const fakeResolve = (host: string) =>
  Option.match(Option.fromNullishOr(dns.get(host)), {
    onNone: () => Effect.fail(new DestinationUnreachable({ message: `Could not find ${host}.` })),
    onSome: (addresses) => Effect.succeed(addresses),
  });

function destinations(allowPrivateHosts: boolean) {
  return Layer.succeed(Destinations, makeDestinations(allowPrivateHosts, fakeResolve));
}

function navigate(url: string, allowPrivateHosts = false) {
  return checkNavigation(url).pipe(
    Effect.map((checked) => checked.href),
    Effect.provide(destinations(allowPrivateHosts)),
    Effect.exit,
  );
}

function refusedTag(exit: Exit.Exit<string, { readonly _tag: string }>) {
  return Exit.match(exit, {
    onSuccess: () => "allowed",
    onFailure: (cause) =>
      cause.reasons[0]?._tag === "Fail" ? cause.reasons[0].error._tag : "died",
  });
}

describe("checkNavigation", () => {
  it.effect("opens a public web address", () =>
    Effect.gen(function* () {
      expect(yield* navigate("https://example.com/path?q=1")).toEqual(
        Exit.succeed("https://example.com/path?q=1"),
      );
    }),
  );

  it.effect.each([
    ["file:///etc/passwd"],
    ["chrome://settings"],
    ["javascript:alert(1)"],
    ["not a url"],
    ["http://169.254.169.254/latest/meta-data/"],
    ["http://10.0.0.1"],
    ["http://[::ffff:169.254.169.254]/"],
    ["http://[64:ff9b::a9fe:a9fe]/"],
    ["http://metadata.goog/"],
    ["http://2852039166/"],
    ["http://intranet.example/"],
    ["http://mixed.example/"],
  ])("refuses %s", ([url]) =>
    Effect.gen(function* () {
      expect(refusedTag(yield* navigate(url))).toBe("ActionRefused");
    }),
  );

  it.effect("lets private hosts through when they are allowed", () =>
    Effect.gen(function* () {
      expect(refusedTag(yield* navigate("http://10.0.0.1/", true))).toBe("allowed");
      expect(refusedTag(yield* navigate("http://intranet.example/", true))).toBe("allowed");
    }),
  );

  it.effect.each([
    ["http://169.254.169.254/"],
    ["http://[64:ff9b::a9fe:a9fe]/"],
    ["http://metadata.goog/"],
    ["http://mixed.example/"],
  ])("never lets %s through, even with private hosts allowed", ([url]) =>
    Effect.gen(function* () {
      expect(refusedTag(yield* navigate(url, true))).toBe("ActionRefused");
    }),
  );

  it.effect("fails, rather than refuses, a name that does not resolve", () =>
    Effect.gen(function* () {
      expect(refusedTag(yield* navigate("https://nowhere.invalid/"))).toBe("ActionFailed");
    }),
  );
});
