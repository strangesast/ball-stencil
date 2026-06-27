# Ball-wear distortion stack (tileable SVG filters)

Make new wordmark text look like it was *printed on this ball and scuffed with it* —
matching the dimpling and ink wear — by stacking tileable SVG filter layers over
clean vector glyphs. Swap the text string and the whole distortion stack re-applies.

## Layers (each isolated + individually reviewable)

| Layer | id | How |
| ----- | -- | --- |
| Dimples (pebble relief) | `#dimples` | `feTurbulence fractalNoise` + `stitchTiles`, grayscaled |
| Erosion (worn-through ink) | `#erosion` | threshold of the **same** noise → speckle mask |
| Highlights (dimple specular) | `#highlights` | `feSpecularLighting` of the **same** noise |
| Wear (full stack on glyphs) | `#wear` | edge displacement + relief-coupled erosion + soft print edge |

The one `feTurbulence` source feeds erosion, displacement *and* highlights, so worn
spots and highlights stay spatially coherent — that coherence is what sells it.

## Tiling

The noise uses `stitchTiles="stitch"` inside a `<pattern>` whose size (**256**) divides
both the equirectangular period (**2048**) and the logo spacing (**1024**), so it wraps
seamlessly across the ball seam. Constraint: `dimple_freq × tile` must be an integer
(the builder warns otherwise). See `examples/tiling_proof.png` — the texture flows
straight through the red tile boundaries.

## Examples of the full composition

`examples/composite_*.png` — the full stack applied to several words (Wumbo, Wilson,
AVP), next to `flat_baseline.png` (no wear). `examples/contact_sheet.png` shows every
isolated layer, the full compositions, and the tiling proof together. Open
`review.html` for the same as a live page.

## Build

```
python tools/wear/build_wear.py
```

Regenerates `layers/*.svg` (standalone, reviewable sources), `examples/*.png`, the
contact sheet and `review.html` from `wear.config.json`.

`feTurbulence` is deterministic per renderer, so the build is pinned to one headless
**Chromium** (auto-located under `/opt/pw-browsers`, or set `$CHROME`). Other engines
(resvg, Cairo, Inkscape) implement `feDisplacementMap`/turbulence/lighting differently
and will not match pixel-for-pixel.

## Calibration

`wear.config.json` holds every parameter. Defaults are calibrated from the recovered
original `ball_optx.jpg`: `dimple_freq` from the measured pebble grain (~11 px), and
`ink` / `panel_*` colors sampled from the worn Wilson panel.

| key | meaning |
| --- | --- |
| `tile` | pattern tile size (divisor of 2048 / 1024) |
| `dimple_freq`, `dimple_octaves`, `seed` | the noise / pebble grain |
| `wear_table` | `feComponentTransfer` curve: noise → ink-survival (erosion amount) |
| `displace_scale` | ragged-edge strength |
| `light_azimuth`, `light_elevation` | dimple-highlight light direction |
| `ink`, `panel_top`, `panel_bottom` | sampled colors |
| `words`, `font_size` | which full-composition examples to render |

## Limitations / next steps

- `feTurbulence` is Perlin (broadband 1/f) — a good match for the pebble *statistics*,
  but slightly sandpapery vs. the rounded dimple *cells*. For an exact match, import a
  captured relief map via `feImage` (trade-off: resolution-dependent, needs registration).
- The spherical/equirectangular warp is **not** a filter — apply panel curvature with a
  curved `textPath` (or a mesh warp) before this stack, keeping it seam-continuous.
