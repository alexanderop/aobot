import type { Message } from "@aobot/domain";

/** One message. The person's sit right in the accent colour, the Bot's left in grey. */
export function Bubble(props: { readonly message: Message }) {
  const { role, text } = props.message;

  return (
    <div className={`bubble bubble--${role}`}>
      <p className="bubble__text">{text}</p>
    </div>
  );
}
