import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { commandEnvironment, inheritedEnvironment } from "./environment.ts";

const proxy = "http://127.0.0.1:41000";

function environmentFrom(env: Record<string, string>) {
  return inheritedEnvironment
    .parse(ConfigProvider.fromEnv({ env }))
    .pipe(Effect.map((inherited) => commandEnvironment(inherited, proxy)));
}

describe("commandEnvironment", () => {
  it.effect("passes PATH and the locale, and none of the computer's settings or secrets", () =>
    Effect.gen(function* () {
      const environment = yield* environmentFrom({
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        COMPUTER_TOKEN: "s3cret",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
        HOME: "/home/pwuser",
        AWS_SECRET_ACCESS_KEY: "aws-s3cret",
        BASH_ENV: "/workspace/.evil",
      });

      expect(environment).toEqual({
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        HOME: "/workspace",
        DEBIAN_FRONTEND: "noninteractive",
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
      });
    }),
  );

  it.effect("points every proxy variable at the egress filter, whatever the deployment set", () =>
    Effect.gen(function* () {
      const environment = yield* environmentFrom({
        HTTP_PROXY: "http://user:pass@corporate:3128",
        HTTPS_PROXY: "http://user:pass@corporate:3128",
        ALL_PROXY: "socks5://corporate:1080",
        NO_PROXY: "*",
      });

      expect(environment["HTTP_PROXY"]).toBe(proxy);
      expect(environment["HTTPS_PROXY"]).toBe(proxy);
      expect(environment["NO_PROXY"]).toBe("127.0.0.1,localhost,::1");
      expect(environment).not.toHaveProperty("ALL_PROXY");
      expect(JSON.stringify(environment)).not.toContain("corporate");
    }),
  );

  it.effect("finds bash without a PATH from the deployment", () =>
    Effect.gen(function* () {
      expect((yield* environmentFrom({}))["PATH"]).toContain("/usr/bin");
    }),
  );
});
