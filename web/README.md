# ball-stencil (browser port)

A **fully client-side** web app that reproduces the Python `ball-stencil` tool.
Pick a filled SVG, optionally tweak parameters, watch a live 3D preview of the
resulting draw-through hemispherical stencil shell, and download it as **STL**
and **OBJ** (plus a reference ball STL). SVG parsing, 2D geometry, sphere
mapping, meshing, validation and export all run **in the browser** — no server,
no backend, no runtime network calls.

The Python package in the parent directory (`../ball_stencil/`) is the reference
implementation; this port matches its behaviour and output. `splash.svg` at
default parameters is the canonical target (51 holes, 2 material components incl.
a 24 mm² free island, signed volume ≈ 93675 mm³, watertight + 2-manifold).

## Run

```bash
npm install
npm run dev        # Vite dev server
npm run build      # static production build into dist/  (deploy anywhere)
npm run preview    # serve the production build on :4173
```

Open the page, choose an SVG (try `fixtures/svg/splash.svg`), and adjust
parameters — the preview re-meshes live with a slow turntable spin.

## Tests

Two layers, sharing one golden source of truth (`fixtures/golden.json`, captured
from the Python oracle):

```bash
npm test           # pipeline parity tests (Vitest, headless, fast)
npm run test:e2e   # browser e2e (Playwright): drives the real app
```

- **Pipeline parity** runs the DOM-free geometry pipeline over a config matrix
  (`splash.svg`, `splash_z.svg`, plus synthetic fixtures varying wall, cap angle,
  target edge, diameter, fit clearance, min-island) and asserts the exact
  topological invariants (watertight / manifold / winding, cut-hole count,
  component count, `R_ref`, radii, ~zero radius error, 0 degenerate triangles),
  the signed volume within ±1% for the `splash` targets, free-island detection,
  STL byte length (`84 + 50·nFaces`) and OBJ vert/face parsing, plus error cases.
- **Browser e2e** loads the built app, selects an SVG via the file input,
  changes parameters, and asserts: the report updates live (no Generate button)
  and converges after rapid edits; PASS + golden values appear; STL/OBJ/ball
  downloads are non-empty and the expected size; the main thread keeps ticking
  during a build; and no external network requests occur after load.

Regenerate the golden fixtures from the Python oracle (run from the repo root):

```bash
uv run python web/fixtures/gen_golden.py
```

## Architecture

The main thread does **only** UI, parameter editing/validation, and rendering.
**All** expensive computation runs in a Web Worker:

```
src/
  pipeline/        ← pure, DOM-free geometry pipeline (runs in worker AND Node tests)
    svg.ts           SVG document parse (viewBox + <path> d/label/visibility)
    tessellate.ts    path-data parse + adaptive Bézier/arc flattening
    svgio.ts         even-odd filled region (XOR fold)
    clip.ts          2D boolean/offset/precision ops over Clipper2 + spatial indices
    mapping.ts       Lambert azimuthal equal-area plane→sphere map + scales
    meshbuild.ts     material region, sampling, Delaunay, pinch-split, wall stitching
    meshcheck.ts     watertight/manifold/winding/radius/quality validation
    exportmesh.ts    binary STL + OBJ writers, UV reference sphere
    pipeline.ts      orchestration (two-pass chord budget → build → validate)
  worker.ts        ← receives params, runs the pipeline, posts transferable buffers
  viewer.ts        ← hand-rolled WebGL2: shell + translucent ball, orbit + turntable
  main.ts          ← UI: file input, parameter panel, report, downloads
```

Mesh buffers are transferred back as `ArrayBuffer` (zero copy). Builds are
debounced and superseded by a monotonic job id, so the latest parameters always
win and the page never freezes — even on large SVGs or fine `target_edge_mm`.

## Dependencies (and why)

Runtime dependencies are deliberately minimal, mature, and near-zero-dep:

| package | role | justification |
|---|---|---|
| `clipper2-js` (1.2.4) | 2D boolean ops + polygon offset | The one substantial, justified dependency. Robust even-odd union, difference, offsetting and precision handling — the direct analogue of Shapely/GEOS. Reimplementing robust polygon booleans would be large and error-prone. Pure TypeScript, no transitive deps, no WASM to go stale. |
| `delaunator` (5.1.0) | Delaunay triangulation | Tiny, zero-dependency, stable, effectively "done". |

Everything else is the **platform**: SVG parsing via a small DOM-free parser,
path flattening by the adaptive recursive-subdivision algorithm, the 3D preview
as hand-rolled **WebGL2** (no three.js), and dependency-free STL/OBJ writers.

Dev-only: `vite`, `typescript`, `vitest`, `@playwright/test`.

### Bundle size

The heavy geometry module (Clipper2 + Delaunator + the pipeline) is **lazy-loaded
inside the worker**, so it never touches the initial main-thread payload.
Approximate production output (`npm run build`, raw / gzip):

| chunk | raw | role |
|---|---|---|
| main UI (`index`) | ~17 kB (~7 kB gz) | loaded up front (UI + WebGL viewer) |
| pipeline (worker, lazy) | ~97 kB (~30 kB gz) | Clipper2 + Delaunator + geometry |
| worker / css / small chunks | ~7 kB | |

Initial main-thread JS is ~17 kB; the ~97 kB geometry chunk loads in the worker
on first build. No runtime CDN or network dependency — fully offline after load.

## Parity notes / limitations

- **Exact** (must match): watertight / manifold / winding, cut-hole count,
  material-component count, `R_ref`, inner/outer radii, mapping centre,
  free-island detection, ≈machine-epsilon radius error, 0 degenerate triangles.
- **Signed volume** (key continuous invariant) matches the `splash` targets
  within ±1%.
- **Density-dependent** values (vertex/face counts, edge stats, max aspect ratio)
  differ slightly because Delaunator is not bit-identical to GEOS — treated as
  ballpark, as the spec allows.
- **Free-island area** (mm²) is matched within ~10%: detection and count are
  exact, but the small enclosed area depends on the boolean engine
  (Clipper2 vs GEOS).
- The `--match` reference-SVG registration feature is **not yet supported** in
  this v1 (the parameters `design_reference_radius` / `design_center_uv` it would
  drive are fully configurable in the panel).
- Only the Lambert azimuthal equal-area mapping is implemented (the `mapping`
  field is kept for future modes), matching the reference.
