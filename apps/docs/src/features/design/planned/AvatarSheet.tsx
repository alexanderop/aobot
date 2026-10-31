import { Avatar, characters } from "./Avatar.tsx";
import "./planned.css";

/** Planned in E2-1: every character side by side. Colour and shape tell Bots apart at a glance. */
export function AvatarSheet() {
  return (
    <div className="sheet">
      {Object.entries(characters).map(([name, character]) => (
        <figure key={name} className="sheet__item">
          <Avatar character={character} size={76} />
          <figcaption>{name}</figcaption>
        </figure>
      ))}
    </div>
  );
}
