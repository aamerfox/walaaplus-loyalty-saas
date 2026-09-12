/**
 * Camera QR decoding for the counter, on the two browsers a cashier actually holds.
 *
 * A real iPhone in Safari showed "The camera is not available on this device or browser" **before
 * any permission prompt**. That was not a device problem or a setting: the scanner supported only
 * the native `BarcodeDetector`, which Safari does not implement, and treated its absence as "no
 * camera". Android worked, iOS was told it had no camera, and the manual gate for Phase 1a could
 * not be completed on half the phones in the pilot.
 *
 * So there are two engines now:
 *
 *   native    `BarcodeDetector`, where the browser has one. Nothing is downloaded, decoding is in
 *             the browser's own code, and it is the fast path on Android Chrome.
 *   fallback  ZXing, imported dynamically and only when the native detector is missing. It costs
 *             a download, which is why it is not the default, and it is the only way iOS Safari
 *             scans anything at all.
 *
 * **Everything stays on the device.** Frames are decoded in the page; no image, no frame and no
 * decoded value leaves the browser except through the existing same-origin lookup the cashier
 * already triggers by typing a code. There is no scanning service, and nothing is logged.
 *
 * This module takes its browser capabilities as INJECTED dependencies rather than reading
 * `window` and `navigator` directly. That is what makes "Safari has getUserMedia but no
 * BarcodeDetector" a test rather than a thing we find out from a merchant. `ScannerClient` wires
 * the real ones.
 */

/** The browser's own detector, narrowed to the one method used here. */
export interface NativeDetector {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
}

/** What ZXing's `decodeFromStream` hands back. */
export interface FallbackControls {
  stop: () => void;
}

export interface FallbackReader {
  decodeFromStream: (
    stream: MediaStream,
    video: HTMLVideoElement,
    callback: (result?: { getText: () => string } | undefined, error?: unknown, controls?: FallbackControls) => void,
  ) => Promise<FallbackControls>;
}

export type QrEngine = "native" | "fallback";

/**
 * Why the camera cannot be used. Each maps to its own sentence on screen, because "camera
 * unavailable" for a denied permission sends a cashier to look for a broken camera.
 */
export type QrCameraFailure = "unsupported" | "denied" | "failed";

export interface QrCameraDeps {
  /** Present on every browser that can open a camera at all. Absent in an insecure context. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Constructs the browser's native detector. Undefined where there is none — iOS Safari. */
  createNativeDetector?: () => NativeDetector;
  /** Dynamically imports the decoder. Never called unless the native detector is missing. */
  loadFallbackReader: () => Promise<FallbackReader>;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
}

export type QrCameraStart =
  | { ok: true; engine: QrEngine; stop: () => void }
  | { ok: false; failure: QrCameraFailure };

/**
 * Where to find the preview element. A function, not an element, because the caller may not have
 * one yet — see `resolveVideo`.
 */
export type VideoSource = HTMLVideoElement | (() => HTMLVideoElement | null);

/**
 * How many frames to wait for the preview element before giving up. At 60fps this is about two
 * seconds: long enough for a render that is waiting behind a permission prompt, short enough that
 * a cashier is told something rather than left holding a dead button.
 */
const MOUNT_WAIT_FRAMES = 120;

/**
 * Wait until the preview element exists.
 *
 * This is the Android defect, and it is a different bug from the iPhone one. On a Huawei the
 * permission prompt appeared, permission was GRANTED, and then nothing happened: no preview, no
 * scanning. The component rendered its `<video>` conditionally and set that condition in the same
 * tick it acquired the stream, so when the stream arrived React had not re-rendered yet and the
 * ref was still null. The old code read `videoRef.current`, found nothing, and quietly returned —
 * leaving an approved camera stream attached to nothing, with the camera light on.
 *
 * A granted permission followed by silence is the worst failure of the three, because the person
 * has already done the only thing they were asked to do.
 */
async function resolveVideo(source: VideoSource, deps: QrCameraDeps): Promise<HTMLVideoElement | null> {
  if (typeof source !== "function") return source;

  const immediate = source();
  if (immediate) return immediate;

  return new Promise<HTMLVideoElement | null>((resolve) => {
    let remaining = MOUNT_WAIT_FRAMES;
    const look = () => {
      const video = source();
      if (video) {
        resolve(video);
        return;
      }
      remaining -= 1;
      if (remaining <= 0) {
        resolve(null);
        return;
      }
      deps.requestFrame(look);
    };
    deps.requestFrame(look);
  });
}

/**
 * Which engine this browser can use, without touching the camera.
 *
 * Called before the cashier taps, only to decide what to show. It asks no permission and starts
 * no stream: capability and consent are different questions, and conflating them is what produced
 * the message on the iPhone.
 */
export function selectQrEngine(deps: Pick<QrCameraDeps, "getUserMedia" | "createNativeDetector">): QrEngine | "unsupported" {
  if (!deps.getUserMedia) return "unsupported";
  return deps.createNativeDetector ? "native" : "fallback";
}

/** `NotAllowedError` is what every browser raises when the person says no. */
function isPermissionDenial(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError";
}

/**
 * Open the camera and decode until something is found, or until `stop()`.
 *
 * Call this from a user gesture: iOS Safari will only show its permission prompt then, and a
 * prompt that appears on page load gets dismissed.
 *
 * `videoSource` may be a function returning the element, which is what the component passes: the
 * preview can still be rendering while the permission prompt is up, and attaching a granted
 * stream to a ref that is still null is exactly how an Android phone ends up with permission
 * granted, the camera light on, and no preview.
 *
 * `onDecode` fires **at most once**, after everything has been released. A scan that produced two
 * lookups would be two requests for one intent, and on a redeem that is the difference between a
 * free coffee and two.
 */
export async function startQrCamera(
  deps: QrCameraDeps,
  videoSource: VideoSource,
  onDecode: (value: string) => void,
): Promise<QrCameraStart> {
  const { getUserMedia } = deps;
  if (!getUserMedia) return { ok: false, failure: "unsupported" };

  let stream: MediaStream;
  try {
    // `ideal`, not `exact`: prefer the rear camera at a counter, but a laptop with only a front
    // camera should still scan rather than throw.
    stream = await getUserMedia({ video: { facingMode: { ideal: "environment" } } });
  } catch (error) {
    return { ok: false, failure: isPermissionDenial(error) ? "denied" : "failed" };
  }

  // The preview element, which may still be rendering while the permission prompt is up.
  const video = await resolveVideo(videoSource, deps);
  if (!video) {
    // An approved stream with nowhere to show it. Hand the camera back rather than hold it open
    // behind a blank screen.
    for (const track of stream.getTracks()) track.stop();
    return { ok: false, failure: "failed" };
  }

  let frame: number | null = null;
  let controls: FallbackControls | null = null;
  let finished = false;

  /**
   * Idempotent, and safe to call from anywhere: the unmount effect, the stop button, the decode
   * path, and the error path all end here. Every one of them must leave no track recording — a
   * camera light that stays on after a scan is both a bug and the kind of thing a cashier
   * reasonably refuses to use.
   */
  const release = () => {
    if (finished) return;
    finished = true;
    if (frame !== null) {
      deps.cancelFrame(frame);
      frame = null;
    }
    try {
      controls?.stop();
    } catch {
      // A decoder that throws while stopping must not prevent the tracks below from stopping.
    }
    controls = null;
    for (const track of stream.getTracks()) track.stop();
    if (video.srcObject === stream) video.srcObject = null;
  };

  const finish = (value: string) => {
    if (finished) return;
    release();
    onDecode(value);
  };

  try {
    video.srcObject = stream;
    // Safari rejects this promise if the element is not yet visible or the gesture has expired.
    // A failure to autoplay is not a failure to scan, so it is swallowed rather than surfaced.
    await video.play().catch(() => undefined);

    const native = deps.createNativeDetector?.();
    if (native) {
      const tick = async () => {
        if (finished) return;
        try {
          const codes = await native.detect(video);
          const value = codes[0]?.rawValue;
          if (value) {
            finish(value);
            return;
          }
        } catch {
          // A frame that cannot be decoded is the normal case between codes, not an error.
        }
        if (!finished) frame = deps.requestFrame(() => void tick());
      };
      void tick();
      return { ok: true, engine: "native", stop: release };
    }

    const reader = await deps.loadFallbackReader();
    if (finished) {
      // Stopped while the decoder was still downloading. Release ran already; do not start it.
      return { ok: false, failure: "failed" };
    }
    controls = await reader.decodeFromStream(stream, video, (result) => {
      const value = result?.getText();
      if (value) finish(value);
      // Every other callback is a frame without a code. ZXing reports those as errors; they are
      // not, and showing them would put a warning on screen several times a second.
    });
    if (finished) controls.stop();
    return { ok: true, engine: "fallback", stop: release };
  } catch {
    release();
    return { ok: false, failure: "failed" };
  }
}

/**
 * The real browser capabilities, read once per call.
 *
 * `BarcodeDetector` is looked up rather than referenced so TypeScript does not need a DOM lib
 * that not every target has, and so a browser that adds it later is picked up with no change
 * here.
 */
export function browserQrCameraDeps(): QrCameraDeps {
  const detectorCtor = (globalThis as unknown as {
    BarcodeDetector?: new (options: { formats: string[] }) => NativeDetector;
  }).BarcodeDetector;

  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;

  return {
    getUserMedia: media?.getUserMedia ? (constraints) => media.getUserMedia(constraints) : undefined,
    createNativeDetector: detectorCtor ? () => new detectorCtor({ formats: ["qr_code"] }) : undefined,
    // Imported here and nowhere else, so the decoder is downloaded only by a browser that opens
    // the camera without a native detector.
    loadFallbackReader: async () => {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      return new BrowserQRCodeReader() as unknown as FallbackReader;
    },
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
  };
}
