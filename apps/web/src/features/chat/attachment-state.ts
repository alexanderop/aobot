import { Data } from "effect";

/**
A file the person picked in the composer, on its way into the Bot's workspace or already there. Each is
uploaded the moment it is picked, so by the time the message goes the file is waiting for the Bot.
*/
export type Attachment = Data.TaggedEnum<{
  Uploading: { readonly id: string; readonly name: string };
  Ready: { readonly id: string; readonly name: string; readonly path: string };
  Failed: { readonly id: string; readonly name: string; readonly message: string };
}>;

/** Constructors and matchers for {@link Attachment}. */
export const Attachment = Data.taggedEnum<Attachment>();

/** `attachments` with the one whose id `next` has replaced by `next`. */
export function settle(
  attachments: ReadonlyArray<Attachment>,
  next: Attachment,
): ReadonlyArray<Attachment> {
  return attachments.map((attachment) => (attachment.id === next.id ? next : attachment));
}

/** `attachments` without the one with `id`. */
export function without(
  attachments: ReadonlyArray<Attachment>,
  id: string,
): ReadonlyArray<Attachment> {
  return attachments.filter((attachment) => attachment.id !== id);
}

/**
What stays in the composer once a message named the files of `sent` that arrived: every other chip, so a
file that never arrived still says why, and one picked meanwhile waits for the next message.
*/
export function afterSend(
  attachments: ReadonlyArray<Attachment>,
  sent: ReadonlyArray<Attachment>,
): ReadonlyArray<Attachment> {
  const named = new Set(
    sent.flatMap((attachment) => (Attachment.$is("Ready")(attachment) ? [attachment.id] : [])),
  );

  return attachments.filter((attachment) => !named.has(attachment.id));
}

/** Whether a file is still on its way, so a message sent now could not name it. */
export function stillUploading(attachments: ReadonlyArray<Attachment>): boolean {
  return attachments.some(Attachment.$is("Uploading"));
}

/** Whether a message may go with no text of its own: the files in it are a message. */
export function hasReady(attachments: ReadonlyArray<Attachment>): boolean {
  return attachments.some(Attachment.$is("Ready"));
}

function listed(names: ReadonlyArray<string>): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
The message the Bot is sent: what the person typed, then one plain line naming every file that reached
its workspace, so the model knows they are there and where.
*/
export function messageWith(text: string, attachments: ReadonlyArray<Attachment>): string {
  const paths = attachments.flatMap((attachment) =>
    Attachment.$is("Ready")(attachment) ? [attachment.path] : [],
  );

  if (paths.length === 0) return text;

  const line = `I put ${listed(paths)} in your workspace.`;

  return text.trim() === "" ? line : `${text}\n\n${line}`;
}

/**
Whether the message went: `send` of `draft` with a line naming every file that arrived, never while a file
is still on its way, since the message could not name it.
*/
export function sendWith(
  draft: string,
  attachments: ReadonlyArray<Attachment>,
  send: (text: string) => boolean,
): boolean {
  return !stillUploading(attachments) && send(messageWith(draft, attachments));
}
