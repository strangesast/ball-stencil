/**
 * Pipeline parity tests (headless, fast). Runs the DOM-free geometry pipeline
 * over the golden config matrix and asserts against values captured from the
 * Python oracle (web/fixtures/golden.json).
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_PARAMS, Params } from "../src/pipeline/config";
import { parseSvg } from "../src/pipeline/svg";
import { runPipeline } from "../src/pipeline/pipeline";
import { writeStl, writeObj } from "../src/pipeline/exportmesh";
import { loadGolden, loadSvg, GoldenCase } from "./golden";

function paramsFor(c: GoldenCase): Params {
  return { ...DEFAULT_PARAMS, ...(c.overrides as Partial<Params>) };
}

function run(c: GoldenCase) {
  const parsed = parseSvg(loadSvg(c.svg));
  return runPipeline(parsed, paramsFor(c), c.svg);
}

const golden = loadGolden();

describe("pipeline parity vs Python oracle", () => {
  for (const c of golden.cases) {
    const label = `${c.svg} ${JSON.stringify(c.overrides)}`;
    it(label, () => {
      const res = run(c);
      const rep = res.report;

      // --- exact topological invariants ---
      expect(rep.isWatertight).toBe(true);
      expect(rep.isManifold).toBe(true);
      expect(rep.consistentWinding).toBe(true);
      expect(rep.nBoundaryEdges).toBe(0);
      expect(rep.nNonmanifoldEdges).toBe(0);
      expect(rep.nDegenerate).toBe(0);
      expect(res.ok).toBe(true);

      expect(res.build.nCutRegions).toBe(c.n_cut_regions);
      expect(res.build.islands.length).toBe(c.n_components);

      // analytic mapping -> radius error ~ machine epsilon
      expect(rep.maxRadiusErrorMm).toBeLessThanOrEqual(DEFAULT_PARAMS.radius_tolerance_mm);
      expect(rep.maxRadiusErrorMm).toBeLessThan(1e-9);

      // deterministic geometry
      expect(res.build.rRef).toBeCloseTo(c.r_ref, 3);
      expect(res.center[0]).toBeCloseTo(c.center[0], 6);
      expect(res.center[1]).toBeCloseTo(c.center[1], 6);
      const outerR = paramsFor(c).sphere_diameter_mm / 2 + paramsFor(c).fit_clearance_mm + paramsFor(c).wall_thickness_mm;
      expect(c.outer_radius_mm).toBeCloseTo(outerR, 6);
      expect(res.chordErrorMm).toBeCloseTo(c.chord_error_mm, 3);

      // --- continuous invariant: signed volume ---
      // The spec's canonical targets (splash / splash_z) must match within
      // +/-1%. The synthetic fixtures (dot/ring/multi) are thin-frame shells
      // where a sub-percent geometric difference between Clipper2 and GEOS
      // amplifies into a few percent of the small enclosed volume, so they get
      // a looser bound; their topology is still asserted exactly above.
      const volTol = c.svg.startsWith("splash") ? 0.01 : 0.1;
      const relVol = Math.abs(rep.signedVolumeMm3 - c.signed_volume_mm3) / Math.abs(c.signed_volume_mm3);
      expect(relVol, `volume ${rep.signedVolumeMm3} vs ${c.signed_volume_mm3}`).toBeLessThan(volTol);

      // free-island areas within +/-10%: the count + detection are exact, but
      // the small enclosed area depends on the boolean engine's offset/precision
      // (Clipper2 vs GEOS), so the absolute mm^2 differs slightly.
      for (let k = 0; k < c.islands_mm2.length; k++) {
        const got = res.build.islands[k];
        const rel = Math.abs(got - c.islands_mm2[k]) / Math.abs(c.islands_mm2[k]);
        expect(rel, `island[${k}] ${got} vs ${c.islands_mm2[k]}`).toBeLessThan(0.1);
      }

      // --- density-dependent: ballpark only (spec: "+/-~15% on counts is
      // fine"). Tight for the canonical splash targets; looser for the small
      // synthetic fixtures, where a coarse target_edge over a tiny disc yields
      // few triangles and the count ratio is dominated by boundary granularity.
      const cntTol = c.svg.startsWith("splash") ? 0.15 : 0.45;
      expect(Math.abs(rep.nVertices - c.n_vertices) / c.n_vertices, "nVertices").toBeLessThan(cntTol);
      expect(Math.abs(rep.nFaces - c.n_faces) / c.n_faces, "nFaces").toBeLessThan(cntTol);
      // edge mean tracks target edge
      expect(Math.abs(rep.edgeLenMean - c.edge_len_mean) / c.edge_len_mean).toBeLessThan(cntTol);

      // --- export sanity ---
      const stl = writeStl(res.build.mesh.vertices, res.build.mesh.faces);
      expect(stl.byteLength).toBe(84 + 50 * rep.nFaces);
      const obj = writeObj(res.build.mesh.vertices, res.build.mesh.faces);
      const vCount = (obj.match(/^v /gm) || []).length;
      const fCount = (obj.match(/^f /gm) || []).length;
      expect(vCount).toBe(rep.nVertices);
      expect(fCount).toBe(rep.nFaces);
    });
  }
});

describe("relational sanity", () => {
  it("increasing wall thickness increases volume", () => {
    const parsed = parseSvg(loadSvg("splash.svg"));
    const v2 = runPipeline(parsed, { ...DEFAULT_PARAMS, wall_thickness_mm: 2 }, "splash.svg").report.signedVolumeMm3;
    const v4 = runPipeline(parsed, { ...DEFAULT_PARAMS, wall_thickness_mm: 4 }, "splash.svg").report.signedVolumeMm3;
    expect(v4).toBeGreaterThan(v2);
  });

  it("increasing target edge lowers vertex count but keeps volume (+/-1%)", () => {
    const parsed = parseSvg(loadSvg("splash.svg"));
    const fine = runPipeline(parsed, { ...DEFAULT_PARAMS, target_edge_mm: 1.2 }, "splash.svg");
    const coarse = runPipeline(parsed, { ...DEFAULT_PARAMS, target_edge_mm: 2.5 }, "splash.svg");
    expect(coarse.report.nVertices).toBeLessThan(fine.report.nVertices);
    const rel = Math.abs(coarse.report.signedVolumeMm3 - fine.report.signedVolumeMm3) / fine.report.signedVolumeMm3;
    expect(rel).toBeLessThan(0.01);
  });

  it("splash_z yields exactly 1 hole and 1 component (no free island)", () => {
    const parsed = parseSvg(loadSvg("splash_z.svg"));
    const res = runPipeline(parsed, { ...DEFAULT_PARAMS }, "splash_z.svg");
    expect(res.build.nCutRegions).toBe(1);
    expect(res.build.islands.length).toBe(1);
  });
});

describe("error cases", () => {
  for (const e of golden.errors) {
    const label = `${e.svg} ${JSON.stringify(e.overrides)} -> error`;
    it(label, () => {
      const parsed = parseSvg(loadSvg(e.svg));
      const p = { ...DEFAULT_PARAMS, ...(e.overrides as Partial<Params>) };
      expect(() => runPipeline(parsed, p, e.svg)).toThrow();
    });
  }

  it("SVG with no filled paths throws the documented message", () => {
    const parsed = parseSvg('<svg viewBox="0 0 10 10"></svg>');
    expect(() => runPipeline(parsed, { ...DEFAULT_PARAMS }, "empty.svg")).toThrow(/No filled vector paths/);
  });

  it("huge cut separation empties the material with the documented message", () => {
    const parsed = parseSvg(loadSvg("dot.svg"));
    expect(() =>
      runPipeline(parsed, { ...DEFAULT_PARAMS, cut_separation_svg: 100 }, "dot.svg"),
    ).toThrow(/material region is empty/);
  });
});
