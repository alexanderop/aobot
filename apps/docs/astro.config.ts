import { fileURLToPath } from "node:url";
import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";
import { sidebar, siteHref } from "./src/shared/doc-routes.ts";

/** The docs site: Starlight over the repository's `docs/` folder, with Mermaid diagrams. */
export default defineConfig({
  markdown: {
    processor: satteri({
      mdastPlugins: [
        {
          name: "aobot-docs",
          // Starlight prints the front-matter title, so the file's own `# Title` would show twice.
          heading(node, context) {
            if (node.depth === 1) context.removeNode(node);
          },
          link(node, context) {
            if (context.fileURL === undefined) return;

            const href = siteHref(fileURLToPath(context.fileURL), node.url);

            if (href !== node.url) context.setProperty(node, "url", href);
          },
        },
      ],
    }),
  },
  integrations: [
    mermaid({ autoTheme: true }),
    starlight({
      title: "aobot",
      description: "AI coworkers with their own computer and guardrails.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/alexanderop/aobot" }],
      customCss: ["./src/styles/theme.css"],
      sidebar: sidebar(),
    }),
  ],
});
