/**
 * Draws a QR code on a canvas, e.g. the key URI of the account
 * TOTP. qrcode-generator is loaded only now; nothing becomes HTML or SVG.
 */

/** Light border around the code, in modules (ISO/IEC 18004). */
const QUIET_ZONE = 4;

/** The modules of the code: `true` is dark. */
export async function qrModules(text: string): Promise<boolean[][]> {
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, column) => qr.isDark(row, column)),
  );
}

/** Black on white whatever the theme, so authenticator apps read it. */
export async function drawQrCode(
  canvas: HTMLCanvasElement,
  text: string,
  scale = 4,
): Promise<void> {
  const modules = await qrModules(text);
  const size = (modules.length + 2 * QUIET_ZONE) * scale;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#000000";
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark)
        context.fillRect(
          (x + QUIET_ZONE) * scale,
          (y + QUIET_ZONE) * scale,
          scale,
          scale,
        );
    });
  });
}
