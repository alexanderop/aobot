import type { CharacterName } from "./Avatar.tsx";

/** A Bot as the sidebar lists it. */
export interface SidebarBot {
  readonly name: string;
  readonly character: CharacterName;
  readonly preview: string;
  readonly unread: boolean;
}

/** The pinned Bots: three to a row, big avatars, the name underneath. */
export const pinned: readonly SidebarBot[] = [
  { name: "Chief", character: "amber", preview: "Morning briefing is ready.", unread: true },
  { name: "QS", character: "sky", preview: "Sleep score was 84.", unread: false },
  {
    name: "Kalender",
    character: "mint",
    preview: "Two meetings overlap on Thursday.",
    unread: false,
  },
  { name: "To-Do", character: "sand", preview: "5 open, 1 due today.", unread: true },
  { name: "Lesen", character: "lilac", preview: "Added 3 articles to your queue.", unread: false },
  { name: "Recherche", character: "sage", preview: "Found 12 sources.", unread: false },
];

/** A group of Bots under a muted heading. */
export interface SidebarGroup {
  readonly title: string;
  readonly bots: readonly SidebarBot[];
}

/** The groups under the pinned Bots. */
export const groups: readonly SidebarGroup[] = [
  {
    title: "fitness",
    bots: [
      {
        name: "Fitness Coach",
        character: "coral",
        preview: "Done. Your calendar was free at 7:00.",
        unread: false,
      },
      {
        name: "Essensplaner",
        character: "sage",
        preview: "Dinner plan for the week is ready.",
        unread: false,
      },
    ],
  },
  {
    title: "dev stuff",
    bots: [
      {
        name: "alexop.dev",
        character: "rose",
        preview: "The build is green again.",
        unread: true,
      },
    ],
  },
  {
    title: "news",
    bots: [
      {
        name: "Filme & Serien",
        character: "lilac",
        preview: "New trailer for the series you follow.",
        unread: true,
      },
    ],
  },
];

/** The row that is open. */
export const selected = "Fitness Coach";
