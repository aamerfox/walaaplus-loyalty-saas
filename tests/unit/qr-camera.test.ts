import { describe, expect, it, vi } from "vitest";
import {
  selectQrEngine,
  startQrCamera,
  type FallbackControls,
  type FallbackReader,
  type QrCameraDeps,
} from "@/app/[locale]/scanner/qr-camera";

/**
 * The iPhone defect, as a test.
 *
 * On a real iPhone in Safari the scanner said "The camera is not available on this device or
 * browser" **before any permission prompt**, on a phone with two working cameras. The cause was a
 * single condition: the code required `BarcodeDetector`, which Safari does not implement, and
 * treated its absence as "no camera". Android was fine; iOS was told it had no camera; and the
 * Phase 1a manual gate could not be completed on half the phones in the pilot.
 *
 * These tests drive the decoder with injected browser capabilities, which is the whole reason
 * `qr-camera.ts` takes them as dependencies. A Safari-like environment — `getUserMedia` present,
 * `BarcodeDetector` absent — is one object literal here and a device nobody on this project owns
 * otherwise.
 *
 * **Mocks are not a real iPhone.** They prove the selection and the lifecycle; they cannot prove
 * that Safari's camera pipeline decodes a printed QR at arm's length. That remains a MANUAL check
 * on real hardware, and it is listed as unperformed in the evidence.
 */

// ── fakes ─────────────────────────────────────────────────────────────────────────────────────

function fakeTrack() {
  return { stop: vi.fn(), kind: "video" } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}

function fakeStream(tracks: ReturnType<typeof fakeTrack>[]) {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

function fakeVideo() {
  return {
    srcObject: null as MediaStream | null,
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as HTMLVideoElement & { play: ReturnType<typeof vi.fn> };
}

/** A frame scheduler the test drives by hand, so no loop can outlive an assertion. */
function manualFrames() {
  const queue = new Map<number, () => void>();
  let next = 1;
  return {
    cancelled: [] as number[],
    request: (callback: () => void) => {
      const handle = next++;
      queue.set(handle, callback);
      return handle;
    },
    cancel(handle: number) {
      this.cancelled.push(handle);
      queue.delete(handle);
    },
    pending: () => queue.size,
    /** Run every queued callback once. */
    async flush() {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

interface Harness {
  deps: QrCameraDeps;
  tracks: ReturnType<typeof fakeTrack>[];
  video: ReturnType<typeof fakeVideo>;
  frames: ReturnType<typeof manualFrames>;
  fallbackControls: FallbackControls & { stop: ReturnType<typeof vi.fn> };
  fallbackLoads: number;
  emitFallback: (text: string) => void;
  detect: ReturnType<typeof vi.fn>;
}

function harness(options: { native?: boolean; getUserMedia?: QrCameraDeps["getUserMedia"] } = {}): Harness {
  const tracks = [fakeTrack(), fakeTrack()];
  const stream = fakeStream(tracks);
  const video = fakeVideo();
  const frames = manualFrames();
  const fallbackControls = { stop: vi.fn() };
  const detect = vi.fn().mockResolvedValue([]);

  let emit: (text: string) => void = () => {};
  const state = { fallbackLoads: 0 };

  const reader: FallbackReader = {
    decodeFromStream: async (_stream, _video, callback) => {
      emit = (text: string) => callback({ getText: () => text }, undefined, fallbackControls);
      return fallbackControls;
    },
  };

  const deps: QrCameraDeps = {
    getUserMedia:
      "getUserMedia" in options ? options.getUserMedia : vi.fn().mockResolvedValue(stream),
    createNativeDetector: options.native ? () => ({ detect }) : undefined,
    loadFallbackReader: async () => {
      state.fallbackLoads += 1;
      return reader;
    },
    requestFrame: frames.request,
    cancelFrame: (handle) => frames.cancel(handle),
  };

  return {
    deps,
    tracks,
    video,
    frames,
    fallbackControls,
    get fallbackLoads() {
      return state.fallbackLoads;
    },
    emitFallback: (text) => emit(text),
    detect,
  };
}

// ── engine selection: the actual defect ───────────────────────────────────────────────────────

describe("selectQrEngine", () => {
  it("chooses the fallback decoder in a Safari-like browser", () => {
    // getUserMedia present, BarcodeDetector absent. This is an iPhone.
    const engine = selectQrEngine({ getUserMedia: vi.fn(), createNativeDetector: undefined });
    expect(engine).toBe("fallback");
    // And emphatically not the answer that shipped.
    expect(engine).not.toBe("unsupported");
  });

  it("prefers the native detector when the browser has one", () => {
    // Android Chrome: nothing is downloaded and decoding stays in the browser's own code.
    expect(selectQrEngine({ getUserMedia: vi.fn(), createNativeDetector: () => ({ detect: vi.fn() }) })).toBe("native");
  });

  it("reports unsupported only when there is no camera API at all", () => {
    // An insecure context, or a browser with no getUserMedia. Now the message is true.
    expect(selectQrEngine({ getUserMedia: undefined, createNativeDetector: undefined })).toBe("unsupported");
    expect(selectQrEngine({ getUserMedia: undefined, createNativeDetector: () => ({ detect: vi.fn() }) })).toBe(
      "unsupported",
    );
  });

  it("asks for no camera to answer the question", () => {
    const getUserMedia = vi.fn();
    selectQrEngine({ getUserMedia, createNativeDetector: undefined });
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

// ── starting ──────────────────────────────────────────────────────────────────────────────────

describe("startQrCamera", () => {
  it("requests the rear camera, and only when called", async () => {
    const h = harness({ native: true });
    expect(h.deps.getUserMedia).not.toHaveBeenCalled();

    const started = await startQrCamera(h.deps, h.video, vi.fn());

    expect(started.ok).toBe(true);
    expect(h.deps.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.deps.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: "environment" } } });
    // `ideal`, not `exact`: a laptop with only a front camera still scans.
    expect(h.video.srcObject).not.toBeNull();
    if (started.ok) started.stop();
  });

  it("downloads the fallback decoder only where there is no native one", async () => {
    const nativeRun = harness({ native: true });
    const nativeStart = await startQrCamera(nativeRun.deps, nativeRun.video, vi.fn());
    expect(nativeRun.fallbackLoads).toBe(0);
    if (nativeStart.ok) {
      expect(nativeStart.engine).toBe("native");
      nativeStart.stop();
    }

    const safariRun = harness({ native: false });
    const safariStart = await startQrCamera(safariRun.deps, safariRun.video, vi.fn());
    expect(safariRun.fallbackLoads).toBe(1);
    if (safariStart.ok) {
      expect(safariStart.engine).toBe("fallback");
      safariStart.stop();
    }
  });

  it("reports a declined permission as its own state, not as a missing camera", async () => {
    const denial = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const h = harness({ native: true, getUserMedia: vi.fn().mockRejectedValue(denial) });

    const started = await startQrCamera(h.deps, h.video, vi.fn());
    expect(started).toEqual({ ok: false, failure: "denied" });
  });

  it("reports any other camera problem as a failure to start", async () => {
    const broken = Object.assign(new Error("in use"), { name: "NotReadableError" });
    const h = harness({ native: true, getUserMedia: vi.fn().mockRejectedValue(broken) });

    const started = await startQrCamera(h.deps, h.video, vi.fn());
    expect(started).toEqual({ ok: false, failure: "failed" });
  });

  it("refuses without a camera API, before touching anything", async () => {
    const h = harness({ native: false, getUserMedia: undefined });
    const started = await startQrCamera(h.deps, h.video, vi.fn());
    expect(started).toEqual({ ok: false, failure: "unsupported" });
    expect(h.fallbackLoads).toBe(0);
  });
});

// ── decoding, and releasing ───────────────────────────────────────────────────────────────────

describe("a successful scan", () => {
  it("releases every track and the loop before reporting the value, on the native path", async () => {
    const h = harness({ native: true });
    const onDecode = vi.fn();
    const started = await startQrCamera(h.deps, h.video, onDecode);
    expect(started.ok).toBe(true);

    // Two frames with nothing in them, then one with a code.
    await h.frames.flush();
    expect(onDecode).not.toHaveBeenCalled();
    h.detect.mockResolvedValueOnce([{ rawValue: "scanner-token-value" }]);
    await h.frames.flush();

    expect(onDecode).toHaveBeenCalledExactlyOnceWith("scanner-token-value");
    for (const track of h.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(h.video.srcObject).toBeNull();
    // Nothing is still scheduled: the loop is not running behind the lookup.
    expect(h.frames.pending()).toBe(0);
  });

  it("releases the decoder and every track on the fallback path", async () => {
    const h = harness({ native: false });
    const onDecode = vi.fn();
    const started = await startQrCamera(h.deps, h.video, onDecode);
    expect(started.ok).toBe(true);

    h.emitFallback("scanner-token-value");

    expect(onDecode).toHaveBeenCalledExactlyOnceWith("scanner-token-value");
    expect(h.fallbackControls.stop).toHaveBeenCalled();
    for (const track of h.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(h.video.srcObject).toBeNull();
  });

  it("reports one value however many times the decoder fires", async () => {
    // ZXing calls back on every frame. A second call must not become a second lookup — on a
    // redeem that is the difference between one free coffee and two.
    const h = harness({ native: false });
    const onDecode = vi.fn();
    await startQrCamera(h.deps, h.video, onDecode);

    h.emitFallback("scanner-token-value");
    h.emitFallback("scanner-token-value");
    h.emitFallback("a-different-value");

    expect(onDecode).toHaveBeenCalledExactlyOnceWith("scanner-token-value");
    for (const track of h.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("ignores frames with no code, and does not treat them as errors", async () => {
    const h = harness({ native: false });
    const onDecode = vi.fn();
    await startQrCamera(h.deps, h.video, onDecode);

    h.emitFallback("");
    expect(onDecode).not.toHaveBeenCalled();
    for (const track of h.tracks) expect(track.stop).not.toHaveBeenCalled();
  });
});

describe("the preview element mounts late", () => {
  /*
   * The Android defect, and a different bug from the iPhone one.
   *
   * On a Huawei the permission prompt appeared and permission was GRANTED — and then nothing
   * happened. No preview, no scanning. The component rendered its <video> conditionally and set
   * that condition in the same tick it acquired the stream, so React had not re-rendered when the
   * stream arrived and the ref was still null. The old code read it, found nothing, and quietly
   * returned: an approved camera stream attached to nothing, with the camera light on.
   *
   * A granted permission followed by silence is the worst of the three failures, because the
   * person has already done the only thing they were asked to do.
   */

  /** A ref that fills in after `afterFrames` frames, the way React fills one in after a render. */
  function lateVideo(afterFrames: number, frames: ReturnType<typeof manualFrames>) {
    const element = fakeVideo();
    let remaining = afterFrames;
    return {
      element,
      get: () => {
        if (remaining > 0) {
          remaining -= 1;
          return null;
        }
        return element;
      },
      frames,
    };
  }

  it("waits for the element, then attaches the stream and starts decoding", async () => {
    const h = harness({ native: true });
    const late = lateVideo(3, h.frames);
    const onDecode = vi.fn();

    const startPromise = startQrCamera(h.deps, late.get, onDecode);

    // Three frames while React catches up. The stream is granted but not yet attached.
    for (let i = 0; i < 4; i += 1) await h.frames.flush();
    const started = await startPromise;

    expect(started.ok).toBe(true);
    // Attached to the element that eventually mounted, not dropped on the floor.
    expect(late.element.srcObject).not.toBeNull();
    expect(late.element.play).toHaveBeenCalled();

    // And the decoder really is running against it.
    h.detect.mockResolvedValueOnce([{ rawValue: "late-mount-token" }]);
    await h.frames.flush();
    expect(onDecode).toHaveBeenCalledExactlyOnceWith("late-mount-token");
  });

  it("works the same on the fallback decoder", async () => {
    const h = harness({ native: false });
    const late = lateVideo(2, h.frames);
    const onDecode = vi.fn();

    const startPromise = startQrCamera(h.deps, late.get, onDecode);
    for (let i = 0; i < 3; i += 1) await h.frames.flush();
    const started = await startPromise;

    expect(started.ok).toBe(true);
    expect(late.element.srcObject).not.toBeNull();
    h.emitFallback("late-mount-token");
    expect(onDecode).toHaveBeenCalledExactlyOnceWith("late-mount-token");
  });

  it("hands the camera back if the element never mounts", async () => {
    // Rather than holding an approved stream open behind a blank screen, which is what the
    // Huawei was left doing.
    const h = harness({ native: true });
    const onDecode = vi.fn();

    const startPromise = startQrCamera(h.deps, () => null, onDecode);
    // Drain the bounded wait. Unconditionally: the first frame is only scheduled after the
    // getUserMedia microtask settles, so a `while (pending)` loop exits before it starts — which
    // is how the first version of this test hung until the timeout rather than failing.
    for (let i = 0; i < 200; i += 1) await h.frames.flush();
    const started = await startPromise;

    expect(started).toEqual({ ok: false, failure: "failed" });
    for (const track of h.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(onDecode).not.toHaveBeenCalled();
    // The decoder was never downloaded for a camera that had nowhere to go.
    expect(h.fallbackLoads).toBe(0);
  });

  it("takes an element directly when the caller already has one", async () => {
    // The simple case still works, and asks for no frames at all.
    const h = harness({ native: true });
    const started = await startQrCamera(h.deps, h.video, vi.fn());
    expect(started.ok).toBe(true);
    expect(h.video.srcObject).not.toBeNull();
    if (started.ok) started.stop();
  });
});

describe("stopping", () => {
  it("stops the tracks, the decoder and the loop", async () => {
    const h = harness({ native: false });
    const started = await startQrCamera(h.deps, h.video, vi.fn());
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    started.stop();

    expect(h.fallbackControls.stop).toHaveBeenCalled();
    for (const track of h.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(h.video.srcObject).toBeNull();
  });

  it("is safe to call twice, which unmount-then-stop does", async () => {
    const h = harness({ native: true });
    const started = await startQrCamera(h.deps, h.video, vi.fn());
    if (!started.ok) return;

    started.stop();
    started.stop();

    for (const track of h.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending frame instead of leaving the loop alive", async () => {
    const h = harness({ native: true });
    const started = await startQrCamera(h.deps, h.video, vi.fn());
    if (!started.ok) return;

    await h.frames.flush(); // one empty frame, which schedules the next
    expect(h.frames.pending()).toBe(1);

    started.stop();
    expect(h.frames.cancelled.length).toBe(1);
    expect(h.frames.pending()).toBe(0);
  });

  it("reports nothing after being stopped, even if a late frame decodes", async () => {
    const h = harness({ native: true });
    const onDecode = vi.fn();
    const started = await startQrCamera(h.deps, h.video, onDecode);
    if (!started.ok) return;

    started.stop();
    h.detect.mockResolvedValueOnce([{ rawValue: "too-late" }]);
    await h.frames.flush();

    expect(onDecode).not.toHaveBeenCalled();
  });

  it("releases the stream when the decoder itself throws", async () => {
    const h = harness({ native: false });
    h.deps.loadFallbackReader = async () => {
      throw new Error("chunk failed to load");
    };

    const started = await startQrCamera(h.deps, h.video, vi.fn());

    expect(started).toEqual({ ok: false, failure: "failed" });
    // The camera opened before the decoder failed, so it must be closed again.
    for (const track of h.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(h.video.srcObject).toBeNull();
  });

  it("keeps a decoder that throws while stopping from stranding the camera", async () => {
    const h = harness({ native: false });
    h.fallbackControls.stop.mockImplementation(() => {
      throw new Error("already stopped");
    });
    const started = await startQrCamera(h.deps, h.video, vi.fn());
    if (!started.ok) return;

    expect(() => started.stop()).not.toThrow();
    for (const track of h.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
