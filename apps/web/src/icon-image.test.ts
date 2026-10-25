import { describe, expect, it } from "vitest";
import { fitIcon } from "./icon-image";

describe("icon fit", () => {
  it("matches the server's rules", () => {
    const cases: [number, number, number, number, number, number, boolean][] = [
      [16, 16, 0, 0, 64, 64, false],
      [48, 48, 8, 8, 48, 48, false],
      [20, 10, 2, 17, 60, 30, false],
      [64, 64, 0, 0, 64, 64, false],
      [512, 256, 0, 16, 64, 32, true],
      [1000, 3, 0, 31, 64, 1, true],
      [100, 50, 0, 16, 64, 32, true],
      [65, 64, 0, 0, 64, 63, true],
    ];
    for (const [width, height, x, y, w, h, smooth] of cases)
      expect(
        fitIcon(width, height),
        `${String(width)}×${String(height)}`,
      ).toEqual({ x, y, width: w, height: h, smooth });
  });

  it("keeps odd sizes inside the square", () => {
    for (const [width, height] of [
      [1, 1],
      [33, 1],
      [63, 17],
      [4096, 1],
      [3, 4096],
    ] as const) {
      const fit = fitIcon(width, height);
      expect(fit.x).toBeGreaterThanOrEqual(0);
      expect(fit.y).toBeGreaterThanOrEqual(0);
      expect(fit.x + fit.width).toBeLessThanOrEqual(64);
      expect(fit.y + fit.height).toBeLessThanOrEqual(64);
      expect(Math.min(fit.width, fit.height)).toBeGreaterThanOrEqual(1);
    }
    // 33 px grow by no whole factor: they stay as they are.
    expect(fitIcon(33, 1)).toEqual({
      x: 15,
      y: 31,
      width: 33,
      height: 1,
      smooth: false,
    });
  });
});
