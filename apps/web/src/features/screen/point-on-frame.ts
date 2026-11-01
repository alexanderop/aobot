import type { ScreenPoint } from "@aobot/domain";
import { Option } from "effect";

/** Where an element sits on the page, as `getBoundingClientRect` says. */
interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A picture's own size in pixels, as `naturalWidth` and `naturalHeight` say. */
interface Size {
  readonly width: number;
  readonly height: number;
}

/**
Where a click at `clientX`, `clientY` landed on a frame drawn with `object-fit: contain` in `box`, as
fractions of the frame. None for a click on the bars beside or above the frame, or before it has a size.
*/
export function pointOnFrame(
  clientX: number,
  clientY: number,
  box: Box,
  natural: Size,
): Option.Option<ScreenPoint> {
  if (natural.width === 0 || natural.height === 0) return Option.none();

  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  const x = (clientX - box.left - (box.width - width) / 2) / width;
  const y = (clientY - box.top - (box.height - height) / 2) / height;

  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? Option.some({ x, y }) : Option.none();
}
