/**
 * Reading a QR code from an image: decoded with the
 * browser, drawn on a canvas at most 4 megapixels large, then jsQR, loaded
 * only now. Light and dark codes are tried (screenshots in dark mode).
 */
const MAX_PIXELS = 4_000_000;

export class QrError extends Error {
  constructor(readonly reason: "image" | "none") {
    super(`QR: ${reason}`);
    this.name = "QrError";
  }
}

/** The text of the first QR code in the image. Throws `QrError`. */
export async function readQrCode(image: Blob): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    throw new QrError("image");
  }
  try {
    const scale = Math.min(
      1,
      Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new QrError("image");
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const { default: jsQR } = await import("jsqr");
    const code = jsQR(pixels.data, width, height, {
      inversionAttempts: "attemptBoth",
    });
    if (!code || code.data === "") throw new QrError("none");
    return code.data;
  } finally {
    bitmap.close();
  }
}

/** The first image of a paste or drop. */
export function imageOf(data: DataTransfer | null): File | undefined {
  return Array.from(data?.files ?? []).find((file) =>
    file.type.startsWith("image/"),
  );
}
