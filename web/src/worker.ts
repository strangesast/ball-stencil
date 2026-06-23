/// <reference lib="webworker" />
/**
 * Geometry worker. ALL expensive computation happens here: SVG parse, Bezier
 * flattening, 2D boolean/offset ops (Clipper2 lazy-loaded), sampling, Delaunay,
 * pinch-splitting, wall stitching, validation, and STL/OBJ serialization. The
 * main thread only sends parameters and renders the returned transferable
 * buffers. Stale builds are dropped via a monotonic job id.
 */

import type { Params } from "./pipeline/config";
import type { MeshReport } from "./pipeline/meshcheck";

interface BuildMsg {
  type: "build";
  jobId: number;
  svgText: string;
  name: string;
  params: Params;
}
interface ExportMsg {
  type: "export";
  jobId: number;
  kind: "stl" | "obj" | "ball";
}
type InMsg = BuildMsg | ExportMsg;

export interface BuildInfo {
  rRef: number;
  innerRadius: number;
  outerRadius: number;
  center: [number, number];
  chordErrorMm: number;
  spacingSvg: number;
  nCutRegions: number;
  islands: number[];
  labels: string[];
  viewBox: [number, number, number, number];
  nPlanar: number;
  decalTris: number; // triangle count of the projection decal (0 = nothing to paint)
  svgColor: string | null; // design's own fill (#rrggbb), or null if unspecified
}

// Lazily-imported pipeline (keeps Clipper2 + Delaunator out of the main bundle).
let mod: typeof import("./pipeline/pipeline") | null = null;
let exportMod: typeof import("./pipeline/exportmesh") | null = null;
let cfgMod: typeof import("./pipeline/config") | null = null;

// Last successful build, kept so exports don't re-run the whole pipeline.
let last: {
  jobId: number;
  vertices: Float64Array;
  faces: Int32Array;
  ballRadius: number;
} | null = null;

// Job id of the build currently in flight, or -1 when idle. The global error
// nets report with -1 so a stray/late rejection is never mis-attributed to a
// (since-superseded or already-finished) job the main thread would accept.
const NO_JOB = -1;
let currentJob = NO_JOB;

async function ensureLoaded() {
  if (!mod) mod = await import("./pipeline/pipeline");
  if (!exportMod) exportMod = await import("./pipeline/exportmesh");
  if (!cfgMod) cfgMod = await import("./pipeline/config");
  // Robust cut-dilation offset (Clipper 1); the pipeline runs sync after this.
  await (await import("./pipeline/offset")).loadOffsetLib();
}

async function handleBuild(msg: BuildMsg) {
  currentJob = msg.jobId;

  try {
    // Inside the try so module-eval failures (a dep that throws at import, an
    // OOM, etc.) surface as an error message instead of a silently hung build.
    await ensureLoaded();
    if (msg.jobId !== currentJob) return; // superseded while loading
    const parsed = (await import("./pipeline/svg")).parseSvg(msg.svgText);
    const res = mod!.runPipeline(parsed, msg.params, msg.name);
    if (msg.jobId !== currentJob) return; // superseded during compute

    const v = res.build.mesh.vertices;
    const f = res.build.mesh.faces;
    last = {
      jobId: msg.jobId,
      vertices: v,
      faces: f,
      ballRadius: cfgMod!.ballRadius(msg.params),
    };

    // preview buffers (Float32 positions + Uint32 indices), transferable
    const positions = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) positions[i] = v[i];
    const indices = new Uint32Array(f.length);
    for (let i = 0; i < f.length; i++) indices[i] = f[i];

    // projection decal buffers (also transferable). Built from the same cut
    // region + mapper as the shell, so it is congruent with the holes.
    const dv = res.build.decal.vertices;
    const df = res.build.decal.faces;
    const decalPositions = new Float32Array(dv.length);
    for (let i = 0; i < dv.length; i++) decalPositions[i] = dv[i];
    const decalIndices = new Uint32Array(df.length);
    for (let i = 0; i < df.length; i++) decalIndices[i] = df[i];

    const info: BuildInfo = {
      rRef: res.build.rRef,
      innerRadius: cfgMod!.innerRadius(msg.params),
      outerRadius: cfgMod!.outerRadius(msg.params),
      center: res.center,
      chordErrorMm: res.chordErrorMm,
      spacingSvg: res.build.spacingSvg,
      nCutRegions: res.build.nCutRegions,
      islands: res.build.islands,
      labels: res.labels,
      viewBox: res.viewBox,
      nPlanar: res.build.mesh.nPlanar,
      decalTris: decalIndices.length / 3,
      svgColor: parsed.fill,
    };

    (self as DedicatedWorkerGlobalScope).postMessage(
      {
        type: "result",
        jobId: msg.jobId,
        ok: res.ok,
        report: res.report as MeshReport,
        info,
        positions: positions.buffer,
        indices: indices.buffer,
        decalPositions: decalPositions.buffer,
        decalIndices: decalIndices.buffer,
        ballRadius: last.ballRadius,
      },
      [positions.buffer, indices.buffer, decalPositions.buffer, decalIndices.buffer],
    );
  } catch (err) {
    if (msg.jobId !== currentJob) return;
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: "error",
      jobId: msg.jobId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Mark idle once this build settles, unless a newer build already took over.
    if (msg.jobId === currentJob) currentJob = NO_JOB;
  }
}

async function handleExport(msg: ExportMsg) {
  try {
    await ensureLoaded();
    if (!last) {
      (self as DedicatedWorkerGlobalScope).postMessage({ type: "exportError", kind: msg.kind, message: "no mesh built yet" });
      return;
    }
    if (msg.kind === "ball") {
      const { vertices, faces } = exportMod!.uvSphere(last.ballRadius, 96, 48);
      const buf = exportMod!.writeStl(vertices, faces);
      (self as DedicatedWorkerGlobalScope).postMessage({ type: "export", kind: "ball", buffer: buf }, [buf]);
      return;
    }
    if (msg.kind === "stl") {
      const buf = exportMod!.writeStl(last.vertices, last.faces);
      (self as DedicatedWorkerGlobalScope).postMessage({ type: "export", kind: "stl", buffer: buf }, [buf]);
      return;
    }
    // obj
    const text = exportMod!.writeObj(last.vertices, last.faces);
    const buf = new TextEncoder().encode(text).buffer;
    (self as DedicatedWorkerGlobalScope).postMessage({ type: "export", kind: "obj", buffer: buf }, [buf]);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: "exportError",
      kind: msg.kind,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "build") void handleBuild(msg);
  else if (msg.type === "export") void handleExport(msg);
};

// Safety net: any error that still escapes a handler (or a non-promise throw at
// module scope) is reported to the main thread instead of vanishing as an
// "Uncaught (in promise)" with the build badge stuck on "building…".
// Reported with NO_JOB (not currentJob): an escaped error can't be reliably tied
// to a specific build, and stamping the latest job id would either flip that
// build's PASS to a false FAIL or be dropped as stale. NO_JOB is always shown.
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  const reason = e.reason;
  (self as DedicatedWorkerGlobalScope).postMessage({
    type: "error",
    jobId: NO_JOB,
    message: "worker error: " + (reason instanceof Error ? reason.message : String(reason)),
  });
});
self.addEventListener("error", (e: ErrorEvent) => {
  (self as DedicatedWorkerGlobalScope).postMessage({
    type: "error",
    jobId: NO_JOB,
    message: "worker error: " + e.message,
  });
});
