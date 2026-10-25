import type { AttachmentInfo } from "@keeman/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preview, previewKind, saveFile } from "./attachments";

function info(mime: string, size = 10): AttachmentInfo {
  return { id: "a", name: "datei", mime, size, compression: "none" };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachments in the browser", () => {
  it("previews four image types and short text only", () => {
    for (const mime of [
      "image/png",
      "IMAGE/JPEG",
      "image/gif",
      "image/webp; x=y",
    ])
      expect(previewKind(info(mime)), mime).toBe("image");
    expect(previewKind(info("text/plain; charset=utf-8"))).toBe("text");
    expect(previewKind(info("text/plain", 1024 * 1024 + 1))).toBeUndefined();
    for (const mime of ["image/svg+xml", "text/html", "application/pdf", ""])
      expect(previewKind(info(mime)), mime).toBeUndefined();
  });

  it("shows text with replacement characters and images as blob URLs", () => {
    const text = preview(
      info("text/plain"),
      Uint8Array.from([0x48, 0x69, 0xff]),
    );
    expect(text).toEqual({ kind: "text", text: "Hi�", name: "datei" });
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:http://localhost/1");
    const image = preview(info("image/png; x=y"), new Uint8Array(4));
    expect(image).toEqual({
      kind: "image",
      url: "blob:http://localhost/1",
      name: "datei",
    });
    expect((create.mock.calls[0]?.[0] as Blob).type).toBe("image/png");
  });

  it("saves every file as octet-stream under its name", () => {
    vi.useFakeTimers();
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:http://localhost/2");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this);
    });
    saveFile(new Uint8Array(3), "<b>bericht</b>.html");
    saveFile(new Uint8Array(1), "  ");
    expect((create.mock.calls[0]?.[0] as Blob).type).toBe(
      "application/octet-stream",
    );
    expect(clicks.map((a) => a.download)).toEqual([
      "<b>bericht</b>.html",
      "attachment",
    ]);
    expect(document.querySelectorAll("a")).toHaveLength(0);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
