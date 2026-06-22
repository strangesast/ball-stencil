/**
 * Central configuration for the ball-stencil pipeline (browser port).
 *
 * Mirrors ball_stencil/config.py: every physical / geometric parameter lives
 * here with the same defaults. All lengths are millimetres; all geometry math
 * is float64 (JS number).
 */

export interface Params {
  sphere_diameter_mm: number;
  fit_clearance_mm: number;
  wall_thickness_mm: number;
  cap_angle_deg: number;

  mapping: string;
  design_center_uv: [number, number] | null;
  design_reference_radius: number | null;
  design_margin: number;
  flip_v: boolean;

  chord_error_mm: number;
  min_segment_mm: number;
  target_edge_mm: number;

  radius_tolerance_mm: number;
  min_island_area_mm2: number;
  snap_grid_svg: number;
  cut_separation_svg: number;
}

/** Defaults, identical to ball_stencil/config.py. */
export const DEFAULT_PARAMS: Params = {
  sphere_diameter_mm: 206.0,
  fit_clearance_mm: 0.4,
  wall_thickness_mm: 2.0,
  cap_angle_deg: 90.0,

  mapping: "lambert",
  design_center_uv: null,
  design_reference_radius: null,
  design_margin: 1.06,
  flip_v: true,

  chord_error_mm: 0.1,
  min_segment_mm: 0.05,
  target_edge_mm: 1.2,

  radius_tolerance_mm: 0.01,
  min_island_area_mm2: 1.0,
  snap_grid_svg: 0.05,
  cut_separation_svg: 0.3,
};

export const ballRadius = (p: Params) => p.sphere_diameter_mm / 2.0;
export const innerRadius = (p: Params) => ballRadius(p) + p.fit_clearance_mm;
export const outerRadius = (p: Params) => innerRadius(p) + p.wall_thickness_mm;
export const capAngleRad = (p: Params) => (p.cap_angle_deg * Math.PI) / 180.0;

/**
 * Reject physically/numerically invalid parameters with the same messages as
 * Config.validate() in the Python reference.
 */
export function validateParams(p: Params): void {
  if (!(p.sphere_diameter_mm > 0))
    throw new Error(`sphere_diameter_mm must be > 0, got ${p.sphere_diameter_mm}`);
  if (p.fit_clearance_mm < 0)
    throw new Error(`fit_clearance_mm must be >= 0, got ${p.fit_clearance_mm}`);
  if (!(p.wall_thickness_mm > 0))
    throw new Error(`wall_thickness_mm must be > 0, got ${p.wall_thickness_mm}`);
  if (!(p.cap_angle_deg > 0.0 && p.cap_angle_deg < 180.0))
    throw new Error(`cap_angle_deg must be in (0, 180), got ${p.cap_angle_deg}`);
  if (!(p.design_margin > 0))
    throw new Error(`design_margin must be > 0, got ${p.design_margin}`);
  if (p.design_reference_radius !== null && !(p.design_reference_radius > 0))
    throw new Error(
      `design_reference_radius must be > 0, got ${p.design_reference_radius}`,
    );
  if (!(p.target_edge_mm > 0))
    throw new Error(`target_edge_mm must be > 0, got ${p.target_edge_mm}`);
  if (!(p.chord_error_mm > 0))
    throw new Error(`chord_error_mm must be > 0, got ${p.chord_error_mm}`);
}
