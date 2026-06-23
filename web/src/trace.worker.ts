/// <reference lib="webworker" />
/**
 * Trace worker. The new compute thread for raster → silhouette SVG: it decodes
 * the picked image off the main thread (createImageBitmap + OffscreenCanvas), then
 * runs the chosen tracer (esm-potrace-wasm / ImageTracer.js, both lazy-loaded here
 * so SVG/letter users never download them). ALL heavy work — decode + wasm trace —
 * lives here, mirroring the geometry worker's contract that the UI thread stays
 * compute-free. Stale traces are dropped via a monotonic job id.
 */

import { traceImageToSvg, type TraceOptions } from "./pipeline/trace";

interface TraceMsg {
  type: "trace";
  jobId: number;
  file: Blob; // the picked File (a Blob); decoded here, never on the main thread
  opts: TraceOptions;
}
type InMsg = TraceMsg;

// Working-resolution caps (downscaled here, before tracing). A silhouette is
// low-frequency and the final cut-edge fidelity is governed downstream by
// boundary_smoothness_mm, so tracing at full photo resolution only wastes time
// and bloats the mesh — but the caps are also a HARD requirement for potrace:
// esm-potrace-wasm v0.4.4 marshals the image onto its 64 KB wasm stack
// (stackAlloc), so an input over ~16k pixels (≈128² RGBA = 64 KB) makes the copy
// run off the stack and throw "offset is out of bounds". 12k keeps headroom for
// the trace's own stack frames. ImageTracer.js has no such limit, so its cap is a
// generous performance ceiling only.
const POTRACE_MAX_PIXELS = 12_000;
const COLOR_MAX_PIXELS = 1_000_000;

// Job id of the trace currently in flight, or -1 when idle (same discipline as
// the geometry worker: a stray/late rejection reports with -1 and is never
// mis-attributed to a since-superseded job).
const NO_JOB = -1;
let currentJob = NO_JOB;

async function decode(file: Blob, maxPixels: number): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  try {
    let { width: w, height: h } = bitmap;
    const px = w * h;
    if (px > maxPixels) {
      const s = Math.sqrt(maxPixels / px);
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("could not get a 2D context to decode the image");
    ctx.drawImage(bitmap, 0, 0, w, h); // scales when w/h differ from the bitmap
    return ctx.getImageData(0, 0, w, h);
  } finally {
    bitmap.close();
  }
}

async function handleTrace(msg: TraceMsg) {
  currentJob = msg.jobId;
  try {
    const maxPixels = msg.opts.backend === "color" ? COLOR_MAX_PIXELS : POTRACE_MAX_PIXELS;
    const imageData = await decode(msg.file, maxPixels);
    if (msg.jobId !== currentJob) return; // superseded while decoding
    const { svgText } = await traceImageToSvg(imageData, msg.opts);
    if (msg.jobId !== currentJob) return; // superseded during trace
    (self as DedicatedWorkerGlobalScope).postMessage({ type: "result", jobId: msg.jobId, svgText });
  } catch (err) {
    if (msg.jobId !== currentJob) return;
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: "error",
      jobId: msg.jobId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (msg.jobId === currentJob) currentJob = NO_JOB;
  }
}

self.onmessage = (e: MessageEvent<InMsg>) => {
  if (e.data.type === "trace") void handleTrace(e.data);
};

// Safety net: an error that escapes a handler (or a non-promise throw at module
// scope — e.g. the wasm failing to instantiate) is reported to the main thread
// instead of vanishing as an "Uncaught (in promise)" with the badge stuck busy.
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  const reason = e.reason;
  (self as DedicatedWorkerGlobalScope).postMessage({
    type: "error",
    jobId: NO_JOB,
    message: "trace worker error: " + (reason instanceof Error ? reason.message : String(reason)),
  });
});
self.addEventListener("error", (e: ErrorEvent) => {
  (self as DedicatedWorkerGlobalScope).postMessage({
    type: "error",
    jobId: NO_JOB,
    message: "trace worker error: " + e.message,
  });
});
