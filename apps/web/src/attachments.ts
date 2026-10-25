/**
 * Showing and saving attachments in the browser: previews
 * only for four image types in `<img>` and for short plain text, never as
 * HTML or SVG; downloads always as `application/octet-stream`.
 */
import type { AttachmentInfo } from "@keeman/core";

const IMAGES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** Larger text files are only downloaded. */
export const TEXT_PREVIEW_BYTES = 1024 * 1024;

export type Preview =
  | { kind: "image"; url: string; name: string }
  | { kind: "text"; text: string; name: string };

function mimeType(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether a preview exists; the type comes from the entry and is untrusted. */
export function previewKind(
  info: AttachmentInfo,
): "image" | "text" | undefined {
  const type = mimeType(info.mime);
  if (IMAGES.has(type)) return "image";
  if (type === "text/plain" && info.size <= TEXT_PREVIEW_BYTES) return "text";
  return undefined;
}

/** The preview of decrypted bytes; an image URL must be revoked later. */
export function preview(info: AttachmentInfo, bytes: Uint8Array): Preview {
  if (previewKind(info) === "image")
    return {
      kind: "image",
      url: URL.createObjectURL(
        new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: mimeType(info.mime),
        }),
      ),
      name: info.name,
    };
  // Invalid UTF-8 becomes the replacement character.
  return {
    kind: "text",
    text: new TextDecoder().decode(bytes),
    name: info.name,
  };
}

/** Saves bytes as a file; the browser never renders them. */
export function saveFile(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], {
      type: "application/octet-stream",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name.trim() === "" ? "attachment" : name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers start the download only after the click returns.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}
