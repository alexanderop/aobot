import { Schema } from "effect";
import { evaluate } from "./browser.ts";

/** Whether the Bot's screen panel is `open` or `folded`, or `none` before it is drawn. */
export function panelState(): string {
  return evaluate(Schema.String, `document.querySelector(".live-screen")?.dataset.state ?? "none"`);
}

/** Everything the panel says, its buttons included. */
export function panelText(): string {
  return evaluate(Schema.String, `document.querySelector(".live-screen")?.textContent ?? ""`);
}

/** How many colours the frame shows, sampled on a grid: none before a frame is drawn, one for a blank page. */
export function frameColours(): number {
  return evaluate(
    Schema.Number,
    `(() => {
      const frame = document.querySelector(".live-screen__frame");
      if (!frame?.naturalWidth) return 0;
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 80;
      const context = canvas.getContext("2d");
      context.drawImage(frame, 0, 0, 128, 80);
      const pixels = context.getImageData(0, 0, 128, 80).data;
      const colours = new Set();
      for (let at = 0; at < pixels.length; at += 4) colours.add((pixels[at] >> 4) + "," + (pixels[at + 1] >> 4) + "," + (pixels[at + 2] >> 4));
      return colours.size;
    })()`,
  );
}

/** The colour at the middle of the frame as `r,g,b`, or `none` before a frame is drawn. */
export function centreColour(): string {
  return evaluate(
    Schema.String,
    `(() => {
      const frame = document.querySelector(".live-screen__frame");
      if (!frame?.naturalWidth) return "none";
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      context.drawImage(frame, frame.naturalWidth / 2, frame.naturalHeight / 2, 1, 1, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(",");
    })()`,
  );
}
