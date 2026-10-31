import { PlannedConversation } from "./PlannedConversation.tsx";
import { Sidebar } from "./Sidebar.tsx";
import "./planned.css";

/** Planned in E2-1, E2-5 and E3-2: the sidebar of Bots beside the open conversation. */
export function PlannedLayout() {
  return (
    <div className="shell">
      <Sidebar />
      <PlannedConversation />
    </div>
  );
}
