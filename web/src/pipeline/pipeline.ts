/**
 * End-to-end pipeline: parsed SVG -> stencil shell mesh -> report.
 * Port of ball_stencil/pipeline.run, kept pure and DOM-free so the identical
 * code runs in the Web Worker and in Node tests.
 */

import { Clip } from "./clip";
import { Params, capAngleRad, outerRadius, validateParams } from "./config";
import { ParsedSvg } from "./svg";
import { loadArtwork, Artwork } from "./svgio";
import { Mapper } from "./mapping";
import { buildShell, BuildResult } from "./meshbuild";
import { checkMesh, MeshReport, reportOk } from "./meshcheck";

export interface PipelineResult {
  build: BuildResult;
  report: MeshReport;
  chordErrorMm: number;
  labels: string[];
  viewBox: [number, number, number, number];
  center: [number, number];
  ok: boolean;
}

function provisionalScaleMax(
  region: Artwork["region"],
  center: [number, number],
  p: Params,
  clip: Clip,
): number {
  const rRef =
    p.design_reference_radius !== null
      ? p.design_reference_radius
      : clip.maxRadius(region, center[0], center[1]) * p.design_margin;
  const mapper = new Mapper(center, rRef, capAngleRad(p), p.flip_v);
  return mapper.scaleBounds(outerRadius(p))[2];
}

export function runPipeline(parsed: ParsedSvg, p: Params, name = "input.svg"): PipelineResult {
  validateParams(p);
  const clip = new Clip(p.snap_grid_svg);

  // --- 1. load + tessellate (two passes to honour the chord-error budget) ---
  const provisionalTol = 0.2; // SVG units
  let art = loadArtwork(parsed, provisionalTol, clip, name);

  const center: [number, number] = p.design_center_uv ?? art.center;

  const scaleMax = provisionalScaleMax(art.region, center, p, clip);
  const chordTolSvg = p.chord_error_mm / scaleMax;
  if (chordTolSvg < provisionalTol) {
    art = loadArtwork(parsed, chordTolSvg, clip, name);
  }
  const chordErrorMm = chordTolSvg * scaleMax;

  // --- 2. build the shell ---
  const build = buildShell(art.region, center, p, clip);

  // --- 3. validate ---
  const report = checkMesh(build.mesh, p);

  return {
    build,
    report,
    chordErrorMm,
    labels: art.labels,
    viewBox: art.viewbox,
    center,
    ok: reportOk(report, p),
  };
}
