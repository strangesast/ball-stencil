"""Central configuration for the ball-stencil pipeline.

Every physical / geometric parameter lives here as a named constant so the
output scales from these values only (per spec requirement). All lengths are
in millimetres and all computation downstream is float64.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import radians

import numpy as np

# ----------------------------------------------------------------------------
# Sphere / ball definition  (the stencil is fitted over this ball)
# ----------------------------------------------------------------------------
SPHERE_DIAMETER_MM = 206.0                       # regulation volleyball, configurable
BALL_RADIUS_MM = SPHERE_DIAMETER_MM / 2.0        # 103.0

# ----------------------------------------------------------------------------
# Stencil shell (the thing we actually manufacture)
# ----------------------------------------------------------------------------
# The stencil is a thickened hemispherical shell that slips over the ball.
# Its inner surface sits at BALL_RADIUS + clearance; the wall extends outward.
FIT_CLEARANCE_MM = 0.4          # gap between ball and stencil inner wall (slip fit)
WALL_THICKNESS_MM = 2.0         # radial wall thickness of the shell

INNER_RADIUS_MM = BALL_RADIUS_MM + FIT_CLEARANCE_MM     # 103.4
OUTER_RADIUS_MM = INNER_RADIUS_MM + WALL_THICKNESS_MM   # 105.4

# How far down the ball the dome reaches, measured as polar angle from the pole.
# 90 deg == full hemisphere (rim at the equator).
CAP_ANGLE_DEG = 90.0

# ----------------------------------------------------------------------------
# Design placement on the dome
# ----------------------------------------------------------------------------
# Mapping family. Only "lambert" (azimuthal equal-area) is wired up; the other
# names document the alternatives discussed.
MAPPING = "lambert"             # lambert | equidistant | stereographic

# Centre of the SVG that maps to the dome pole. None -> use viewBox centre.
DESIGN_CENTER_UV = None         # (x, y) in SVG user units, or None

# Reference radius (SVG units) that maps to CAP_ANGLE_DEG. None -> derived from
# the artwork extent times DESIGN_MARGIN (leaves a material frame around it).
DESIGN_REFERENCE_RADIUS = None
DESIGN_MARGIN = 1.06            # rim sits this factor beyond the outermost artwork

# Match the scale + centre of another SVG so designs that share a coordinate
# system register identically on the sphere. None -> use this file's own extent.
# When set, R_ref and centre are taken from the reference file, NOT this one.
MATCH_SVG = None

# SVG y axis points down. Flip so the design is not mirrored when the dome is
# viewed from outside looking at the pole.
FLIP_V = True

# ----------------------------------------------------------------------------
# Curve tessellation (Bezier -> polyline)
# ----------------------------------------------------------------------------
CHORD_ERROR_MM = 0.10           # max chord deviation on the sphere surface
MIN_SEGMENT_MM = 0.05           # smallest arc-length segment we bother emitting

# ----------------------------------------------------------------------------
# Surface meshing
# ----------------------------------------------------------------------------
TARGET_EDGE_MM = 1.2            # nominal triangle edge length on the sphere
MAX_EDGE_MM = 1.5               # quality target / reporting threshold

# Which surface-mesher builds the shell from the 2D material region:
#   "constrained" -- conforming Delaunay (poly2tri): the cut-hole boundary IS the
#                    design contour (constraint edges), so the traced edge follows
#                    the artwork smoothly.  Interior filled with TARGET_EDGE points.
#   "centroid"    -- legacy: unconstrained Delaunay of sampled points, keep a
#                    triangle iff its centroid is inside the material.  The cut
#                    edge is then a by-product of the centroid test and comes out
#                    faceted / sawtoothed (kept for comparison + as a fallback).
MESH_STRATEGY = "constrained"

# Boundary-smoothness tolerance (mm on the sphere): how closely the *cut edge*
# follows the true design curve, DECOUPLED from TARGET_EDGE_MM (triangle size).
# Only the "constrained" mesher honours this -- the contour is flattened to this
# chord error and used verbatim as the constrained boundary, so making triangles
# bigger for speed never coarsens the drawn edge. Finer than CHORD_ERROR_MM.
BOUNDARY_SMOOTHNESS_MM = 0.04

# ----------------------------------------------------------------------------
# Numerical
# ----------------------------------------------------------------------------
DTYPE = np.float64
RADIUS_TOLERANCE_MM = 0.01      # |‖P‖ - R| must stay under this

# Topology cleanup grid (SVG user units). Coordinates are snapped to this grid
# to merge near-coincident boundaries, remove sub-grid slivers, and guarantee a
# clean manifold. Kept far below the chord-error budget.
SNAP_GRID_SVG = 0.05

# Cut-hole dilation (SVG user units). Holes are grown by this amount before the
# material is subtracted. This separates/merges boundaries that meet at a single
# point (which would otherwise pinch the shell into a non-manifold) and removes
# unprintably-thin webbing between adjacent splashes.
CUT_SEPARATION_SVG = 0.30

# Drop disconnected material islands smaller than this surface area (mm^2).
# Such islands (e.g. the enclosed hole inside splash_2) would fall out of a real
# stencil. The default removes XOR noise specks while keeping (and warning about)
# genuinely large free islands. Set 0 to keep everything.
MIN_ISLAND_AREA_MM2 = 1.0


@dataclass
class Config:
    """Runtime bundle; defaults pull from the module-level constants."""

    svg_path: str = "splash.svg"
    out_dir: str = "out"

    sphere_diameter_mm: float = SPHERE_DIAMETER_MM
    fit_clearance_mm: float = FIT_CLEARANCE_MM
    wall_thickness_mm: float = WALL_THICKNESS_MM
    cap_angle_deg: float = CAP_ANGLE_DEG

    mapping: str = MAPPING
    design_center_uv: tuple[float, float] | None = DESIGN_CENTER_UV
    design_reference_radius: float | None = DESIGN_REFERENCE_RADIUS
    design_margin: float = DESIGN_MARGIN
    match_svg: str | None = MATCH_SVG
    flip_v: bool = FLIP_V

    chord_error_mm: float = CHORD_ERROR_MM
    min_segment_mm: float = MIN_SEGMENT_MM
    target_edge_mm: float = TARGET_EDGE_MM
    max_edge_mm: float = MAX_EDGE_MM
    mesh_strategy: str = MESH_STRATEGY
    boundary_smoothness_mm: float = BOUNDARY_SMOOTHNESS_MM

    radius_tolerance_mm: float = RADIUS_TOLERANCE_MM
    min_island_area_mm2: float = MIN_ISLAND_AREA_MM2
    snap_grid_svg: float = SNAP_GRID_SVG
    cut_separation_svg: float = CUT_SEPARATION_SVG

    @property
    def ball_radius_mm(self) -> float:
        return self.sphere_diameter_mm / 2.0

    @property
    def inner_radius_mm(self) -> float:
        return self.ball_radius_mm + self.fit_clearance_mm

    @property
    def outer_radius_mm(self) -> float:
        return self.inner_radius_mm + self.wall_thickness_mm

    @property
    def cap_angle_rad(self) -> float:
        return radians(self.cap_angle_deg)

    def validate(self) -> None:
        """Reject physically/numerically invalid parameters.

        Called by the pipeline *after* CLI and ``--match`` overrides are
        applied, so values mutated after construction are still checked.
        Catches the divisions-by-zero and singular mappings that otherwise
        surface deep in the geometry as a hang or silent garbage mesh.
        """
        if not self.sphere_diameter_mm > 0:
            raise ValueError(f"sphere_diameter_mm must be > 0, got {self.sphere_diameter_mm}")
        if self.fit_clearance_mm < 0:
            raise ValueError(f"fit_clearance_mm must be >= 0, got {self.fit_clearance_mm}")
        if not self.wall_thickness_mm > 0:
            raise ValueError(f"wall_thickness_mm must be > 0, got {self.wall_thickness_mm}")
        # 0 deg -> scales collapse to 0 -> spacing = edge/0 = inf (grid blowup);
        # 180 deg -> Lambert is singular at the rim.
        if not 0.0 < self.cap_angle_deg < 180.0:
            raise ValueError(f"cap_angle_deg must be in (0, 180), got {self.cap_angle_deg}")
        if not self.design_margin > 0:
            raise ValueError(f"design_margin must be > 0, got {self.design_margin}")
        if self.design_reference_radius is not None and not self.design_reference_radius > 0:
            raise ValueError(
                f"design_reference_radius must be > 0, got {self.design_reference_radius}"
            )
        if not self.target_edge_mm > 0:
            raise ValueError(f"target_edge_mm must be > 0, got {self.target_edge_mm}")
        if not self.chord_error_mm > 0:
            raise ValueError(f"chord_error_mm must be > 0, got {self.chord_error_mm}")
        if self.mesh_strategy not in ("constrained", "centroid"):
            raise ValueError(
                f"mesh_strategy must be 'constrained' or 'centroid', got {self.mesh_strategy!r}"
            )
        if not self.boundary_smoothness_mm > 0:
            raise ValueError(
                f"boundary_smoothness_mm must be > 0, got {self.boundary_smoothness_mm}"
            )
        # The constrained mesher uses the cut dilation as its manifold guarantee
        # and deliberately does NOT grid-snap the contour, so nothing else welds
        # coincident boundary points; cut_separation_svg must be > 0 for it.
        if self.mesh_strategy == "constrained" and not self.cut_separation_svg > 0:
            raise ValueError(
                "cut_separation_svg must be > 0 for the 'constrained' mesher "
                f"(it guarantees a manifold cut edge), got {self.cut_separation_svg}"
            )
