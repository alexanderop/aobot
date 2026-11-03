import { BotId, ConversationId, RunId } from "@aobot/domain";
import { Headers } from "effect/http";
import { describe, expect, it } from "vite-plus/test";
import { Claim } from "./gateway.ts";
import { claimOf, turnHeaders } from "./mcp.ts";

const bot = BotId.make("assistant");

const turn = { conversation: ConversationId.make("conversation-1"), run: RunId.make("run-1") };

/** The headers `entries` names, as a request carries them. */
function headersOf(entries: ReadonlyArray<{ readonly name: string; readonly value: string }>) {
  return Headers.fromInput(entries.map(({ name, value }) => [name, value] as const));
}

describe("claimOf", () => {
  it("reads the Bot and the turn the acp runtime's headers name", () => {
    expect(claimOf(headersOf(turnHeaders({ bot, ...turn })))).toEqual(
      Claim.cases.Named.make({ bot, turn }),
    );
  });

  it("reads a Bot without a turn when the turn's headers are not both there", () => {
    const [botOnly, conversationOnly] = turnHeaders({ bot, ...turn });

    expect(claimOf(headersOf([botOnly, conversationOnly]))).toEqual(
      Claim.cases.Named.make({ bot }),
    );
  });

  it("keeps a Bot header that is no Bot id as written, and its turn out", () => {
    const [, ...turnOnly] = turnHeaders({ bot, ...turn });

    expect(claimOf(headersOf([{ name: "aobot-bot", value: "Not A Bot" }, ...turnOnly]))).toEqual(
      Claim.cases.Unreadable.make({ header: "Not A Bot" }),
    );
  });

  it("reads no Bot from a call without the Bot header", () => {
    expect(claimOf(headersOf([]))).toEqual(Claim.cases.Unnamed.make({}));
  });
});
