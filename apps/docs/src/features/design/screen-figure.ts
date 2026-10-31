import { Option } from "effect";
import { isScreenName, screenPath, screens, statusLabel } from "./screens.ts";

/** The URL scheme `docs/design.md` uses to place a screen: `[caption](screen:layout)`. */
const screenScheme = "screen:";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The screen a `screen:<name>` link points at, or none when the link is something else. */
export function screenNameOf(url: string): Option.Option<string> {
  return url.startsWith(screenScheme) ? Option.some(url.slice(screenScheme.length)) : Option.none();
}

/**
The design page's figure for one screen: a window frame around an iframe of the screen's own page, and
a caption with the built or planned badge. The iframe keeps the app's CSS out of Starlight and the
other way round, so the screen looks the way it does in the app, in either Starlight theme.
*/
export function screenFigure(name: string, caption: string): string {
  if (!isScreenName(name)) throw new Error(`docs/design.md places an unknown screen: ${name}`);

  const { width, height, status, title } = screens[name];
  const href = screenPath(name);
  const kind = status.kind;

  return [
    `<figure class="screen screen--${kind}" style="--screen-w:${width};--screen-h:${height}">`,
    `<div class="screen__bar" aria-hidden="true"><span class="screen__lights"><i></i><i></i><i></i></span></div>`,
    `<div class="screen__viewport"><iframe src="${href}" title="${escapeHtml(title)}" width="${width}" height="${height}"></iframe></div>`,
    `<figcaption><span class="screen__badge screen__badge--${kind}">${escapeHtml(statusLabel(status))}</span> ${escapeHtml(caption)} <a class="screen__open" href="${href}" target="_blank" rel="noopener">Open full size</a></figcaption>`,
    `</figure>`,
  ].join("");
}
