import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Option, Redacted } from "effect";
import { computerConfig } from "./config.ts";

function configFrom(env: Record<string, string>) {
  return computerConfig.parse(ConfigProvider.fromEnv({ env: { HOME: "/home/pwuser", ...env } }));
}

describe("computerConfig", () => {
  it.effect("listens on 4100, refuses private hosts and exports nothing by default", () =>
    Effect.gen(function* () {
      const config = yield* configFrom({ COMPUTER_TOKEN: "s3cret" });
      expect(config.port).toBe(4100);
      expect(config.allowPrivateHosts).toBe(false);
      expect(config.otlpEndpoint).toEqual(Option.none());
      expect(Redacted.value(config.token)).toBe("s3cret");
    }),
  );

  it.effect.each([[{}], [{ COMPUTER_TOKEN: "" }]])(
    "refuses to start without a token: %j",
    ([env]) =>
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(configFrom(env)))).toBe(true);
      }),
  );

  it.effect("allows private hosts when asked", () =>
    Effect.gen(function* () {
      const config = yield* configFrom({
        COMPUTER_TOKEN: "s3cret",
        COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
      });

      expect(config.allowPrivateHosts).toBe(true);
    }),
  );
});
