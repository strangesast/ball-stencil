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
  /** "constrained" (poly2tri CDT, smooth cut edge) | "centroid" (legacy, faceted). */
  mesh_strategy: "constrained" | "centroid";
  /** How closely the cut edge follows the design curve (mm on the sphere),
   *  decoupled from target_edge_mm. Only the "constrained" mesher honours it. */
  boundary_smoothness_mm: number;

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
  mesh_strategy: "constrained",
  boundary_smoothness_mm: 0.04,

  radius_tolerance_mm: 0.01,
  min_island_area_mm2: 1.0,
  snap_grid_svg: 0.05,
  cut_separation_svg: 0.3,
};

/**
 * App-facing defaults. Differs from DEFAULT_PARAMS in two app-only ways:
 *  - a shallower 70° cap — a hemisphere (90°) wraps past the ball's equator and
 *    is awkward to slip on, so the UI ships a 70° cap a new user sees;
 *  - a larger design margin (1.3 vs 1.06) so the default letter — and any
 *    artwork — sits inset from the cap edge with a comfortable border rather
 *    than running right to the rim.
 * DEFAULT_PARAMS itself stays a faithful mirror of ball_stencil/config.py (90°,
 * 1.06) so the golden parity tests keep validating the pipeline against the
 * Python oracle at the oracle's parameters.
 */
export const UI_DEFAULT_PARAMS: Params = { ...DEFAULT_PARAMS, cap_angle_deg: 70.0, design_margin: 1.3 };

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
  if (p.mesh_strategy !== "constrained" && p.mesh_strategy !== "centroid")
    throw new Error(`mesh_strategy must be 'constrained' or 'centroid', got ${p.mesh_strategy}`);
  if (!(p.boundary_smoothness_mm > 0))
    throw new Error(`boundary_smoothness_mm must be > 0, got ${p.boundary_smoothness_mm}`);
  // The constrained mesher relies on the cut dilation for a manifold cut edge and
  // does not grid-snap the contour, so cut_separation_svg must be > 0 for it.
  if (p.mesh_strategy === "constrained" && !(p.cut_separation_svg > 0))
    throw new Error(`cut_separation_svg must be > 0 for the 'constrained' mesher, got ${p.cut_separation_svg}`);
}
