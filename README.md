# ball-stencil

Convert filled SVG artwork into a **watertight, draw-through hemispherical stencil
shell** that slips over a ball. The SVG fill becomes **through-cut holes**: place
the dome over the ball, draw/paint through the holes, lift it off, and the artwork
is on the ball.

The SVG is treated strictly as **vector geometry** (analytic parameterization onto
the sphere — no raster, texture, or projection).

## Run

```bash
uv run python -m ball_stencil splash.svg
```

Outputs to `out/`:

| file | description |
|------|-------------|
| `splash_stencil.stl` | manufacturing mesh (binary STL) |
| `splash_stencil.obj` | debug/inspection mesh |
| `ball_reference.stl` | the Ø206 mm ball, for fit/visual context |

Common overrides (all also live as constants in `ball_stencil/config.py`):

```bash
uv run python -m ball_stencil splash.svg \
  --diameter 206 --clearance 0.4 --wall 2.0 --cap-angle 90 --target-edge 1.2
```

## How it works

1. **`svgio`** — load filled `<path>`s, adaptively tessellate Béziers, fold
   subpaths with even-odd to get the exact filled region.
2. **`meshbuild`** — material = disc − filled splashes (the holes), then one of
   two surface meshers (`MESH_STRATEGY`):
   - **`constrained`** (default) — conforming Delaunay (poly2tri): the design
     contour is a *constrained* boundary, so the **cut edge IS the artwork curve**
     (smooth, ideal for tracing). Interior filled with a `TARGET_EDGE_MM` hex
     lattice of Steiner points. The contour is flattened to the finer
     `BOUNDARY_SMOOTHNESS_MM` budget and Douglas-Peucker reduced (decoupled from
     triangle size, so coarser triangles never coarsen the drawn edge).
   - **`centroid`** (legacy) — densify boundary + hex interior → *unconstrained*
     Delaunay → keep triangles whose centroid is inside the material. The cut
     edge is then a by-product of the centroid test and comes out faceted /
     sawtoothed; kept for comparison and as a fallback.
3. **`mapping`** — Lambert azimuthal **equal-area** parameterization: SVG centre →
   dome pole, `ρ ∝ sin(φ/2)`, scaled so the design radius lands at the cap angle.
   Every vertex maps to the inner (R + clearance) and outer (+ wall) radii.
4. Stitch top + bottom + side walls around the rim **and** every hole → one
   closed manifold. Non-manifold pinch vertices are split automatically.
5. **`meshcheck`** — verifies watertight, 2-manifold, consistent winding,
   `|‖P‖−R| ≤ 0.01 mm`, plus triangle-quality stats.
6. **`export`** — binary STL + OBJ (dependency-free writers).

## Key parameters (`config.py`)

| constant | default | meaning |
|----------|---------|---------|
| `SPHERE_DIAMETER_MM` | 206.0 | ball diameter (regulation volleyball) |
| `FIT_CLEARANCE_MM` | 0.4 | gap between ball and shell (slip fit) |
| `WALL_THICKNESS_MM` | 2.0 | radial shell wall thickness |
| `CAP_ANGLE_DEG` | 90 | how far down the ball the dome reaches |
| `MAPPING` | `lambert` | equal-area wrap of the design onto the dome |
| `MESH_STRATEGY` | `constrained` | surface mesher: `constrained` (smooth cut edge) or `centroid` (legacy faceted) |
| `BOUNDARY_SMOOTHNESS_MM` | 0.04 | how closely the cut edge follows the design curve (constrained); decoupled from triangle size |
| `TARGET_EDGE_MM` | 1.2 | nominal triangle edge on the sphere |
| `CHORD_ERROR_MM` | 0.10 | Bézier flattening budget (centroid mesher) |
| `CUT_SEPARATION_SVG` | 0.30 | hole dilation; clears pinches / thin webbing |
| `MIN_ISLAND_AREA_MM2` | 1.0 | drop free islands below this (warns above) |

## Notes / limitations

- **Free islands:** material fully enclosed by a hole (e.g. one enclosed region
  inside `splash_2`, ≈27 mm²) would fall out of a physical stencil. These are
  detected and reported; tune `MIN_ISLAND_AREA_MM2` or add a bridge to keep them.
- **Cut-edge smoothness:** the default `constrained` mesher keeps the traced cut
  edge within `BOUNDARY_SMOOTHNESS_MM` (≈0.04 mm) of the true design curve — no
  centroid sawtooth, no grid stair-steps. The legacy `centroid` mesher faceted
  the edge to ~1 triangle edge; switch back with `MESH_STRATEGY=centroid` only
  for comparison or as a fallback.
- **Sliver triangles:** a thin band of higher-aspect triangles can remain along
  the cut edge (denser boundary than interior). These are non-degenerate and do
  not affect the traced edge, watertightness, or printability.
- STEP/CAD export is not implemented (mesh output only).
