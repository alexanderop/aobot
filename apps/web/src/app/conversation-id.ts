import { ConversationId } from "@aobot/domain";

/** Read `?c=<uuid>`. When it is missing, pick one and write it into the URL without adding a history entry. */
export function conversationIdFromUrl(
  location: Pick<Location, "href">,
  history: Pick<History, "replaceState">,
): ConversationId {
  const url = new URL(location.href);
  const existing = url.searchParams.get("c");

  if (existing !== null && existing !== "") return ConversationId.make(existing);

  const created = ConversationId.make(crypto.randomUUID());

  url.searchParams.set("c", created);
  history.replaceState(null, "", url);

  return created;
}
