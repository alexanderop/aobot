import { readFileSync } from "node:fs";
import { BotId } from "@aobot/domain";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { avatarOf } from "./avatar.ts";

const many = Array.from({ length: 200 }, (_, index) => avatarOf(BotId.make(`bot-${index}`)));

const BotsFile = Schema.Struct({ bots: Schema.Array(Schema.Struct({ id: BotId })) });

/** The ids of the Bots in the `bots.yaml` the server starts with. */
function shippedBots(): ReadonlyArray<BotId> {
  const text = readFileSync(new URL("../../../../../bots.yaml", import.meta.url), "utf8");

  return Schema.decodeUnknownSync(BotsFile)(parse(text)).bots.map((bot) => bot.id);
}

describe("avatarOf", () => {
  it("draws the same character for the same id every time", () => {
    expect(avatarOf(BotId.make("researcher"))).toEqual(avatarOf(BotId.make("researcher")));
  });

  it("draws Bots as many different characters", () => {
    const looks = many.map(({ body, colour, gaze }) => `${body} ${colour} ${gaze.x},${gaze.y}`);

    expect(new Set(many.map((avatar) => avatar.body)).size).toBeGreaterThan(1);
    expect(new Set(many.map((avatar) => avatar.colour)).size).toBeGreaterThan(1);
    expect(new Set(many.map((avatar) => `${avatar.gaze.x},${avatar.gaze.y}`)).size).toBeGreaterThan(
      1,
    );
    expect(new Set(looks).size).toBeGreaterThan(many.length / 2);
  });

  it("gives each Bot in bots.yaml a colour of its own", () => {
    const bots = shippedBots();

    expect(bots.length).toBeGreaterThan(1);
    expect(new Set(bots.map((bot) => avatarOf(bot).colour)).size).toBe(bots.length);
  });
});
