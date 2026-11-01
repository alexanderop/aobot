import { randomBytes } from "node:crypto";
import { NodeHttpClient } from "@effect/platform-node";
import {
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
  SubscriptionRef,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  type ComputerAddress,
  computerAt,
  Computers,
  type ComputerStatus,
  ComputerUnavailable,
  liveScreen,
} from "./computers.ts";
import type { DockerSettings } from "./settings.ts";

/** The port the computer listens on inside its container. */
const computerPort = 4100;

/** Marks containers this server created. A container with the name but not the label is never adopted. */
const ownerLabel = "aobot.computer";

const healthTimeout = Duration.seconds(60);

// Docker Desktop can accept a connection to the published port just as the computer starts listening and
// never answer it, so one poll must not be allowed to wait out the whole start.
const healthPollTimeout = Duration.seconds(2);

/** What the docker provider needs: where Docker is, what to run, and what the computer is told. */
export interface DockerOptions {
  readonly docker: DockerSettings;
  readonly allowPrivateHosts: boolean;
  readonly otlpEndpoint: Option.Option<string>;
}

/** The body of `POST /containers/create` for the shared computer, holding `token`. */
export function containerSpec(options: DockerOptions, token: string) {
  const port = `${computerPort}/tcp`;

  return {
    Image: options.docker.image,
    Env: [
      `COMPUTER_TOKEN=${token}`,
      `COMPUTER_ALLOW_PRIVATE_HOSTS=${options.allowPrivateHosts}`,
      ...Option.match(options.otlpEndpoint, {
        onNone: () => [],
        onSome: (endpoint) => [`OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`],
      }),
    ],
    Labels: { [ownerLabel]: "shared" },
    ExposedPorts: { [port]: {} },
    HostConfig: {
      ...Option.match(options.docker.network, {
        // On the host, Docker picks a free port on loopback; `publishedPort` reads it back.
        onNone: () => ({ PortBindings: { [port]: [{ HostIp: "127.0.0.1", HostPort: "" }] } }),
        onSome: (network) => ({ NetworkMode: network }),
      }),
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Init: true,
      PidsLimit: 512,
      Memory: 2 * 1024 ** 3,
      // Chromium keeps its shared memory here; Docker's 64 MB default crashes tabs.
      ShmSize: 512 * 1024 ** 2,
    },
  };
}

const PortBinding = Schema.Struct({ HostIp: Schema.String, HostPort: Schema.String });

/** What we read of `GET /containers/{name}/json`. */
export const ContainerInspect = Schema.Struct({
  State: Schema.Struct({ Running: Schema.Boolean }),
  Config: Schema.Struct({
    Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  }),
  NetworkSettings: Schema.Struct({
    Ports: Schema.optional(
      Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(Schema.Array(PortBinding)))),
    ),
  }),
});

/** A decoded {@link ContainerInspect}. */
export type ContainerInspect = typeof ContainerInspect.Type;

/** The host port Docker published the computer's port on, if it published one that can be dialled. */
export function publishedPort(inspect: ContainerInspect): Option.Option<number> {
  const bindings = inspect.NetworkSettings.Ports?.[`${computerPort}/tcp`] ?? [];

  return Option.fromUndefinedOr(
    bindings
      .map((binding) => binding.HostPort)
      .filter((port) => /^\d+$/u.test(port))
      .map(Number)
      .find((port) => port >= 1 && port <= 65_535),
  );
}

/** Where the server reaches the computer: by name on the shared network, or on loopback from the host. */
export function computerUrl(
  options: DockerOptions,
  inspect: ContainerInspect,
): Option.Option<string> {
  return Option.isSome(options.docker.network)
    ? Option.some(`http://${options.docker.name}:${computerPort}`)
    : Option.map(publishedPort(inspect), (port) => `http://127.0.0.1:${port}`);
}

function isOurs(inspect: ContainerInspect): boolean {
  return inspect.Config.Labels?.[ownerLabel] === "shared";
}

const DockerMessage = Schema.Struct({ message: Schema.String });

function unavailable(message: string) {
  return new ComputerUnavailable({ message });
}

/** A request Docker answered with a status we did not expect, as a {@link ComputerUnavailable}. */
function dockerRefused(what: string) {
  return (response: HttpClientResponse.HttpClientResponse) =>
    HttpClientResponse.schemaBodyJson(DockerMessage)(response).pipe(
      Effect.map(({ message }) => message),
      Effect.orElseSucceed(() => `status ${response.status}`),
      Effect.flatMap((message) => Effect.fail(unavailable(`Docker could not ${what}: ${message}`))),
    );
}

/** The few Docker Engine API calls the provider makes, over the socket. Nothing else is reachable. */
function dockerEngine(client: HttpClient.HttpClient, containerName: string) {
  const path = `/containers/${containerName}`;

  const send = (request: HttpClientRequest.HttpClientRequest) =>
    client
      .execute(request)
      .pipe(
        Effect.mapError((error) =>
          unavailable(`Could not reach Docker. Is it running? ${error.message}`),
        ),
      );

  const ok = () => Effect.void;

  return {
    inspect: send(HttpClientRequest.get(`${path}/json`)).pipe(
      Effect.flatMap(
        HttpClientResponse.matchStatus({
          200: (response) =>
            HttpClientResponse.schemaBodyJson(ContainerInspect)(response).pipe(
              Effect.map(Option.some),
              Effect.mapError((error) =>
                unavailable(
                  `Docker described ${containerName} in a shape we do not read: ${error.message}`,
                ),
              ),
            ),
          404: () => Effect.succeedNone,
          orElse: dockerRefused(`inspect ${containerName}`),
        }),
      ),
    ),
    create: (spec: ReturnType<typeof containerSpec>) =>
      send(
        HttpClientRequest.post("/containers/create", { urlParams: { name: containerName } }).pipe(
          HttpClientRequest.bodyJsonUnsafe(spec),
        ),
      ).pipe(
        Effect.flatMap(
          HttpClientResponse.matchStatus({
            201: ok,
            orElse: dockerRefused(`create ${containerName} from ${spec.Image}`),
          }),
        ),
      ),
    start: send(HttpClientRequest.post(`${path}/start`)).pipe(
      Effect.flatMap(
        HttpClientResponse.matchStatus({
          204: ok,
          304: ok,
          orElse: dockerRefused(`start ${containerName}`),
        }),
      ),
    ),
    stop: send(HttpClientRequest.post(`${path}/stop`)).pipe(
      Effect.flatMap(
        HttpClientResponse.matchStatus({
          204: ok,
          304: ok,
          404: ok,
          orElse: dockerRefused(`stop ${containerName}`),
        }),
      ),
    ),
    remove: send(HttpClientRequest.delete(path, { urlParams: { force: "true" } })).pipe(
      Effect.flatMap(
        HttpClientResponse.matchStatus({
          204: ok,
          404: ok,
          orElse: dockerRefused(`remove ${containerName}`),
        }),
      ),
    ),
  };
}

// Docker calls and health polls are plumbing, not part of what a Bot did; only `/act` is traced.
const untraced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, HttpClient.TracerDisabledWhen, () => true);

/**
{@link Computers} on this machine's Docker Engine: one container, named by `COMPUTER_NAME`. A container
this process did not start is replaced, because only the process that started it knows its token. For the
same reason the container is removed when the server stops: no later process could use it.
*/
export function dockerComputers(options: DockerOptions) {
  const containerName = options.docker.name;

  return Layer.effect(
    Computers,
    Effect.gen(function* () {
      const agent = yield* NodeHttpClient.makeAgent({ socketPath: options.docker.socketPath });

      const engine = dockerEngine(
        (yield* Effect.provideService(
          NodeHttpClient.makeNodeHttp,
          NodeHttpClient.HttpAgent,
          agent,
        )).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://docker"))),
        containerName,
      );

      const client = yield* HttpClient.HttpClient;

      // Where the container this process started is, while it is the one running. Only `ensure` fills it,
      // once the computer answers.
      const running = yield* SubscriptionRef.make(Option.none<ComputerAddress>());
      const oneAtATime = yield* Semaphore.make(1);

      const answering = (address: ComputerAddress) =>
        client.get(new URL("/health", address.url)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.timeout(healthPollTimeout),
          Effect.retry(Schedule.spaced("250 millis")),
          Effect.mapError((error) =>
            unavailable(`${containerName} is not answering: ${error.message}`),
          ),
          Effect.timeoutOrElse({
            duration: healthTimeout,
            orElse: () =>
              Effect.fail(
                unavailable(
                  `${containerName} started but did not answer /health within ${Duration.format(healthTimeout)}.`,
                ),
              ),
          }),
          untraced,
        );

      const addressOf = (inspect: ContainerInspect, secret: Redacted.Redacted<string>) =>
        Option.match(computerUrl(options, inspect), {
          onNone: () => Effect.fail(unavailable(`Docker published no port for ${containerName}.`)),
          onSome: (url): Effect.Effect<ComputerAddress> => Effect.succeed({ url, token: secret }),
        });

      const startFresh = Effect.gen(function* () {
        yield* SubscriptionRef.set(running, Option.none());
        yield* engine.remove;

        const secret = Redacted.make(randomBytes(32).toString("base64url"));
        yield* engine.create(containerSpec(options, Redacted.value(secret)));
        yield* engine.start;

        const started = yield* engine.inspect;

        const inspect = yield* Option.match(started, {
          onNone: () => Effect.fail(unavailable(`${containerName} vanished as it started.`)),
          onSome: Effect.succeed,
        });

        const address = yield* addressOf(inspect, secret);
        yield* answering(address);

        return address;
      });

      const ensure = Effect.gen(function* () {
        const current = yield* engine.inspect;
        const known = Option.map(yield* SubscriptionRef.get(running), ({ token }) => token);

        if (Option.isSome(current) && !isOurs(current.value)) {
          return yield* unavailable(
            `A container named ${containerName} exists that aobot did not create. Remove or rename it.`,
          );
        }

        const address =
          Option.isSome(current) && current.value.State.Running && Option.isSome(known)
            ? yield* addressOf(current.value, known.value)
            : yield* startFresh;

        yield* SubscriptionRef.set(running, Option.some(address));

        return computerAt(address, client);
      }).pipe(untraced, oneAtATime.withPermits(1), Effect.withSpan("Computers.ensure"));

      // Stopping or removing someone else's container is not ours to do.
      const whenOurs = (effect: Effect.Effect<void, ComputerUnavailable>) =>
        engine.inspect.pipe(
          Effect.flatMap((current) =>
            Option.isSome(current) && isOurs(current.value)
              ? Effect.andThen(SubscriptionRef.set(running, Option.none()), effect)
              : Effect.void,
          ),
          untraced,
          oneAtATime.withPermits(1),
        );

      const list = engine.inspect.pipe(
        Effect.map((current): ReadonlyArray<ComputerStatus> =>
          Option.isSome(current) && isOurs(current.value)
            ? [{ name: containerName, running: current.value.State.Running }]
            : [],
        ),
        untraced,
      );

      yield* Effect.addFinalizer(() =>
        SubscriptionRef.get(running).pipe(
          Effect.flatMap((known) => (Option.isSome(known) ? whenOurs(engine.remove) : Effect.void)),
          Effect.catchTag("ComputerUnavailable", ({ message }) =>
            Effect.logWarning("The computer could not be removed on shutdown").pipe(
              Effect.annotateLogs({ computer: containerName, reason: message }),
            ),
          ),
        ),
      );

      const screen = yield* liveScreen(SubscriptionRef.changes(running));

      return Computers.of({
        ensure,
        stop: whenOurs(engine.stop).pipe(Effect.withSpan("Computers.stop")),
        reset: whenOurs(engine.remove).pipe(Effect.withSpan("Computers.reset")),
        list,
        screen,
      });
    }),
  );
}
