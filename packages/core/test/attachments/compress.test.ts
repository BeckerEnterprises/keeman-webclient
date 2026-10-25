import { describe, expect, it } from "vitest";
import {
  gunzip,
  gzip,
  isCompressed,
  packed,
} from "../../src/attachments/compress";
import { utf8Encode } from "../../src/crypto/bytes";
import { sodium } from "../../src/crypto/sodium";

describe("compression of attachments", () => {
  it("knows types that are compressed already", () => {
    for (const mime of [
      "image/png",
      "IMAGE/JPEG",
      "video/mp4",
      "audio/ogg",
      "application/zip",
      "application/gzip",
      "application/x-7z-compressed",
      "application/x-rar-compressed",
      "application/pdf; charset=binary",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/x-xz",
      "application/zstd",
    ])
      expect(isCompressed(mime), mime).toBe(true);
    for (const mime of [
      "image/svg+xml",
      "image/bmp",
      "text/plain",
      "application/octet-stream",
      "application/json",
      "",
    ])
      expect(isCompressed(mime), mime).toBe(false);
  });

  it("compresses only when it saves at least 5 %", async () => {
    const text = utf8Encode("Fantasie-Notiz ".repeat(500));
    const small = await packed(text, "text/plain");
    expect(small.compression).toBe("gzip");
    expect(small.data.length).toBeLessThan(text.length / 10);
    expect(await gunzip(small.data, text.length)).toEqual(text);

    const noise = sodium().randombytes_buf(4096);
    expect(await packed(noise, "application/octet-stream")).toEqual({
      data: noise,
      compression: "none",
    });
    expect((await packed(text, "image/png")).compression).toBe("none");
    expect((await packed(new Uint8Array(0), "text/plain")).compression).toBe(
      "none",
    );
  });

  it("stops unpacking beyond the stated size and on broken data", async () => {
    const bomb = await gzip(new Uint8Array(1_000_000));
    expect(bomb.length).toBeLessThan(10_000);
    expect(await gunzip(bomb, 999_999)).toBeUndefined();
    expect((await gunzip(bomb, 1_000_000))?.length).toBe(1_000_000);
    expect(await gunzip(utf8Encode("not gzip"), 100)).toBeUndefined();
    const cut = bomb.slice(0, bomb.length - 4);
    expect(await gunzip(cut, 1_000_000)).toBeUndefined();
  });
});
