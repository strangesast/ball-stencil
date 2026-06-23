/**
 * Raster → silhouette SVG pure core (src/pipeline/trace.ts). Builds synthetic
 * ImageData by hand (no canvas) and feeds it straight to traceImageToSvg, then
 * asserts the result satisfies the load_artwork contract: a viewBox sized to the
 * source pixels, ≥1 visible filled path, and a non-empty even-odd region. A
 * shape-with-hole must trace to a region whose hole is preserved (even-odd), not
 * filled — the silhouette-correctness guarantee. Testing the pure core directly
 * keeps these worker-free and deterministic; the worker decode path is covered by
 * the e2e. esm-potrace-wasm runs headless in Node (its wasm is embedded), so both
 * backends are exercised here.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { traceImageToSvg, type TraceBackend } from "../src/pipeline/trace";
import { parseSvg } from "../src/pipeline/svg";
import { loadArtwork } from "../src/pipeline/svgio";
import { Clip } from "../src/pipeline/clip";
import { loadOffsetLib } from "../src/pipeline/offset";

// Kept ≤100² so the synthetic image stays under esm-potrace-wasm's ~16k-pixel
// stack-marshalling limit (the worker downscales real uploads to the same budget;
// see trace.worker.ts). The pure core itself does not downscale.
const W = 100;
const H = 100;

/** RGBA ImageData-like with a callback deciding each pixel's colour. */
function makeImage(paint: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const [r, g, b, a] = paint(x, y);
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width: W, height: H, data };
}

const cx = W / 2, cy = H / 2;
function disc(x: number, y: number): [number, number, number, number] {
  return Math.hypot(x - cx, y - cy) <= 40 ? [40, 90, 200, 255] : [255, 255, 255, 255];
}
function ring(x: number, y: number): [number, number, number, number] {
  const r = Math.hypot(x - cx, y - cy);
  return r <= 45 && r >= 22 ? [0, 0, 0, 255] : [255, 255, 255, 255];
}

/** Even-odd region from a traced SVG, via the real parse + load path. */
function regionOf(svgText: string) {
  const parsed = parseSvg(svgText);
  const clip = new Clip(0.05);
  return { parsed, art: loadArtwork(parsed, 0.5, clip, "traced.svg") };
}

function holeCount(region: ReturnType<typeof loadArtwork>["region"]): number {
  // Clipper2 PolyTree-style Paths64: count rings whose signed area is opposite
  // the dominant (outer) orientation — i.e. holes.
  let holes = 0;
  const area = (p: { x: number; y: number }[]) => {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      a += p[i].x * p[j].y - p[j].x * p[i].y;
    }
    return a / 2;
  };
  const areas = region.map(area);
  const outerSign = Math.sign(areas.reduce((m, a) => (Math.abs(a) > Math.abs(m) ? a : m), 0));
  for (const a of areas) if (a !== 0 && Math.sign(a) !== outerSign) holes++;
  return holes;
}

const BACKENDS: TraceBackend[] = ["potrace", "color"];

beforeAll(async () => {
  await loadOffsetLib();
});

describe("traceImageToSvg pure core", () => {
  for (const backend of BACKENDS) {
    it(`${backend}: a solid disc → viewBox==source, ≥1 filled path, non-empty region`, async () => {
      const { svgText } = await traceImageToSvg(makeImage(disc), { backend });
      const { parsed, art } = regionOf(svgText);
      expect(parsed.viewBox).toEqual([0, 0, W, H]);
      expect(parsed.paths.filter((p) => !p.hidden).length).toBeGreaterThanOrEqual(1);
      expect(art.region.length).toBeGreaterThan(0);
      // roughly the disc area, in (snapped) SVG units²
      const total = art.region.reduce((s, r) => {
        let a = 0;
        for (let i = 0; i < r.length; i++) {
          const j = (i + 1) % r.length;
          a += r[i].x * r[j].y - r[j].x * r[i].y;
        }
        return s + Math.abs(a / 2);
      }, 0);
      // Clip scales SVG units by 1/precision (1e4); compare in that integer space.
      expect(total).toBeGreaterThan(0.5 * Math.PI * 40 * 40 * 1e8);
    });

    it(`${backend}: a ring preserves its hole (even-odd), not filled`, async () => {
      const { svgText } = await traceImageToSvg(makeImage(ring), { backend });
      const { art } = regionOf(svgText);
      expect(holeCount(art.region)).toBeGreaterThanOrEqual(1);
    });
  }

  it("samples the dominant foreground colour as the path fill", async () => {
    const { svgText } = await traceImageToSvg(makeImage(disc), { backend: "potrace" });
    // mean of (40,90,200) → #285ac8
    expect(parseSvg(svgText).fill).toBe("#285ac8");
  });

  it("honours an explicit fill override", async () => {
    const { svgText } = await traceImageToSvg(makeImage(disc), { fill: "#123456" });
    expect(parseSvg(svgText).fill).toBe("#123456");
  });

  it("traces light-on-dark only with invert", async () => {
    const inv = (x: number, y: number): [number, number, number, number] =>
      Math.hypot(x - cx, y - cy) <= 40 ? [255, 255, 255, 255] : [0, 0, 0, 255];
    const { svgText } = await traceImageToSvg(makeImage(inv), { invert: true });
    expect(regionOf(svgText).art.region.length).toBeGreaterThan(0);
  });

  it("throws on an all-background image instead of building blank", async () => {
    const blank = makeImage(() => [255, 255, 255, 255]);
    await expect(traceImageToSvg(blank, {})).rejects.toThrow(/no foreground/i);
  });

  it("emits no <g> or transforms (parseSvg-clean, contract §0)", async () => {
    const { svgText } = await traceImageToSvg(makeImage(ring), { backend: "potrace" });
    expect(svgText).not.toMatch(/<g\b/);
    expect(svgText).not.toMatch(/transform=/);
  });
});
