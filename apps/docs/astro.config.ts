import { fileURLToPath } from "node:url";
import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";
import diagramIcons from "./src/shared/diagram-icons.json" with { type: "json" };
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
    mermaid({
      autoTheme: true,
      // A subset of `@iconify-json/fa6-solid`, registered as `fa` so a label can say `fa:fa-server`.
      // To add an icon, copy its entry from that package. The colours are in theme.css.
      iconPacks: [{ name: "fa", icons: diagramIcons }],
      mermaidConfig: { flowchart: { wrappingWidth: 220 } },
    }),
    starlight({
      title: "aobot",
      description: "AI coworkers with their own computer and guardrails.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/alexanderop/aobot" }],
      customCss: ["./src/styles/theme.css"],
      sidebar: sidebar(),
    }),
  ],
});
