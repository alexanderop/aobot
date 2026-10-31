/** Built screens come from `apps/web`; planned ones are drawn in `./planned` until their ticket builds them. */
export type ScreenStatus =
  | { readonly kind: "built" }
  | { readonly kind: "planned"; readonly tickets: readonly string[] };

/** One screen of the design page: where it sits in the frame and whether a reader can use it. */
interface ScreenSpec {
  readonly title: string;
  /** The app window's size in CSS pixels. The page scales the frame down to fit the column. */
  readonly width: number;
  readonly height: number;
  readonly status: ScreenStatus;
  /** True when the screen hydrates, so the reader can type into it. */
  readonly interactive: boolean;
}

const built: ScreenStatus = { kind: "built" };

function planned(...tickets: string[]): ScreenStatus {
  return { kind: "planned", tickets };
}

/** Every screen on the design page. `docs/design.md` names one with `[caption](screen:<name>)`. */
export const screens = {
  layout: {
    title: "Full layout",
    width: 1100,
    height: 720,
    status: planned("E2-1", "E2-5", "E3-2"),
    interactive: false,
  },
  sidebar: {
    title: "Sidebar",
    width: 340,
    height: 720,
    status: planned("E2-1", "E3-2"),
    interactive: false,
  },
  avatars: {
    title: "Bot avatars",
    width: 720,
    height: 300,
    status: planned("E2-1"),
    interactive: false,
  },
  conversation: {
    title: "Conversation",
    width: 720,
    height: 460,
    status: built,
    interactive: false,
  },
  "conversation-running": {
    title: "Conversation, Bot answering",
    width: 720,
    height: 400,
    status: built,
    interactive: false,
  },
  connecting: {
    title: "Conversation, connecting",
    width: 720,
    height: 260,
    status: built,
    interactive: false,
  },
  "approval-card": {
    title: "Approval card",
    width: 720,
    height: 580,
    status: planned("E2-5"),
    interactive: false,
  },
  "composer-idle": {
    title: "Composer, idle",
    width: 720,
    height: 84,
    status: built,
    interactive: true,
  },
  "composer-focused": {
    title: "Composer, focused",
    width: 720,
    height: 84,
    status: built,
    interactive: true,
  },
  "composer-running": {
    title: "Composer, Bot answering",
    width: 720,
    height: 84,
    status: built,
    interactive: false,
  },
  "composer-disabled": {
    title: "Composer, disabled",
    width: 720,
    height: 84,
    status: built,
    interactive: false,
  },
  "error-connection": {
    title: "Error, cannot reach the server",
    width: 720,
    height: 320,
    status: built,
    interactive: false,
  },
  "error-busy": {
    title: "Error, Bot is busy",
    width: 720,
    height: 320,
    status: built,
    interactive: false,
  },
  "error-stalled": {
    title: "Error, the model stalled",
    width: 720,
    height: 340,
    status: built,
    interactive: false,
  },
} as const satisfies Record<string, ScreenSpec>;

/** The name of a screen. */
export type ScreenName = keyof typeof screens;

/** The screens a reader can type into: they hydrate. */
export type InteractiveName = {
  [Name in ScreenName]: (typeof screens)[Name]["interactive"] extends true ? Name : never;
}[ScreenName];

/** The screens drawn once on the server, with no script. */
export type StaticName = Exclude<ScreenName, InteractiveName>;

/** True when the screen hydrates. */
export function isInteractiveName(name: ScreenName): name is InteractiveName {
  return screens[name].interactive;
}

/** True when `name` is a screen on the design page. */
export function isScreenName(name: string): name is ScreenName {
  return Object.hasOwn(screens, name);
}

/** The page of one screen, the document the design page frames. */
export function screenPath(name: ScreenName): string {
  return `/screens/${name}/`;
}

/** Plain-words status for the caption badge: `Built`, or `Planned · E2-1 · E2-5`. */
export function statusLabel(status: ScreenStatus): string {
  return status.kind === "built" ? "Built" : ["Planned", ...status.tickets].join(" · ");
}
