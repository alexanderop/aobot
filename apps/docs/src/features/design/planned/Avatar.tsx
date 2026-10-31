/** Planned in E2-1. Each silhouette is a soft blob drawn in a 100 by 100 box. */
const silhouettes = {
  round: "M50 6C74 6 94 26 94 50S74 94 50 94 6 74 6 50 26 6 50 6Z",
  squircle: "M32 7H68C88 7 93 12 93 32V68C93 88 88 93 68 93H32C12 93 7 88 7 68V32C7 12 12 7 32 7Z",
  bean: "M54 6C79 5 96 28 92 53C88 79 69 95 45 92C20 89 5 70 9 45C13 21 31 7 54 6Z",
  arch: "M50 5C77 5 93 25 93 52V77C93 88 88 95 77 95H23C12 95 7 88 7 77V52C7 25 23 5 50 5Z",
  drop: "M50 4C61 24 93 38 93 63C93 83 74 96 50 96C26 96 7 83 7 63C7 38 39 24 50 4Z",
  cloud: "M27 88C9 88 3 66 17 55C13 37 31 24 47 32C56 12 84 19 83 41C99 46 101 80 80 88Z",
} as const;

type Silhouette = keyof typeof silhouettes;

/** How the two eyes sit: their gap, their height and their size are what give a Bot its look. */
interface Eyes {
  readonly gap: number;
  readonly y: number;
  readonly size: number;
}

/** One Bot's character: a shape, one solid colour, and a pair of eyes. */
export interface Character {
  readonly silhouette: Silhouette;
  readonly colour: string;
  readonly eyes: Eyes;
}

/** The characters, by name. A Bot picks one; the colour and silhouette tell Bots apart at a glance. */
export const characters = {
  amber: { silhouette: "squircle", colour: "#e4b04f", eyes: { gap: 15, y: 46, size: 6 } },
  coral: { silhouette: "bean", colour: "#ec8a78", eyes: { gap: 13, y: 52, size: 7 } },
  sage: { silhouette: "round", colour: "#93c487", eyes: { gap: 16, y: 48, size: 5.5 } },
  sky: { silhouette: "arch", colour: "#76b6ea", eyes: { gap: 14, y: 42, size: 6.5 } },
  lilac: { silhouette: "cloud", colour: "#ac9be6", eyes: { gap: 12, y: 54, size: 6 } },
  rose: { silhouette: "drop", colour: "#ea96b8", eyes: { gap: 15, y: 62, size: 6.5 } },
  mint: { silhouette: "squircle", colour: "#62d0b6", eyes: { gap: 19, y: 50, size: 5 } },
  sand: { silhouette: "round", colour: "#dba67f", eyes: { gap: 11, y: 50, size: 7.5 } },
} as const satisfies Record<string, Character>;

/** The name of a character. */
export type CharacterName = keyof typeof characters;

const eyeColour = "#17171a";

/** A Bot's face: a soft blob in one solid colour with two eyes. */
export function Avatar(props: { readonly character: Character; readonly size: number }) {
  const { silhouette, colour, eyes } = props.character;
  const left = 50 - eyes.gap;
  const right = 50 + eyes.gap;

  return (
    <svg
      className="avatar"
      width={props.size}
      height={props.size}
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      <path d={silhouettes[silhouette]} fill={colour} />
      <ellipse cx={left} cy={eyes.y} rx={eyes.size} ry={eyes.size * 1.25} fill={eyeColour} />
      <ellipse cx={right} cy={eyes.y} rx={eyes.size} ry={eyes.size * 1.25} fill={eyeColour} />
      <circle
        cx={left + eyes.size * 0.3}
        cy={eyes.y - eyes.size * 0.4}
        r={eyes.size * 0.28}
        fill="#fff"
      />
      <circle
        cx={right + eyes.size * 0.3}
        cy={eyes.y - eyes.size * 0.4}
        r={eyes.size * 0.28}
        fill="#fff"
      />
    </svg>
  );
}
