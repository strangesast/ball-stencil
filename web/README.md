# ball-stencil (browser port)

A **fully client-side**, installable **PWA** that reproduces the Python
`ball-stencil` tool. Type a letter or pick a filled SVG, optionally tweak
parameters, watch a live 3D preview of the resulting draw-through hemispherical
stencil shell, and download it as **STL** and **OBJ** (plus a reference ball
STL). SVG parsing, 2D geometry, sphere mapping, meshing, validation and export
all run **in the browser** — no server, no backend, no runtime network calls.
After the first visit it works **fully offline** and can be installed to the
home screen / dock.

## Artwork: a letter, a filled SVG, or a raster image

Everything downstream consumes a parsed SVG, so the front doors converge on one
routine (`loadSvgText` in `main.ts`, used by the file picker, drag-drop, the
letter generator, and the raster tracer). A single file input (`selectFile`)
routes SVG → `loadSvgText` and raster → the trace worker by type:

- **Generate from a letter.** Type a character or short string (≤ 4) in the
  Artwork panel and the app synthesizes a clean `<svg viewBox><path d/></svg>`
  from a bundled font and feeds it straight into the pipeline. Builds live
  (debounced) as you type, or on **Generate** / Enter. The letter becomes the
  download name (`B_stencil.stl`). The bundled face is a **stencil** font, so
  counter letters (B, O, A, …) come pre-bridged: their bowls join the outside
  through bridge gaps and are emitted as side-by-side solid pieces rather than a
  ring + enclosed counter, so the stencil sheet stays one connected component
  and no letter raises the free-island warning. Whitespace / unfillable input is
  rejected inline; it never builds blank.
- **Glyph → SVG** lives in `src/glyph.ts`. `glyphToSvg()` lazy-loads
  [opentype.js] + the precached font and delegates to the pure, DOM-free
  `buildGlyphSvg(font, text)` (unit-tested against `parseSvg`/`loadArtwork`).
  `getPath().toPathData()` gives absolute, transform-free, y-down-upright
  outlines — the same convention the bundled Inkscape samples use, so the
  pipeline's default `flip_v` un-mirrors a generated letter with no toggle.
- **Bundled font.** A single heavy *stencil* face, **Stardos Stencil Bold**
  subset to printable ASCII (`public/fonts/StardosStencil-Bold-subset.woff`,
  **~10 KB**; OFL license alongside). A stencil face on purpose — every counter
  is bridged to the outside, so generated letters never carve an enclosed island
  that would fall out of a real cut (the free-island warning); it is also heavy/
  high-contrast, since thin or serif strokes trace poorly and produce slivers
  downstream. opentype.js itself is a lazy ~50 KB-gzip chunk, loaded only when a
  letter is first generated.
- **Trace a raster (PNG/JPG/WebP/BMP/GIF).** Pick or drop an image and it is
  traced to a filled monochrome **silhouette** SVG, then fed through the identical
  pipeline. The Artwork panel has a backend toggle — **Potrace** (clean,
  [esm-potrace-wasm]) / **Color** (photo-tolerant, [imagetracerjs]) — and a
  threshold slider; both persist. Decode + trace run in `src/trace.worker.ts`
  (createImageBitmap + OffscreenCanvas, lazy backend), never on the main thread;
  the pure, DOM-free core is `src/pipeline/trace.ts` (mirrors the Python
  `ball_stencil/raster.py`, unit-tested against `parseSvg`/`loadArtwork`). Colour
  is out of scope — the trace is a silhouette whose dominant sampled colour becomes
  the projection paint, exactly like a typed letter. esm-potrace-wasm marshals the
  image onto a 64 KB wasm stack, so raster inputs are downscaled to ≈12k pixels for
  the potrace backend (a silhouette is low-frequency and the cut-edge fidelity is
  governed downstream, so this is not a quality loss in practice).

**First-run default.** A brand-new visitor (no restored SVG) immediately sees a
finished sample stencil — the letter **Z**, built through the same generator
(a crisp bold glyph; with the stencil face first paint is a clean PASS with no
free-island warning). The sample is a placeholder, not user data: it is
re-derived on each empty launch, **never persisted** (so it can't resurrect over
something the user intentionally cleared), labelled *“Showing a sample …”*, and
its downloads carry a `_sample` tag. The instant the user uploads, drops, or
generates anything, that replaces the sample permanently for the session and
persists like any upload. A returning user's restored SVG is untouched.

[opentype.js]: https://github.com/opentypejs/opentype.js
[esm-potrace-wasm]: https://www.npmjs.com/package/esm-potrace-wasm
[imagetracerjs]: https://www.npmjs.com/package/imagetracerjs

## Layout & interaction

The 3D view is the whole canvas; controls are lightweight translucent
(frosted-glass) overlays on top of it, not columns that shrink the view.

- **Full-bleed canvas.** The WebGL2 preview fills the viewport edge to edge.
  The camera is a **free trackball** orbiting a fixed pivot at the ball centre
  (the world origin), so the ball stays centred in the viewport through every
  manipulation and there is **no pole/gimbal lock** — you can spin the full
  circumference around any axis. Drag (one finger / left-drag) to rotate; the
  wheel or a **two-finger gesture** zooms *and* rotates *and* twists (roll) at
  once on touch. There is deliberately no pan (it would push the centre
  off-screen). The canvas is sized to the *visual* viewport (`100dvh` +
  `visualViewport`) so iOS toolbar show/hide and the on-screen keyboard don't
  clip or distort it.
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

## View: projection on the ball vs the 3D stencil

The **View** panel leads with a prominent **Preview** segmented control (visually
elevated above the secondary scene toggles) switching between two renderings of
the same build:

- **Projection (on ball)** — the **default first view**. The design is shown
  **painted onto the simulated ball**, exactly as it looks after you slip the
  stencil on, draw through the holes, and lift it off.
- **3D stencil** — the opaque draw-through shell over the textured ball.

Surrounding controls (all view-only — they never rebuild the mesh):

- **Project onto (Top / Front / Back)** — a first-class control that rotates
  which face of the ball the design lands on, in **both** modes (the on-ball
  paint *and* the 3D shell rotate together). Switching is instant (a model-matrix
  rotation) and the design reads un-mirrored from outside on every face (pure
  rotations preserve the `flip_v` un-mirroring).
- **Custom paint colour** — the projection paint defaults to the design's own
  SVG `fill` (read from the artwork in the worker) and falls back to a built-in
  ink tone when the artwork specifies none. Ticking **Custom paint colour**
  overrides it with a chosen swatch. The letter generator has its own colour
  swatch that is embedded as the generated glyph's `fill`, so a typed letter
  flows in like a coloured upload.
- **Reference ball** — when off in projection mode, the paint is drawn on a
  **transparent sphere**: a depth-only occluder (colour writes masked) still
  hides the far side of the decal, so the graphic reads as wrapping a clear
  sphere rather than a flat cut-out.
- **Spin axis (Vertical / Horizontal / Depth)** — the auto-rotate turntable axis,
  configurable just like *Project onto*.

The **default sample letter** sits inset from the cap edge (the app default
`design_margin` is 1.3, vs the pipeline oracle's 1.06) so a fresh visitor sees
the design occupying a comfortable fraction of the ball rather than running to
the rim.

**Parity is by construction, not approximation.** The painted decal is the same
`cut` (through-holes) region the mesher subtracts from the disc
(`cut = artwork ⊕ cut_separation_svg`), triangulated in the worker and lifted to
the ball by the **same `Mapper`** the shell's vertices use —
`mapper.direction(x, y) · (ball_radius + ε)` with a tiny outward `ε` (0.3 mm,
plus a polygon-offset bias) so it sits just above the surface without
z-fighting. There is no second SVG parse, texture rasterization, or re-derived
Lambert math, so the projection can never drift from where the stencil actually
cuts. A pipeline unit test asserts every decal vertex lies on the sphere and
equals the shared mapper's output; an e2e test asserts the default mode is
projection and that mode/target changes reorient without a rebuild. The decal is
**view-only** — it is never exported and never part of mesh validation, so the
STL/OBJ output and the golden parity tests are untouched.

The render mode, projection target, spin axis, and paint-colour override all
**persist** across reloads alongside the other panel state. Both decal buffers
ride the existing worker `result` message as transferables and add **no new
dependency** (the decal reuses the in-tree `delaunator`/poly2tri mesher and
`Mapper`; the colour helpers are a ~1 KB dependency-free module); the bundle is
otherwise unchanged.

## Persistence (resume where you left off)

The last loaded SVG (text + name), all parameter values, and panel/group
open state are saved to `localStorage` and restored — and the stencil rebuilt —
on launch. This is local only; nothing persisted triggers a network call.
Reads are defensive (corrupt / oversized values fall back to defaults + the
first-run sample letter) and writes survive `QuotaExceededError` (the small
metadata persists even if the ~140 kB SVG blob can't). When no SVG is restored,
the bundled sample letter fills the void without being persisted (see *Artwork*
above). `reset defaults` forgets persisted parameter customizations only — it
does not touch the artwork.

The app ships a **70° cap** by default (`UI_DEFAULT_PARAMS`) — a full hemisphere
(90°) wraps past the ball's equator and is fiddly to slip on — which is what a
new user sees and what `reset defaults` returns to. The pipeline's
`DEFAULT_PARAMS` stays a faithful 90° mirror of `ball_stencil/config.py`, so the
golden parity tests keep validating the geometry against the Python oracle at the
oracle's parameters; only the app-facing initial value differs.

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
    meshbuild.ts     material region, constrained (poly2tri) / centroid mesher, pinch-split, walls
    meshcheck.ts     watertight/manifold/winding/radius/quality validation
    exportmesh.ts    binary STL + OBJ writers, UV reference sphere
    pipeline.ts      orchestration (two-pass chord budget → build → validate)
  worker.ts        ← receives params, runs the pipeline, posts transferable buffers
  viewer.ts        ← hand-rolled WebGL2: shell / on-ball projection decal + textured ball, orbit + pinch + turntable
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
| `clipper2-js` (1.2.4) | 2D boolean ops (union / difference / even-odd) | Robust polygon booleans, the direct analogue of Shapely/GEOS. Pure TypeScript, no transitive deps. (Its `ClipperOffset` is **not** used — see below.) |
| `js-angusj-clipper` (1.3.1) | cut-hole dilation (polygon offset only) | clipper2-js's offset produces spiral "curl" artifacts when dilating the overlapping artwork blobs (a smooth region becomes a sawtooth cut edge); the original, battle-tested Clipper (Angus Johnson v1) offsets it cleanly, matching Shapely. Inlined WASM (asm.js fallback), so it bundles + precaches like any JS and works offline. Loaded once in the worker; offsets are synchronous after. |
| `delaunator` (5.1.0) | unconstrained Delaunay | Tiny, zero-dependency, stable. Used by the legacy `centroid` mesher. |
| `poly2tri` (1.5.0) | constrained Delaunay triangulation | Powers the default `constrained` mesher: the design contour is a constraint edge so the cut edge follows the artwork smoothly. The same algorithm runs in the Python reference (`pypoly2tri`), keeping the two ports in lockstep. Pure JS, no transitive deps. |
| `opentype.js` (1.3.4) | letter → filled glyph outline | Parses the bundled subset font and emits a glyph's exact filled outline (counters as separate contours) as SVG `d` data, so the letter generator produces true filled shapes offline. Lazy-loaded on the main thread only when a letter is first generated. Zero transitive deps. |

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
| pipeline (worker, lazy) | ~120 kB | Clipper2 + Delaunator + geometry |
| `opentype.js` (lazy) | ~174 kB (~50 kB gz) | letter outlines — loaded only on first letter generation, never on a pure-upload session |
| Stardos Stencil Bold subset (`.woff`) | ~10 kB | bundled stencil font for the letter generator, precached |
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
