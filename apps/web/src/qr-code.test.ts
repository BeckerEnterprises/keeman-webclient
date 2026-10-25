import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { qrModules } from "./qr-code";

describe("QR code display", () => {
  it("encodes a key URI that jsQR reads back", async () => {
    const uri =
      "otpauth://totp/KeeMan:alice%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=KeeMan";
    const modules = await qrModules(uri);
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.every((row) => row.length === modules.length)).toBe(true);
    // Render 4 px per module with a quiet zone and decode it again.
    const scale = 4;
    const size = (modules.length + 8) * scale;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (!dark) return;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const offset =
              ((y + 4) * scale + dy) * size * 4 + ((x + 4) * scale + dx) * 4;
            pixels.fill(0, offset, offset + 3);
          }
      });
    });
    expect(jsQR(pixels, size, size)?.data).toBe(uri);
  });
});
