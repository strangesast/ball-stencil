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

1. **`svgio`** — load filled `<path>`s, adaptively tessellate Béziers (chord
   ≤ 0.10 mm), fold subpaths with even-odd to get the exact filled region.
2. **`meshbuild`** — material = disc − filled splashes (the holes); densify
   boundary + hex-lattice interior → Delaunay → keep triangles inside material.
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
| `TARGET_EDGE_MM` | 1.2 | nominal triangle edge on the sphere |
| `CHORD_ERROR_MM` | 0.10 | Bézier flattening budget |
| `CUT_SEPARATION_SVG` | 0.30 | hole dilation; clears pinches / thin webbing |
| `MIN_ISLAND_AREA_MM2` | 1.0 | drop free islands below this (warns above) |

## Notes / limitations

- **Free islands:** material fully enclosed by a hole (e.g. one enclosed region
  inside `splash_2`, ≈27 mm²) would fall out of a physical stencil. These are
  detected and reported; tune `MIN_ISLAND_AREA_MM2` or add a bridge to keep them.
- **Sliver triangles:** ~7 % of faces along cut edges exceed the 5:1 aspect
  target (inherent to point-cloud Delaunay). The mesh is watertight and
  non-degenerate; a constrained Delaunay refinement (`triangle`/CGAL) would
  tighten this if manufacturing requires it.
- STEP/CAD export is not implemented (mesh output only).
