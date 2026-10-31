import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";
import { AgentRuntimeSettings } from "../features/agent/public.ts";
import { serverConfig } from "./config.ts";
import { isLoopback, sharedSubscriptionProblem } from "./local-only.ts";

const acp = AgentRuntimeSettings.Acp({ agent: "claude-code", home: "/Users/someone" });

function configFrom(env: Record<string, string>) {
  return serverConfig.parse(ConfigProvider.fromEnv({ env }));
}

describe("isLoopback", () => {
  it.each(["127.0.0.1", "127.8.9.10", "::1", "localhost", "::ffff:127.0.0.1"])(
    "counts %s as this machine only",
    (host) => expect(isLoopback(host)).toBe(true),
  );

  it.each([
    "0.0.0.0",
    "::",
    "192.168.1.20",
    "10.0.0.1",
    "128.0.0.1",
    "example.com",
    "127.example.com",
  ])("counts %s as reachable from elsewhere", (host) => expect(isLoopback(host)).toBe(false));
});

describe("sharedSubscriptionProblem", () => {
  it("lets acp start on loopback in single-user mode", () => {
    expect(sharedSubscriptionProblem(acp, true, "127.0.0.1")).toEqual(Option.none());
  });

  it("refuses acp outside single-user mode", () => {
    expect(Option.getOrThrow(sharedSubscriptionProblem(acp, false, "127.0.0.1"))).toContain(
      "SINGLE_USER=true",
    );
  });

  it("refuses acp on an address others can reach", () => {
    expect(Option.getOrThrow(sharedSubscriptionProblem(acp, true, "0.0.0.0"))).toContain(
      "HOST is 0.0.0.0",
    );
  });
});

describe("serverConfig", () => {
  it.effect("runs api by default, on every address, without asking for ACP settings", () =>
    Effect.gen(function* () {
      const config = yield* configFrom({
        MODEL_PROVIDER: "anthropic",
        MODEL_NAME: "claude",
        MODEL_API_KEY: "key",
      });

      expect(AgentRuntimeSettings.$is("Api")(config.runtime)).toBe(true);
      expect(config.host).toBe("0.0.0.0");
      expect(config.singleUser).toBe(false);
    }),
  );

  it.effect("runs acp without any MODEL_* setting", () =>
    Effect.gen(function* () {
      const config = yield* configFrom({
        AGENT_RUNTIME: "acp",
        ACP_AGENT: "codex",
        HOME: "/Users/someone",
        SINGLE_USER: "true",
        HOST: "127.0.0.1",
      });

      expect(config.runtime).toEqual(
        AgentRuntimeSettings.Acp({ agent: "codex", home: "/Users/someone" }),
      );
    }),
  );

  it.effect("refuses to start acp on the default address", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        configFrom({
          AGENT_RUNTIME: "acp",
          ACP_AGENT: "claude-code",
          HOME: "/Users/someone",
          SINGLE_USER: "true",
        }),
      );

      expect(error.message).toContain("HOST is 0.0.0.0");
    }),
  );
});
