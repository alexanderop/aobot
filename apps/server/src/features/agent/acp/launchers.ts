import { Effect, FileSystem, Path, type PlatformError, Schema } from "effect";

/** The CLIs `acp` can run a Bot on, each on the person's own subscription. */
export const AcpAgentName = Schema.Literals(["claude-code", "codex", "opencode"]);

/** A decoded {@link AcpAgentName}. */
export type AcpAgentName = typeof AcpAgentName.Type;

/** Where one turn's CLI runs: its own empty folder, and the home folder of the person it runs for. */
interface LaunchContext {
  readonly folder: string;
  readonly home: string;
}

/** How to start one CLI's ACP adapter with every built-in tool it has switched off. */
export interface AcpLauncher {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Variables added to the inherited environment, after any files the CLI needs are written. */
  readonly environment: (
    context: LaunchContext,
  ) => Effect.Effect<
    Readonly<Record<string, string>>,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  >;
  /** `_meta` for `session/new`. */
  readonly sessionMeta: Schema.JsonObject;
}

/**
Codex has no single "no tools" switch, so every feature that adds a tool is off, and the sandbox is
read-only in case one is missed. The contract suite proves nothing is left (`acp-runtime.contract.ts`).
*/
const codexConfig = `
approval_policy = "on-request"
sandbox_mode = "read-only"
web_search = "disabled"

# The person's skills (~/.agents/skills) and the bundled ones stay out of the Bot's instructions.
[skills]
include_instructions = false

[skills.bundled]
enabled = false

[features]
shell_tool = false
unified_exec = false
view_image = false
image_generation = false
multi_agent = false
apps = false
plugins = false
memories = false
browser_use = false
computer_use = false
goals = false
sleep_tool = false
tool_suggest = false
skill_search = false
hooks = false
`;

/**
One entry per CLI, so adding one is a row here. Adapter versions are pinned exactly: an adapter decides
which tools exist, so an upgrade is a change the contract suite must pass again.
*/
export const acpAgents = {
  "claude-code": {
    command: "npx",
    args: ["--yes", "@agentclientprotocol/claude-agent-acp@0.99.1"],
    environment: () => Effect.succeed({}),
    // `tools: []` removes every built-in tool. `settingSources: []` and `strictMcpConfig` keep the
    // person's own settings, hooks and MCP servers out of the Bot's session.
    sessionMeta: {
      claudeCode: { options: { tools: [], settingSources: [], strictMcpConfig: true } },
    },
  },
  codex: {
    command: "npx",
    args: ["--yes", "@agentclientprotocol/codex-acp@2.5.0"],
    // A Codex home of its own, so the person's config, MCP servers, hooks and AGENTS.md stay out. Only
    // the sign-in is shared, as a link, so a token Codex refreshes lands back in the person's file.
    environment: ({ folder, home }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const codexHome = path.join(folder, ".codex");
        const signIn = path.join(home, ".codex", "auth.json");

        yield* fs.makeDirectory(codexHome);
        yield* fs.writeFileString(path.join(codexHome, "config.toml"), codexConfig);

        if (yield* fs.exists(signIn)) {
          yield* fs.symlink(signIn, path.join(codexHome, "auth.json"));
        }

        return { CODEX_HOME: codexHome, INITIAL_AGENT_MODE: "read-only", NO_BROWSER: "1" };
      }),
    sessionMeta: {},
  },
  opencode: {
    command: "npx",
    args: ["--yes", "opencode-ai@1.19.5", "acp"],
    // A config folder of its own, so the person's plugins (code OpenCode runs), skills, commands and
    // settings in ~/.config/opencode stay out. The sign-in lives under ~/.local/share and still works.
    environment: ({ folder }) =>
      Effect.succeed({
        XDG_CONFIG_HOME: `${folder}/.config`,
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        // Deny every tool but the gateway's MCP server, which OpenCode names `aobot_<tool>`. The title
        // agent is off: it would spend a model call per turn on a title nobody sees.
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { "*": "deny", "aobot_*": "allow" },
          agent: { title: { disable: true } },
          autoupdate: false,
          share: "disabled",
        }),
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
      }),
    sessionMeta: {},
  },
} satisfies { readonly [A in AcpAgentName]: AcpLauncher };
