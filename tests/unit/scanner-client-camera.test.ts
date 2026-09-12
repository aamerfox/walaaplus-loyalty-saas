import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * How the counter screen is wired to the camera.
 *
 * `tests/unit/qr-camera.test.ts` proves the decoder behaves; this proves the component uses it,
 * and that the two things a cashier falls back to are still there. Both matter: the iPhone defect
 * was not a decoder bug, it was one condition in this component deciding that a browser without
 * `BarcodeDetector` had no camera.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const CLIENT = path.join(ROOT, "src/app/[locale]/scanner/ScannerClient.tsx");
const source = readFileSync(CLIENT, "utf8");
/** Comments removed: this file explains the defect, which means naming the thing it must not do. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("ScannerClient — the camera", () => {
  it("decides capability through the tested module, not its own check", () => {
    expect(code).toContain("selectQrEngine");
    expect(code).toContain("startQrCamera");
    // The line that told an iPhone it had no camera.
    expect(code).not.toContain("BarcodeDetector");
  });

  it("never opens the camera itself", () => {
    // All camera handling lives in qr-camera.ts, which is where the lifecycle is tested.
    expect(code).not.toContain("getUserMedia");
  });

  it("starts the camera only from the cashier's tap", () => {
    // iOS Safari shows its permission prompt on a user gesture and nowhere else, so a start on
    // mount would be a prompt that never appears — or one that appears and is dismissed.
    expect(code).toContain("onClick={() => (cameraOn ? stopCamera() : void startCamera())}");
    const starts = code.match(/startCamera\(\)/g) ?? [];
    expect(starts, "startCamera is called from exactly one place, the button").toHaveLength(1);
    // And not from an effect.
    expect(code).not.toMatch(/useEffect\([^)]*startCamera/);
  });

  it("releases the camera when the component goes away", () => {
    expect(code).toContain("useEffect(() => stopCamera, [stopCamera])");
  });

  it("guards the decode path against a second lookup", () => {
    expect(code).toContain("decodingRef");
  });

  it("shows the preview before asking for the camera, and waits for the element", () => {
    /*
     * The Huawei defect. Permission was granted and then nothing happened: the component set
     * `cameraOn` in the same tick it acquired the stream, so React had not rendered the <video>
     * and the ref was still null when the stream arrived.
     *
     * Two things fix it, and both are asserted here. The preview is shown BEFORE the camera is
     * requested, so a granted stream is attached to a visible element rather than a
     * `display:none` one that browsers do not reliably play. And a GETTER is passed rather than
     * an element, so `startQrCamera` waits for the ref instead of reading it once.
     */
    const start = code.indexOf("const startCamera");
    const body = code.slice(start, code.indexOf("}, [cameraDeps", start));
    expect(body).toContain("setCameraOn(true)");
    expect(body.indexOf("setCameraOn(true)")).toBeLessThan(body.indexOf("startQrCamera"));
    expect(body).toContain("() => videoRef.current");
  });

  it("keeps the video element mounted so the stream has something to attach to", () => {
    // A version that mounted the element only once `cameraOn` flipped attached the stream to
    // nothing, because React had not re-rendered yet. The decode loop then died on its first
    // frame with no message at all.
    expect(code).toContain("hidden={!cameraOn}");
    expect(code).toContain('data-testid="scanner-video"');
    // iOS refuses to play an inline video without both of these.
    expect(code).toContain("playsInline");
    expect(code).toContain("muted");
  });

  it("still offers the two fallbacks a cashier relies on", () => {
    // Paste or type a code...
    expect(code).toContain('data-testid="scanner-qr-input"');
    expect(code).toContain('data-testid="scanner-qr-lookup"');
    // ...and look the customer up by phone. The tab ids are built from a template, so the
    // literal never appears in the source; the phone tab itself is what must still exist.
    expect(code).toContain("data-testid={`scanner-tab-${key}`}");
    expect(code).toContain('(["qr", "phone"] as const)');
    expect(code).toContain('data-testid="scanner-phone-input"');
    expect(code).toContain('data-testid="scanner-phone-lookup"');
  });

  it("says which thing went wrong, in four separate states", () => {
    for (const key of ["cameraUnsupported", "cameraDenied", "cameraFailed", "cameraScanning"]) {
      expect(code, `the screen must be able to say ${key}`).toContain(`t("${key}")`);
    }
    // The single misleading message all four replace.
    expect(code).not.toContain("cameraUnavailable");
  });

  it("logs nothing", () => {
    // A decoded QR is a capability token and a phone number is customer data. Neither belongs in
    // a browser console, which outlives the tab it was printed in.
    expect(source).not.toMatch(/console\s*\./);
  });

  it("sends no location, still", () => {
    expect(code).not.toContain("locationId");
  });
});

describe("both locales can say all four camera states", () => {
  const en = JSON.parse(readFileSync(path.join(ROOT, "messages/en.json"), "utf8")) as Record<string, Record<string, string>>;
  const ar = JSON.parse(readFileSync(path.join(ROOT, "messages/ar.json"), "utf8")) as Record<string, Record<string, string>>;

  it.each(["cameraUnsupported", "cameraDenied", "cameraFailed", "cameraScanning"])("%s", (key) => {
    expect(en.Scanner[key], `English is missing ${key}`).toBeTruthy();
    expect(ar.Scanner[key], `Arabic is missing ${key}`).toBeTruthy();
    // A translation that is still the English string is a missing translation.
    expect(ar.Scanner[key]).not.toBe(en.Scanner[key]);
    expect(ar.Scanner[key]).toMatch(/[؀-ۿ]/);
  });

  it("drops the message that was misleading", () => {
    expect(en.Scanner.cameraUnavailable).toBeUndefined();
    expect(ar.Scanner.cameraUnavailable).toBeUndefined();
  });
});
