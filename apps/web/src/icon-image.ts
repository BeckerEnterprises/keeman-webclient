/**
 * Re-encoding icons in the browser: any image the browser can
 * decode, SVG included, drawn into 64 × 64 px with a transparent border and
 * saved as PNG. Raster images are decoded with `createImageBitmap`, SVG
 * through an `<img>` from a `blob:` URL; nothing is kept as SVG or HTML.
 * The core gets the finished PNG bytes.
 */
import { ICON_SIZE } from "@keeman/core";

/** Largest file to upload. */
export const MAX_ICON_FILE_BYTES = 5 * 1024 * 1024;
/** Longest side after decoding. */
const MAX_SIDE = 4096;

export class IconImageError extends Error {
  constructor(readonly reason: "too_large" | "unreadable") {
    super(`Icon: ${reason}`);
    this.name = "IconImageError";
  }
}

export interface IconFit {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Smoothing when shrinking; growing keeps the pixels sharp. */
  smooth: boolean;
}

/**
 * Size and position inside the 64 × 64 square, as the server
 * computes them: fitted with the aspect ratio, centred; smaller images grow
 * only by a whole factor.
 */
export function fitIcon(width: number, height: number): IconFit {
  const longest = Math.max(width, height, 1);
  const shrink = longest > ICON_SIZE;
  const scale = (side: number) =>
    shrink
      ? Math.max(
          1,
          Math.floor((side * ICON_SIZE + Math.floor(longest / 2)) / longest),
        )
      : side * Math.floor(ICON_SIZE / longest);
  const fitted = { width: scale(width), height: scale(height) };
  return {
    x: Math.floor((ICON_SIZE - fitted.width) / 2),
    y: Math.floor((ICON_SIZE - fitted.height) / 2),
    ...fitted,
    smooth: shrink,
  };
}

/** SVG by its type or, without one, by its first characters. */
async function isSvg(image: Blob): Promise<boolean> {
  if (image.type === "image/svg+xml") return true;
  if (image.type !== "") return false;
  const start = new TextDecoder()
    .decode(await image.slice(0, 256).arrayBuffer())
    .replace(/^\uFEFF/, "")
    .trimStart();
  return /^<(\?xml|svg|!--)/i.test(start);
}

/** An SVG through an `<img>` (the only way to rasterise it). */
async function svgImage(
  image: Blob,
): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  const url = URL.createObjectURL(image);
  try {
    const element = new Image();
    element.decoding = "async";
    element.src = url;
    await element.decode();
    // Without a size of its own it is drawn as a square.
    return {
      source: element,
      width: element.naturalWidth || ICON_SIZE,
      height: element.naturalHeight || ICON_SIZE,
    };
  } catch {
    throw new IconImageError("unreadable");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Raster images through `createImageBitmap`: unlike an `<img>` from a
 * `blob:` URL, a broken file causes no CSP report in Chromium.
 */
async function rasterImage(
  image: Blob,
): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(image);
    return { source: bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    throw new IconImageError("unreadable");
  }
}

function pngOf(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new IconImageError("unreadable"));
    }, "image/png");
  });
}

/** The image as icon PNG bytes; throws `IconImageError`. */
export async function encodeIcon(image: Blob): Promise<Uint8Array> {
  if (image.size > MAX_ICON_FILE_BYTES) throw new IconImageError("too_large");
  const { source, width, height } = (await isSvg(image))
    ? await svgImage(image)
    : await rasterImage(image);
  try {
    if (width > MAX_SIDE || height > MAX_SIDE)
      throw new IconImageError("too_large");
    const fit = fitIcon(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new IconImageError("unreadable");
    context.imageSmoothingEnabled = fit.smooth;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, fit.x, fit.y, fit.width, fit.height);
    return new Uint8Array(await (await pngOf(canvas)).arrayBuffer());
  } finally {
    if (source instanceof ImageBitmap) source.close();
  }
}

/**
 * Custom icons of a KDBX file, re-encoded by UUID; one that cannot be read
 * is left out, and the import reports it.
 */
export async function encodeIcons(
  icons: readonly { uuid: string; data: Uint8Array }[],
): Promise<Map<string, Uint8Array>> {
  const encoded = new Map<string, Uint8Array>();
  for (const icon of icons)
    try {
      encoded.set(icon.uuid, await encodeIcon(new Blob([icon.data.slice()])));
    } catch {
      // Unreadable: the plan keeps the standard icon.
    }
  return encoded;
}
