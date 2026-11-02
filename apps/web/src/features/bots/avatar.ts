import type { BotId } from "@aobot/domain";

/**
The body shapes a Bot can have, each a soft blob in a 64 by 64 box with room for two eyes around y = 28.
Ours, drawn for aobot: a round one, a ghost, a squircle, a bean and a lumpy one.
*/
const bodies = [
  "M32 6C47 6 58 16 58 31C58 47 47 58 32 58C17 58 6 47 6 31C6 16 17 6 32 6Z",
  "M32 5C46 5 55 16 55 30V52C55 56 51 58 48 55L44 52L40 56C38 58 35 58 33 56L32 55L31 56C29 58 26 58 24 56L20 52L16 55C13 58 9 56 9 52V30C9 16 18 5 32 5Z",
  "M14 10C22 4 42 4 50 10C58 17 59 44 51 52C43 59 21 59 13 52C5 44 6 17 14 10Z",
  "M34 6C50 8 59 22 57 38C55 52 43 59 30 58C16 57 6 47 7 33C8 18 19 4 34 6Z",
  "M32 6C38 6 41 10 46 11C52 12 57 17 57 24C57 29 54 32 55 37C56 44 51 52 44 55C39 57 36 58 32 58C27 58 22 57 18 54C11 50 7 44 8 36C9 31 7 28 7 23C8 15 14 10 21 9C25 8 27 6 32 6Z",
] as const;

/** Solid colours that each read on `--sidebar` and `--bg`, with dark eyes on them. */
const colours = [
  "#3fa592",
  "#e5766b",
  "#f2b84b",
  "#7c8cf2",
  "#c084fc",
  "#5fb8e6",
  "#9bd36a",
  "#f28cb1",
  "#5cc98a",
  "#df7fdb",
] as const;

/** Where the pupils look, as an offset from the middle of each eye. */
const gazes = [
  { x: 0, y: 0 },
  { x: -1.5, y: 0.5 },
  { x: 1.5, y: 0.5 },
  { x: 0, y: -1.5 },
] as const;

/** How a Bot looks: its body, its colour and where it looks, all drawn from its id. */
export interface Avatar {
  readonly body: string;
  readonly colour: string;
  readonly gaze: { readonly x: number; readonly y: number };
}

/** FNV-1a, so the same id always draws the same character, on every page and every machine. */
function hash(text: string): number {
  let value = 0x811c9dc5;

  for (const character of text) {
    value = Math.imul(value ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }

  return value;
}

function pick<A>(options: ReadonlyArray<A>, seed: number): A {
  // SAFETY: a remainder of the length is always an index into a non-empty list.
  return options[seed % options.length] as A;
}

/** The character `bot` is drawn as. */
export function avatarOf(bot: BotId): Avatar {
  const seed = hash(bot);

  return {
    body: pick(bodies, seed),
    colour: pick(colours, Math.floor(seed / bodies.length)),
    gaze: pick(gazes, Math.floor(seed / (bodies.length * colours.length))),
  };
}
