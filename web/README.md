# ball-stencil (browser port)

A **fully client-side**, installable **PWA** that reproduces the Python
`ball-stencil` tool. Pick a filled SVG, optionally tweak parameters, watch a
live 3D preview of the resulting draw-through hemispherical stencil shell, and
download it as **STL** and **OBJ** (plus a reference ball STL). SVG parsing, 2D
geometry, sphere mapping, meshing, validation and export all run **in the
browser** — no server, no backend, no runtime network calls. After the first
visit it works **fully offline** and can be installed to the home screen / dock.

## Layout & interaction

The 3D view is the whole canvas; controls are lightweight translucent
(frosted-glass) overlays on top of it, not columns that shrink the view.

- **Full-bleed canvas.** The WebGL2 preview fills the viewport edge to edge.
  Orbit with one-finger drag / left-drag, pan with right-/shift-drag, zoom with
  the wheel or a two-finger pinch on touch. The canvas is sized to the *visual*
  viewport (`100dvh` + `visualViewport`) so iOS toolbar show/hide and the
  on-screen keyboard don't clip or distort it.
- **Always-visible status HUD.** The PASS / FAIL badge, the triangle/holes/R_ref
  readout, and any warnings — notably the **free-island** warning (the stencil
  would physically fall apart) — float persistently over the canvas, visible
  even when every panel is closed.
- **Launcher dock.** A small bottom dock of chips (Artwork, Parameters, Report,
  Download, View) opens one overlay at a time. Everything starts **collapsed**,
  so the default state is just the 3D view + the HUD. On desktop the overlays are
  non-modal floating cards; on tablet/phone (≤1024 px) they become **modal
  bottom-sheets** with a backdrop, focus trap, and Escape / backdrop-tap /
  swipe-down to close. Parameter groups are collapsible `aria-expanded` sections,
  each field carrying a one-line helper description.

## Persistence (resume where you left off)

The last loaded SVG (text + name), all parameter values, and panel/group
open state are saved to `localStorage` and restored — and the stencil rebuilt —
on launch. This is local only; nothing persisted triggers a network call.
Reads are defensive (corrupt / oversized values fall back to defaults + the
first-run reference-ball state) and writes survive `QuotaExceededError` (the
small metadata persists even if the ~140 kB SVG blob can't). `reset defaults`
forgets persisted parameter customizations.

## PWA / offline / updates

Built with `vite-plugin-pwa` in **`injectManifest`** mode: we author the service
worker ourselves (`src/sw.ts`) and the plugin only injects the precache list of
the real hashed `dist/` output — **including the lazy ~97 kB worker/pipeline
chunk that `index.html` never references**, which a hand-rolled glob would
silently miss. The SW precaches the whole app shell cache-first, so a full mesh
build + STL/OBJ export works with no network. Cache names are versioned and old
precaches are cleaned on activate. All SW traffic is same-origin.

Updates use the `prompt` flow (`virtual:pwa-register`): when a new build is
deployed, a non-intrusive **“Update available — Reload”** toast appears and
applies the waiting SW on tap; a subtle “Ready to work offline” toast confirms
first-time caching, and `beforeinstallprompt` (Android/desktop Chrome) surfaces
a dismissible **Install** action (iOS gets a one-time add-to-home-screen hint).

The Python package in the parent directory (`../ball_stencil/`) is the reference
implementation; this port matches its behaviour and output. `splash.svg` at
default parameters is the canonical target (51 holes, 2 material components incl.
a 24 mm² free island, signed volume ≈ 93675 mm³, watertight + 2-manifold).

## Run

```bash
npm install
npm run dev        # Vite dev server (the PWA dev SW is enabled via devOptions)
npm run build      # static production build into dist/  (deploy anywhere)
npm run preview    # serve the production build on :4173
```

Open the page, choose an SVG (try `fixtures/svg/splash.svg`), and adjust
parameters — the preview re-meshes live with a slow turntable spin.

Icons are generated from `public/icon.svg` into `public/` by
`npx pwa-assets-generator` (config in `pwa-assets.config.ts`); the committed
outputs (favicon, pwa-*, maskable, apple-touch-icon) only need regenerating when
the source icon changes. Both are dev-only.

**Dev caveat:** `devOptions.enabled` serves a service worker on `npm run dev`
too (so offline behaviour is testable without a build) without breaking HMR. If
a stale dev SW ever interferes, unregister it in DevTools → Application, or just
use `npm run preview` which serves the real production SW.

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
- **Browser e2e** (12 tests) runs against the **production preview build**
  (`playwright.config.ts` webServer = `npm run build && npm run preview`), so the
  real production service worker is active. It loads the built app, selects an
  SVG via the file input, changes parameters, and asserts: the report updates
  live (no Generate button) and converges after rapid edits; PASS + golden values
  appear; STL/OBJ/ball downloads are non-empty and the expected size; the main
  thread keeps ticking during a build; and no external network requests occur
  after load. Added PWA coverage: first-run idle state, favicon served (no 404),
  persistence/resume across reload, a **fully offline** boot + build + export
  (network disabled), and the update-available toast wiring. Controls live in
  collapsible launcher panels, so the e2e opens the relevant panel/group before
  reading or editing a control — the selectors and asserted report text
  (`#badge`, `#report-body`, `#p-<key>`, `#dl-*`) are unchanged.

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
  viewer.ts        ← hand-rolled WebGL2: shell + translucent ball, orbit + pinch + turntable
  ui/sheet.ts      ← launcher-panel / modal bottom-sheet manager (focus trap, Esc, swipe)
  persist.ts       ← localStorage save/restore (params + SVG + panel state)
  pwa.ts           ← SW registration + update/offline/install toasts
  sw.ts            ← the service worker (injectManifest precache, cache-first shell)
  main.ts          ← UI: file input, parameter panel, status HUD, report, downloads
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
| main UI (`index`) | ~27 kB (~10 kB gz) | loaded up front (UI + WebGL viewer + overlays/persistence/PWA glue) |
| `workbox-window` (PWA register) | ~6 kB (~2.4 kB gz) | tiny SW registration client |
| pipeline (worker, lazy) | ~97 kB (~30 kB gz) | Clipper2 + Delaunator + geometry |
| worker / css / small chunks | ~10 kB | |

Initial main-thread JS is ~27 kB (was ~17 kB before the immersive-UI + PWA
refactor: the overlay/sheet manager, persistence, and PWA registration glue add
~10 kB raw / ~3 kB gz). The ~97 kB geometry chunk still loads in the worker on
first build. The service worker runs on its own thread and bundles its Workbox
runtime at build time, so it adds nothing to the main-thread budget and makes no
runtime network call. No runtime CDN dependency — fully offline after load.

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
