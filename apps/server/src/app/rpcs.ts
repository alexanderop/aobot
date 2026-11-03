import {
  ApprovalRpcs,
  BotRpcs,
  ChatRpcs,
  ControlRpcs,
  PauseRpcs,
  ScreenRpcs,
  SecretRpcs,
} from "@aobot/domain";

/** Every RPC the page's socket serves. */
export const serverRpcs = ChatRpcs.merge(
  BotRpcs,
  ScreenRpcs,
  ControlRpcs,
  SecretRpcs,
  ApprovalRpcs,
  PauseRpcs,
);
