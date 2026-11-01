import type { ConversationId } from "@aobot/domain";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { useCallback } from "react";
import { type Attachment, afterSend, sendWith, without } from "./attachment-state.ts";
import { attach as attachAtom, attachments as attachmentsAtom } from "./attachments.ts";

/** The files the person put in a conversation's composer for the Bot's workspace, and what they can do with them. */
export interface UseAttachments {
  readonly attachments: ReadonlyArray<Attachment>;
  /** Uploads each file into the workspace now. */
  readonly attach: (files: ReadonlyArray<File>) => void;
  /** Takes a chip out of the composer and stops its upload. A file that arrived stays in the workspace. */
  readonly dismiss: (id: string) => void;
  /**
  Sends `draft` through `send` with a line naming every file that arrived, then clears those chips. False,
  with every chip kept, while a file is still on its way or when `send` did not take the message.
  */
  readonly send: (draft: string) => boolean;
}

/** A conversation's attachments, shaped like the other chat hooks: values and functions. */
export function useAttachments(
  conversation: ConversationId,
  send: (text: string) => boolean,
): UseAttachments {
  const [attachments, setAttachments] = useAtom(attachmentsAtom(conversation));
  const upload = useAtomSet(attachAtom(conversation));

  return {
    attachments,
    attach: useCallback((files: ReadonlyArray<File>) => files.forEach(upload), [upload]),
    dismiss: useCallback(
      (id: string) => setAttachments((current) => without(current, id)),
      [setAttachments],
    ),
    send: useCallback(
      (draft: string) => {
        if (!sendWith(draft, attachments, send)) return false;

        setAttachments((current) => afterSend(current, attachments));

        return true;
      },
      [attachments, send, setAttachments],
    ),
  };
}
