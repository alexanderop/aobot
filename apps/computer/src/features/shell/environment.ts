import { Config, Record } from "effect";

/** The Bot's own folder, where every command runs. It is also the commands' HOME. */
export const workspace = "/workspace";

/**
What a command inherits from the computer's environment: its PATH and locale, and nothing else. A list
of names to let through, rather than the environment with some taken out, so a secret the deployment
adds later never reaches `env`.
*/
export const inheritedEnvironment = Config.all({
  PATH: Config.String("PATH").pipe(
    Config.withDefault("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
  ),
  LANG: Config.option(Config.String("LANG")),
  LANGUAGE: Config.option(Config.String("LANGUAGE")),
  LC_ALL: Config.option(Config.String("LC_ALL")),
});

/** A decoded {@link inheritedEnvironment}. */
export type InheritedEnvironment = Config.Success<typeof inheritedEnvironment>;

const loopback = "127.0.0.1,localhost,::1";

/**
The whole environment a command runs with. Its proxy variables name the computer's egress filter, so a
command that honours them is held to the destinations the filter allows. The deployment's own proxy
variables are not passed: the filter connects out itself, and they would be a way around it.
*/
export function commandEnvironment(
  inherited: InheritedEnvironment,
  proxy: string,
): Record<string, string> {
  const { PATH, ...locale } = inherited;

  return {
    PATH,
    ...Record.getSomes(locale),
    HOME: workspace,
    // `apt-get` would otherwise wait for an answer nobody is there to give, until the time limit.
    DEBIAN_FRONTEND: "noninteractive",
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: loopback,
    no_proxy: loopback,
  };
}
