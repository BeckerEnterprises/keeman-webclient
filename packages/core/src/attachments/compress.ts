/**
 * Compression of attachments: gzip through the Compression Streams
 * API, skipped for types that are compressed already and when it saves
 * less than 5 %. Unpacking stops as soon as the output exceeds the size the
 * entry states, against decompression bombs from a malicious member.
 */

export type Compression = "gzip" | "none";

/** MIME types that are compressed already. */
const COMPRESSED: ReadonlySet<string> = new Set([
  "application/zip",
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/pdf",
  "application/x-xz",
  "application/zstd",
]);

/** Below this saving the file is stored as it is. */
const MIN_SAVING = 0.05;

function mimeType(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

export function isCompressed(mime: string): boolean {
  const type = mimeType(mime);
  if (type.startsWith("image/"))
    return type !== "image/svg+xml" && type !== "image/bmp";
  return (
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type.startsWith("application/vnd.openxmlformats-") ||
    COMPRESSED.has(type)
  );
}

class TooLong extends Error {}

/** `CompressionStream` and `DecompressionStream`. */
interface ByteTransform {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<BufferSource>;
}

/** Pipes `bytes` through a transform; throws `TooLong` beyond `limit`. */
async function through(
  bytes: Uint8Array,
  stream: ByteTransform,
  limit = Infinity,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Errors surface on the reading side; these promises must not dangle.
  void Promise.allSettled([
    writer.write(bytes as Uint8Array<ArrayBuffer>),
    writer.close(),
  ]);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await Promise.allSettled([reader.cancel()]);
      throw new TooLong();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return through(bytes, new CompressionStream("gzip"));
}

/**
 * The unpacked bytes, or `undefined` if the data is no valid gzip or
 * unpacks to more than `limit` bytes.
 */
export async function gunzip(
  bytes: Uint8Array,
  limit: number,
): Promise<Uint8Array | undefined> {
  try {
    return await through(bytes, new DecompressionStream("gzip"), limit);
  } catch {
    return undefined;
  }
}

/** What is encrypted for a file: gzip output or the file itself. */
export async function packed(
  file: Uint8Array,
  mime: string,
): Promise<{ data: Uint8Array; compression: Compression }> {
  if (isCompressed(mime) || file.length === 0)
    return { data: file, compression: "none" };
  const data = await gzip(file);
  return data.length <= file.length * (1 - MIN_SAVING)
    ? { data, compression: "gzip" }
    : { data: file, compression: "none" };
}
