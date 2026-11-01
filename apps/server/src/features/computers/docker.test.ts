import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Computers } from "./computers.ts";
import {
  ContainerInspect,
  containerSpec,
  computerUrl,
  dockerComputers,
  type DockerOptions,
  publishedPort,
} from "./docker.ts";
import { bodyOf, reply, serve } from "./testing/serve.ts";

const hostOptions: DockerOptions = {
  docker: {
    socketPath: "/unused",
    image: "aobot-computer:dev",
    name: "aobot-computer",
    network: Option.none(),
  },
  allowPrivateHosts: false,
  otlpEndpoint: Option.none(),
};

const networkOptions: DockerOptions = {
  ...hostOptions,
  docker: {
    ...hostOptions.docker,
    name: "aobot-verify-computer",
    network: Option.some("aobot_computer"),
  },
  allowPrivateHosts: true,
  otlpEndpoint: Option.some("http://otel-lgtm:4318"),
};

function inspectWithPorts(ports: ContainerInspect["NetworkSettings"]["Ports"]): ContainerInspect {
  return { State: { Running: true }, Config: { Labels: {} }, NetworkSettings: { Ports: ports } };
}

describe("containerSpec", () => {
  it("publishes the computer on loopback only, when the server runs on the host", () => {
    const spec = containerSpec(hostOptions, "secret");

    expect(spec.HostConfig).toMatchObject({
      PortBindings: { "4100/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
    });
    expect(spec.HostConfig).not.toHaveProperty("NetworkMode");
    expect(spec.Env).toEqual(["COMPUTER_TOKEN=secret", "COMPUTER_ALLOW_PRIVATE_HOSTS=false"]);
  });

  it("joins the computer network and publishes nothing, when one is set", () => {
    const spec = containerSpec(networkOptions, "secret");

    expect(spec.HostConfig).toMatchObject({ NetworkMode: "aobot_computer" });
    expect(spec.HostConfig).not.toHaveProperty("PortBindings");
    expect(spec.Env).toEqual([
      "COMPUTER_TOKEN=secret",
      "COMPUTER_ALLOW_PRIVATE_HOSTS=true",
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318",
    ]);
  });

  it("runs the computer without capabilities or new privileges", () => {
    expect(containerSpec(hostOptions, "secret").HostConfig).toMatchObject({
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
    });
  });
});

describe("publishedPort", () => {
  it("reads the port Docker picked", () => {
    expect(
      publishedPort(inspectWithPorts({ "4100/tcp": [{ HostIp: "127.0.0.1", HostPort: "55123" }] })),
    ).toEqual(Option.some(55123));
  });

  it.each([
    ["no port map", undefined],
    ["a null port map", null],
    ["no binding yet", { "4100/tcp": null }],
    ["an empty host port", { "4100/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] }],
    ["a port that is not a number", { "4100/tcp": [{ HostIp: "127.0.0.1", HostPort: "abc" }] }],
    ["port 0", { "4100/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] }],
    ["a port out of range", { "4100/tcp": [{ HostIp: "127.0.0.1", HostPort: "70000" }] }],
    ["another container port", { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] }],
  ])("finds none in %s", (_case, ports) => {
    expect(publishedPort(inspectWithPorts(ports))).toEqual(Option.none());
  });
});

describe("computerUrl", () => {
  it("reaches the computer by its configured name on its network, and on loopback from the host", () => {
    const inspect = inspectWithPorts({
      "4100/tcp": [{ HostIp: "127.0.0.1", HostPort: "55123" }],
    });

    expect(computerUrl(networkOptions, inspect)).toEqual(
      Option.some("http://aobot-verify-computer:4100"),
    );
    expect(computerUrl(hostOptions, inspect)).toEqual(Option.some("http://127.0.0.1:55123"));
  });
});

interface FakeContainer {
  readonly env: ReadonlyArray<string>;
  readonly labels: Readonly<Record<string, string>>;
  running: boolean;
}

interface FakeDockerState {
  container: FakeContainer | undefined;
  readonly calls: Array<string>;
  readonly acts: Array<string>;
  /** How many health polls to leave unanswered, as a computer caught mid-start does. */
  unansweredHealthPolls: number;
}

const CreateBody = Schema.fromJsonString(
  Schema.Struct({
    Env: Schema.Array(Schema.String),
    Labels: Schema.Record(Schema.String, Schema.String),
  }),
);

/** A Docker Engine on a unix socket that knows one container, and the computer it runs on loopback. */
const fakeDocker = Effect.gen(function* () {
  const state: FakeDockerState = {
    container: undefined,
    calls: [],
    acts: [],
    unansweredHealthPolls: 0,
  };

  const computer = yield* serve((request, response) => {
    if (request.url === "/health" && state.unansweredHealthPolls > 0) {
      state.unansweredHealthPolls -= 1;

      return;
    }

    if (request.url === "/health") return reply(response, 200);

    state.acts.push(String(request.headers.authorization));
    reply(response, 200, {
      action: "navigate",
      url: "https://example.com/",
      title: "Example",
      snapshot: "",
      truncated: false,
    });
  });

  const socketPath = join(tmpdir(), `aobot-docker-${crypto.randomUUID().slice(0, 8)}.sock`);

  yield* serve(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://docker");
    const call = `${request.method} ${url.pathname}`;
    state.calls.push(call);
    const body = await bodyOf(request);

    switch (call) {
      case "GET /containers/aobot-computer/json":
        return state.container === undefined
          ? reply(response, 404, { message: "No such container: aobot-computer" })
          : reply(response, 200, {
              State: { Running: state.container.running },
              Config: { Labels: state.container.labels },
              NetworkSettings: {
                Ports: { "4100/tcp": [{ HostIp: "127.0.0.1", HostPort: String(computer.port) }] },
              },
            });
      case "POST /containers/create": {
        const spec = Schema.decodeUnknownSync(CreateBody)(body);
        state.container = { env: spec.Env, labels: spec.Labels, running: false };

        return reply(response, 201, { Id: "abc" });
      }

      case "POST /containers/aobot-computer/start":
        if (state.container !== undefined) state.container.running = true;

        return reply(response, 204);
      case "DELETE /containers/aobot-computer":
        state.container = undefined;

        return reply(response, 204);
      default:
        return reply(response, 500, { message: `unexpected ${call}` });
    }
  }, socketPath);

  const layer = dockerComputers({
    ...hostOptions,
    docker: { ...hostOptions.docker, socketPath },
  }).pipe(Layer.provide(FetchHttpClient.layer));

  return { state, layer };
});

const tokenOf = (container: FakeContainer | undefined) =>
  container?.env
    .find((line) => line.startsWith("COMPUTER_TOKEN="))
    ?.slice("COMPUTER_TOKEN=".length);

describe("dockerComputers", () => {
  it.effect("starts the computer once and acts on it with the token it was started with", () =>
    Effect.gen(function* () {
      const docker = yield* fakeDocker;

      yield* Effect.gen(function* () {
        const computers = yield* Computers;

        const computer = yield* computers.ensure;
        const result = yield* computer.act({ action: "navigate", url: "https://example.com" });
        yield* computers.ensure;

        expect(result).toMatchObject({ title: "Example" });
        expect(
          docker.state.calls.filter((call) => call === "POST /containers/create"),
        ).toHaveLength(1);
        expect(docker.state.acts).toEqual([`Bearer ${tokenOf(docker.state.container)}`]);
        expect(yield* computers.list).toEqual([{ name: "aobot-computer", running: true }]);
      }).pipe(Effect.provide(docker.layer));
    }).pipe(Effect.scoped),
  );

  it.live("starts the computer when a health poll caught mid-start is never answered", () =>
    Effect.gen(function* () {
      const docker = yield* fakeDocker;
      docker.state.unansweredHealthPolls = 1;

      const result = yield* Computers.use((computers) =>
        computers.ensure.pipe(
          Effect.flatMap((computer) =>
            computer.act({ action: "navigate", url: "https://example.com" }),
          ),
        ),
      ).pipe(Effect.provide(docker.layer));

      expect(docker.state.unansweredHealthPolls).toBe(0);
      expect(result).toMatchObject({ title: "Example" });
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  );

  it.effect(
    "replaces a computer an earlier server started, since only that server knew its token",
    () =>
      Effect.gen(function* () {
        const docker = yield* fakeDocker;
        docker.state.container = {
          env: ["COMPUTER_TOKEN=old"],
          labels: { "aobot.computer": "shared" },
          running: true,
        };

        yield* Computers.use((computers) => computers.ensure).pipe(Effect.provide(docker.layer));

        expect(docker.state.calls).toContain("DELETE /containers/aobot-computer");
        expect(tokenOf(docker.state.container)).not.toBe("old");
      }).pipe(Effect.scoped),
  );

  it.effect("removes the computer it started when the server stops", () =>
    Effect.gen(function* () {
      const docker = yield* fakeDocker;

      yield* Computers.use((computers) => computers.ensure).pipe(Effect.provide(docker.layer));

      expect(docker.state.calls.at(-1)).toBe("DELETE /containers/aobot-computer");
      expect(docker.state.container).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a computer it did not start when the server stops", () =>
    Effect.gen(function* () {
      const docker = yield* fakeDocker;
      docker.state.container = {
        env: ["COMPUTER_TOKEN=other"],
        labels: { "aobot.computer": "shared" },
        running: true,
      };

      yield* Computers.use((computers) => computers.list).pipe(Effect.provide(docker.layer));

      expect(docker.state.calls).not.toContain("DELETE /containers/aobot-computer");
      expect(docker.state.container).toBeDefined();
    }).pipe(Effect.scoped),
  );

  it.effect("never takes over a container with the name that aobot did not create", () =>
    Effect.gen(function* () {
      const docker = yield* fakeDocker;
      docker.state.container = { env: [], labels: {}, running: true };

      const error = yield* Computers.use((computers) => Effect.flip(computers.ensure)).pipe(
        Effect.provide(docker.layer),
      );

      yield* Computers.use((computers) => computers.reset).pipe(Effect.provide(docker.layer));

      expect(error._tag).toBe("ComputerUnavailable");
      expect(docker.state.calls).not.toContain("DELETE /containers/aobot-computer");
      expect(docker.state.container).toBeDefined();
    }).pipe(Effect.scoped),
  );
});
