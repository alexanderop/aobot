import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option, Redacted } from "effect";
import { AgentRuntimeSettings } from "../features/agent/public.ts";
import { AuthSettings } from "../features/auth/public.ts";
import { ComputerProvider } from "../features/computers/public.ts";
import { serverConfig } from "./config.ts";
import { privateHostsProblem, sharedSubscriptionProblem } from "./local-only.ts";

const acp = AgentRuntimeSettings.Acp({ agent: "claude-code", home: "/Users/someone" });

const signIn = {
  OIDC_ISSUER: "https://login.example.com",
  OIDC_CLIENT_ID: "aobot",
  OIDC_CLIENT_SECRET: "secret",
  SIGNIN_ALLOWED_EMAIL_DOMAINS: "example.com",
};

const apiKey = {
  MODEL_PROVIDER: "anthropic",
  MODEL_NAME: "claude",
  MODEL_API_KEY: "key",
  ...signIn,
};

const signingIn = AuthSettings.SignIn({
  signIn: {
    provider: {
      issuer: new URL(signIn.OIDC_ISSUER),
      internalIssuer: Option.none(),
      clientId: "aobot",
      clientSecret: Redacted.make("secret"),
    },
    allowedDomains: ["example.com"],
    admins: new Set(),
  },
});

function configFrom(env: Record<string, string>) {
  return serverConfig.parse(ConfigProvider.fromEnv({ env }));
}

describe("sharedSubscriptionProblem", () => {
  it("lets acp start on loopback in single-user mode", () => {
    expect(sharedSubscriptionProblem(acp, AuthSettings.SingleUser(), "127.0.0.1")).toEqual(
      Option.none(),
    );
  });

  it("refuses acp outside single-user mode", () => {
    expect(Option.getOrThrow(sharedSubscriptionProblem(acp, signingIn, "127.0.0.1"))).toContain(
      "SINGLE_USER=true",
    );
  });

  it("refuses acp on an address others can reach", () => {
    expect(
      Option.getOrThrow(sharedSubscriptionProblem(acp, AuthSettings.SingleUser(), "0.0.0.0")),
    ).toContain("HOST is 0.0.0.0");
  });
});

describe("privateHostsProblem", () => {
  it("lets private hosts be opened in development", () => {
    expect(privateHostsProblem("development", true)).toEqual(Option.none());
  });

  it("refuses private hosts in production", () => {
    expect(Option.getOrThrow(privateHostsProblem("production", true))).toContain(
      "COMPUTER_ALLOW_PRIVATE_HOSTS",
    );
  });

  it("runs production with private hosts refused", () => {
    expect(privateHostsProblem("production", false)).toEqual(Option.none());
  });
});

describe("serverConfig", () => {
  it.effect(
    "runs api with sign-in by default, on every address, without asking for ACP settings",
    () =>
      Effect.gen(function* () {
        const config = yield* configFrom(apiKey);

        expect(AgentRuntimeSettings.$is("Api")(config.runtime)).toBe(true);
        expect(config.host).toBe("0.0.0.0");
        expect(config.auth).toEqual(signingIn);
      }),
  );

  it.effect("is opened at localhost on its own port unless PUBLIC_URL says where", () =>
    Effect.gen(function* () {
      const local = yield* configFrom({ ...apiKey, PORT: "3100" });
      const hosted = yield* configFrom({ ...apiKey, PUBLIC_URL: "https://aobot.example.com" });

      expect(local.publicUrl.href).toBe("http://localhost:3100/");
      expect(hosted.publicUrl.href).toBe("https://aobot.example.com/");
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

  it.effect("runs computers on Docker in development, with private hosts refused", () =>
    Effect.gen(function* () {
      const config = yield* configFrom({ ...apiKey });

      expect(config.deployment).toBe("development");
      expect(config.computers.allowPrivateHosts).toBe(false);
      expect(config.computers.provider).toEqual(
        ComputerProvider.Docker({
          socketPath: "/var/run/docker.sock",
          image: "aobot-computer:dev",
          name: "aobot-computer",
          network: Option.none(),
        }),
      );
    }),
  );

  it.effect("refuses to start production with private hosts allowed", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        configFrom({ ...apiKey, AOBOT_ENV: "production", COMPUTER_ALLOW_PRIVATE_HOSTS: "true" }),
      );

      expect(error.message).toContain("AOBOT_ENV=production");
    }),
  );
});
