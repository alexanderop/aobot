import { fileURLToPath } from "node:url";
import { satteri } from "@astrojs/markdown-satteri";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { Option } from "effect";
import mermaid from "astro-mermaid";
import { screenFigure, screenNameOf } from "./src/features/design/screen-figure.ts";
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
          // A paragraph that is only `[caption](screen:<name>)` becomes that screen, framed.
          paragraph(node, context) {
            const [only] = node.children;

            if (node.children.length !== 1 || only?.type !== "link") return;

            const name = screenNameOf(only.url);

            if (Option.isNone(name)) return;
            context.replaceNode(node, {
              rawHtml: screenFigure(name.value, context.textContent(only)),
            });
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
    react(),
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
      customCss: ["./src/styles/theme.css", "./src/styles/screens.css"],
      sidebar: sidebar(),
    }),
  ],
});
