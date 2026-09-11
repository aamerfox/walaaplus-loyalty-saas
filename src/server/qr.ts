import qrcode from "qrcode-generator";

/**
 * QR codes, rendered on the server as inline SVG.
 *
 * Server-side and dependency-free on purpose. The alternative a prototype reaches for is an image
 * URL from a third-party QR service, which sends the encoded value — here, a card's scanner token —
 * to someone else on every page view. That is a data leak dressed as convenience, and it was
 * removed from this codebase once already (Phase 0.3). Inline SVG also renders with no network
 * request at all, which matters on a café's phone signal.
 *
 * Error correction level M (~15%) is the usual choice for a screen: enough tolerance for a
 * fingerprint or a crack, without inflating the module count for a long token.
 */
export interface QrOptions {
  /** Pixel size of one module. 4–8 suits a phone screen. */
  cellSize?: number;
  /** Quiet-zone modules. The spec requires 4; less makes some readers struggle. */
  margin?: number;
}

/**
 * Encode `value` as an SVG element string.
 *
 * Type number 0 lets the library choose the smallest version that fits, so a short token produces
 * a coarse, easily scanned code rather than a dense one.
 */
export function qrSvg(value: string, options: QrOptions = {}): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("QR value must be a non-empty string");

  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({ cellSize: options.cellSize ?? 6, margin: options.margin ?? 4 });
}

/** Module count of the generated symbol. Useful in tests to assert the code actually encodes. */
export function qrModuleCount(value: string): number {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.getModuleCount();
}
