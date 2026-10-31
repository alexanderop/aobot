import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { docsSchema } from "@astrojs/starlight/schema";
import { docId, docsRoot } from "./shared/doc-routes.ts";

/** Ticket fields from `docs/ticket-template.md`. Pages that are not tickets leave them out. */
const ticket = z.object({
  id: z.string().optional(),
  epic: z.string().optional(),
  status: z.enum(["todo", "doing", "done"]).optional(),
  depends_on: z.array(z.string()).optional(),
  estimate: z.string().optional(),
});

/** The docs collection is the repository's `docs/` folder, so the markdown agents read is the site. */
export const collections = {
  docs: defineCollection({
    loader: glob({
      base: docsRoot,
      pattern: "**/*.md",
      generateId: (options) => docId(options.entry),
    }),
    schema: (context) =>
      docsSchema({ extend: ticket })(context).transform((page) =>
        page.id === undefined ? page : { ...page, title: `${page.id} · ${page.title}` },
      ),
  }),
};
