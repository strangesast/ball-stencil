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

let currentJob = 0;

async function ensureLoaded() {
  if (!mod) mod = await import("./pipeline/pipeline");
  if (!exportMod) exportMod = await import("./pipeline/exportmesh");
  if (!cfgMod) cfgMod = await import("./pipeline/config");
}

async function handleBuild(msg: BuildMsg) {
  currentJob = msg.jobId;
  await ensureLoaded();
  if (msg.jobId !== currentJob) return; // superseded while loading

  try {
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
        ballRadius: last.ballRadius,
      },
      [positions.buffer, indices.buffer],
    );
  } catch (err) {
    if (msg.jobId !== currentJob) return;
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: "error",
      jobId: msg.jobId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleExport(msg: ExportMsg) {
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
}

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "build") void handleBuild(msg);
  else if (msg.type === "export") void handleExport(msg);
};
