import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { pointOnFrame } from "./point-on-frame.ts";

const frame = { width: 1280, height: 800 };

describe("pointOnFrame", () => {
  it("reads a click on a frame that fills its box as fractions of it", () => {
    const box = { left: 100, top: 50, width: 640, height: 400 };

    expect(pointOnFrame(100, 50, box, frame)).toEqual(Option.some({ x: 0, y: 0 }));
    expect(pointOnFrame(420, 250, box, frame)).toEqual(Option.some({ x: 0.5, y: 0.5 }));
    expect(pointOnFrame(740, 450, box, frame)).toEqual(Option.some({ x: 1, y: 1 }));
  });

  it("leaves out the bars above and below a frame in a taller box", () => {
    const box = { left: 0, top: 0, width: 640, height: 600 };

    expect(pointOnFrame(320, 300, box, frame)).toEqual(Option.some({ x: 0.5, y: 0.5 }));
    expect(pointOnFrame(160, 150, box, frame)).toEqual(Option.some({ x: 0.25, y: 0.125 }));
    expect(pointOnFrame(320, 50, box, frame)).toEqual(Option.none());
    expect(pointOnFrame(320, 550, box, frame)).toEqual(Option.none());
  });

  it("leaves out the bars beside a frame in a wider box", () => {
    const box = { left: 0, top: 0, width: 1000, height: 400 };

    expect(pointOnFrame(500, 200, box, frame)).toEqual(Option.some({ x: 0.5, y: 0.5 }));
    expect(pointOnFrame(100, 200, box, frame)).toEqual(Option.none());
    expect(pointOnFrame(900, 200, box, frame)).toEqual(Option.none());
  });

  it("reads nothing before the frame has a size", () => {
    expect(
      pointOnFrame(10, 10, { left: 0, top: 0, width: 640, height: 400 }, { width: 0, height: 0 }),
    ).toEqual(Option.none());
  });
});
