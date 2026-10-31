import { ConversationPanel } from "@aobot/web";
import type { ReactNode } from "react";
import { ComposerStage } from "./ComposerStage.tsx";
import { answering, asked, connected, connecting, failed, halfAnswered, talk } from "./fixtures.ts";
import { AvatarSheet } from "./planned/AvatarSheet.tsx";
import { PlannedConversation } from "./planned/PlannedConversation.tsx";
import { PlannedLayout } from "./planned/PlannedLayout.tsx";
import { Sidebar } from "./planned/Sidebar.tsx";
import type { StaticName } from "./screens.ts";

/** The screens that never hydrate: the server draws them once and the page ships no script for them. */
const staticScreens: Record<StaticName, () => ReactNode> = {
  layout: () => <PlannedLayout />,
  sidebar: () => <Sidebar />,
  avatars: () => <AvatarSheet />,
  conversation: () => <ConversationPanel conversation={connected(talk)} />,
  "conversation-running": () => <ConversationPanel conversation={answering(halfAnswered)} />,
  connecting: () => <ConversationPanel conversation={connecting} />,
  "approval-card": () => <PlannedConversation />,
  "composer-running": () => <ComposerStage disabled={false} isRunning />,
  "composer-disabled": () => <ComposerStage disabled isRunning={false} />,
  "error-connection": () => (
    <ConversationPanel conversation={failed(asked, "connection", "Cannot reach the server.")} />
  ),
  "error-busy": () => (
    <ConversationPanel
      conversation={failed(
        asked,
        "busy",
        "Bot is still answering. Wait for it to finish or stop it.",
      )}
    />
  ),
  "error-stalled": () => (
    <ConversationPanel
      conversation={failed(
        asked,
        "stalled",
        "The model sent nothing for 60 seconds, so this turn was stopped. Send your message again to retry.",
      )}
    />
  ),
};

/** A screen drawn on the server only. */
export function StaticScreen(props: { readonly name: StaticName }) {
  return staticScreens[props.name]();
}
