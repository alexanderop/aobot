import type { BotId } from "@aobot/domain";
import { avatarOf } from "./avatar.ts";

/** A Bot's character: a soft blob in its colour with two eyes, drawn from its id. Decorative. */
export function BotAvatar(props: { readonly bot: BotId; readonly size: number }) {
  const { body, colour, gaze } = avatarOf(props.bot);

  return (
    <svg
      className="bot-avatar"
      width={props.size}
      height={props.size}
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      <path d={body} fill={colour} />
      {[24, 40].map((x) => (
        <g key={x}>
          <ellipse cx={x} cy={28} rx={5.5} ry={6.5} fill="#fff" />
          <circle cx={x + gaze.x} cy={29 + gaze.y} r={3} fill="#141415" />
        </g>
      ))}
    </svg>
  );
}
