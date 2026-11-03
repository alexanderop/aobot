import { SignedIn } from "@aobot/domain";
import { describe, expect, it } from "vite-plus/test";
import { serverRpcs } from "./rpcs.ts";

describe("the RPCs the socket serves", () => {
  it("each learns who it is for through SignedIn, so none answers signed out", () => {
    const unguarded = [...serverRpcs.requests.values()].flatMap((rpc) =>
      rpc.middlewares.has(SignedIn) ? [] : [rpc._tag],
    );

    expect(unguarded).toEqual([]);
  });
});
