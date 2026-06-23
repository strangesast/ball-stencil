/** Shared golden fixtures (one source of truth for both test layers). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const FIX_DIR = join(here, "..", "fixtures");
export const SVG_DIR = join(FIX_DIR, "svg");

export interface GoldenCase {
  svg: string;
  overrides: Record<string, number | string>;
  r_ref: number;
  inner_radius_mm: number;
  outer_radius_mm: number;
  center: [number, number];
  chord_error_mm: number;
  spacing_svg: number;
  n_cut_regions: number;
  n_components: number;
  islands_mm2: number[];
  n_vertices: number;
  n_faces: number;
  n_planar: number;
  is_watertight: boolean;
  is_manifold: boolean;
  consistent_winding: boolean;
  n_boundary_edges: number;
  n_nonmanifold_edges: number;
  max_radius_error_mm: number;
  edge_len_min: number;
  edge_len_mean: number;
  edge_len_max: number;
  max_aspect_ratio: number;
  signed_volume_mm3: number;
  n_degenerate: number;
  ok: boolean;
}

export interface GoldenErr {
  svg: string;
  overrides: Record<string, number | string>;
  error: string | null;
}

export interface Golden {
  cases: GoldenCase[];
  errors: GoldenErr[];
}

export function loadGolden(): Golden {
  return JSON.parse(readFileSync(join(FIX_DIR, "golden.json"), "utf8"));
}

export function loadSvg(name: string): string {
  return readFileSync(join(SVG_DIR, name), "utf8");
}
