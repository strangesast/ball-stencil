#!/usr/bin/env python3
"""Build the tileable "ball wear" distortion stack as SVG filters and render it.

Each kind of distortion is an isolated, named, *tileable* SVG <filter> so it can be
reviewed in isolation:

  - #dimples    : pebble micro-relief         (feTurbulence fractalNoise, stitchTiles)
  - #erosion    : worn-through ink speckle     (threshold of the SAME noise)
  - #highlights : dimple specular highlights   (feSpecularLighting of the SAME noise)
  - #wear       : the full stack on glyphs     (edge displacement + relief-coupled
                                                erosion + soft print edge)

Tiling: the noise uses stitchTiles="stitch" inside a <pattern> whose size (256) divides
the equirectangular period (2048) and the logo spacing (1024), so it wraps seamlessly
across the ball seam. The same feTurbulence feeds erosion, displacement and highlights
so worn spots and highlights stay coherent.

Outputs (all committed, reviewable without running anything):
  layers/*.svg     individual layers + the composite, as standalone SVG sources
  examples/*.png   each layer in isolation, the tiling proof, and FULL-COMPOSITION
                   examples (one per word in the config), plus a contact sheet
  review.html      contact sheet referencing the example PNGs

Determinism: feTurbulence with a fixed seed is deterministic per renderer, so the
renderer is pinned to one headless Chromium. Override with $CHROME if needed.

Usage:
  python tools/wear/build_wear.py
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAYERS = HERE / "layers"
EXAMPLES = HERE / "examples"
BUILD = HERE / ".build"  # transient HTML wrappers for rendering


# --------------------------------------------------------------------------- chrome
def find_chrome() -> str:
    if os.environ.get("CHROME"):
        return os.environ["CHROME"]
    cands = sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"), reverse=True)
    cands += sorted(glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell"), reverse=True)
    for name in ("google-chrome", "chromium", "chromium-browser", "chrome"):
        p = shutil.which(name)
        if p:
            cands.append(p)
    for c in cands:
        if c and Path(c).exists():
            return c
    sys.exit("no Chromium found; set $CHROME to a chrome/chromium binary")


CHROME = find_chrome()


def render(svg: str, png: Path, w: int, h: int) -> None:
    """Render an SVG string to a PNG of exactly w x h via headless Chromium."""
    BUILD.mkdir(exist_ok=True)
    html = BUILD / (png.stem + ".html")
    html.write_text(
        "<!doctype html><meta charset=utf-8>"
        "<style>html,body{margin:0;padding:0;background:#222}svg{display:block}</style>" + svg
    )
    subprocess.run(
        [CHROME, "--headless=new", "--no-sandbox", "--hide-scrollbars",
         "--force-device-scale-factor=1", f"--window-size={w},{h}",
         f"--screenshot={png}", html.as_uri()],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


# ----------------------------------------------------------------------------- defs
def defs(cfg: dict) -> str:
    """Every filter/pattern/gradient. Included in each standalone SVG so the layer
    files open on their own and stay individually reviewable."""
    f, oct_, seed = cfg["dimple_freq"], cfg["dimple_octaves"], cfg["seed"]
    turb = (f'<feTurbulence type="fractalNoise" baseFrequency="{f}" '
            f'numOctaves="{oct_}" seed="{seed}" stitchTiles="stitch" result="n"/>')
    return f"""
  <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="{cfg['panel_top']}"/>
    <stop offset="1" stop-color="{cfg['panel_bottom']}"/>
  </linearGradient>

  <!-- LAYER: dimples (grayscale pebble relief), tileable -->
  <filter id="dimples" x="0" y="0" width="100%" height="100%" color-interpolation-filters="linearRGB">
    {turb}
    <feColorMatrix in="n" type="matrix"
      values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1"/>
  </filter>
  <pattern id="dimplesTile" width="{cfg['tile']}" height="{cfg['tile']}" patternUnits="userSpaceOnUse">
    <rect width="{cfg['tile']}" height="{cfg['tile']}" filter="url(#dimples)"/>
  </pattern>

  <!-- LAYER: erosion (worn-through ink speckle), tileable -->
  <filter id="erosion" x="0" y="0" width="100%" height="100%" color-interpolation-filters="linearRGB">
    {turb}
    <feColorMatrix in="n" type="luminanceToAlpha" result="L"/>
    <feComponentTransfer in="L" result="m"><feFuncA type="discrete" tableValues="0 0 0 1 1"/></feComponentTransfer>
    <feFlood flood-color="{cfg['ink']}" result="ink"/>
    <feComposite in="ink" in2="m" operator="in"/>
  </filter>

  <!-- LAYER: highlights (dimple specular from the SAME noise), tileable -->
  <filter id="highlights" x="0" y="0" width="100%" height="100%" color-interpolation-filters="linearRGB">
    {turb}
    <feSpecularLighting in="n" surfaceScale="2.5" specularConstant="1.0"
        specularExponent="16" lighting-color="#ffffff" result="s">
      <feDistantLight azimuth="{cfg['light_azimuth']}" elevation="{cfg['light_elevation']}"/>
    </feSpecularLighting>
  </filter>

  <!-- LAYER: wear (full stack applied to glyphs) -->
  <filter id="wear" x="-15%" y="-15%" width="130%" height="130%" color-interpolation-filters="linearRGB">
    {turb}
    <feDisplacementMap in="SourceGraphic" in2="n" scale="{cfg['displace_scale']}"
        xChannelSelector="R" yChannelSelector="G" result="disp"/>
    <feColorMatrix in="n" type="luminanceToAlpha" result="L"/>
    <feComponentTransfer in="L" result="wmask"><feFuncA type="table" tableValues="{cfg['wear_table']}"/></feComponentTransfer>
    <feComposite in="disp" in2="wmask" operator="in" result="worn"/>
    <feGaussianBlur in="worn" stdDeviation="{cfg['edge_blur']}"/>
  </filter>"""


def svg(body: str, w: int, h: int, cfg: dict) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
            f'viewBox="0 0 {w} {h}"><defs>{defs(cfg)}</defs>{body}</svg>')


def swatch(filter_id: str, bg: str, cfg: dict, size: int = 256) -> str:
    return svg(f'<rect width="{size}" height="{size}" fill="{bg}"/>'
               f'<rect width="{size}" height="{size}" filter="url(#{filter_id})"/>', size, size, cfg)


def composite(word: str, cfg: dict, w: int = 360, h: int = 300) -> str:
    fs = cfg["font_size"]
    text = (f'<text x="{w//2}" y="{h//2 + fs//3}" text-anchor="middle" '
            f'textLength="{w-48}" lengthAdjust="spacingAndGlyphs" '
            f'font-family="DejaVu Sans, Verdana, sans-serif" font-size="{fs}" '
            f'font-weight="900" font-style="italic" fill="{cfg["ink"]}"')
    body = (
        f'<rect width="{w}" height="{h}" fill="url(#panel)"/>'
        f'{text} filter="url(#wear)">{word}</text>'
        f'<rect width="{w}" height="{h}" filter="url(#highlights)" '
        f'style="mix-blend-mode:screen;opacity:{cfg["highlight_opacity"]}"/>'
    )
    return svg(body, w, h, cfg)


def flat(word: str, cfg: dict, w: int = 360, h: int = 300) -> str:
    fs = cfg["font_size"]
    body = (f'<rect width="{w}" height="{h}" fill="url(#panel)"/>'
            f'<text x="{w//2}" y="{h//2 + fs//3}" text-anchor="middle" '
            f'textLength="{w-48}" lengthAdjust="spacingAndGlyphs" '
            f'font-family="DejaVu Sans, Verdana, sans-serif" font-size="{fs}" '
            f'font-weight="900" font-style="italic" fill="{cfg["ink"]}">{word}</text>')
    return svg(body, w, h, cfg)


def tiling_proof(cfg: dict, w: int = 768, h: int = 200) -> str:
    t = cfg["tile"]
    guides = "".join(
        f'<line x1="{x}" y1="0" x2="{x}" y2="{h}" stroke="red" stroke-width="1" stroke-opacity="0.5"/>'
        for x in range(t, w, t)
    )
    return svg(f'<rect width="{w}" height="{h}" fill="url(#dimplesTile)"/>{guides}', w, h, cfg)


# --------------------------------------------------------------------------- build
def main() -> None:
    cfg = json.loads((HERE / "wear.config.json").read_text())
    # validate stitch constraint: dimple_freq * tile should be ~integer
    cyc = cfg["dimple_freq"] * cfg["tile"]
    if abs(cyc - round(cyc)) > 1e-6:
        print(f"warning: dimple_freq*tile={cyc:.4f} not integer; tiling seam may show")
    LAYERS.mkdir(exist_ok=True)
    EXAMPLES.mkdir(exist_ok=True)

    # ---- write standalone layer SVG sources (reviewable in isolation) ----
    sources = {
        "dimples.svg": swatch("dimples", cfg["panel_top"], cfg),
        "erosion.svg": swatch("erosion", cfg["panel_top"], cfg),
        "highlights.svg": swatch("highlights", cfg["panel_bottom"], cfg),
        "tiling_proof.svg": tiling_proof(cfg),
        "composite.svg": composite(cfg["words"][0], cfg),
    }
    for name, src in sources.items():
        (LAYERS / name).write_text(src)

    # ---- render isolated layers + tiling proof ----
    print("rendering isolated layers ...")
    render(sources["dimples.svg"], EXAMPLES / "dimples.png", 256, 256)
    render(sources["erosion.svg"], EXAMPLES / "erosion.png", 256, 256)
    render(sources["highlights.svg"], EXAMPLES / "highlights.png", 256, 256)
    render(sources["tiling_proof.svg"], EXAMPLES / "tiling_proof.png", 768, 200)

    # ---- render FULL-COMPOSITION examples (one per word) + a flat baseline ----
    print("rendering full-composition examples ...")
    render(flat(cfg["words"][0], cfg), EXAMPLES / "flat_baseline.png", 360, 300)
    comp_pngs = []
    for word in cfg["words"]:
        out = EXAMPLES / f"composite_{word}.png"
        render(composite(word, cfg), out, 360, 300)
        comp_pngs.append(out.name)

    # ---- contact sheet (references the rendered PNGs) ----
    write_contact_sheet(cfg, comp_pngs)
    write_review_html(cfg, comp_pngs)

    if BUILD.exists():
        shutil.rmtree(BUILD)
    print(f"done -> {EXAMPLES}")


def write_contact_sheet(cfg: dict, comp_pngs: list[str]) -> None:
    """A single SVG that <image>s every example into a labelled grid -> contact_sheet.png."""
    pad, lab = 12, 18
    cells = [
        ("dimples (isolated)", "dimples.png", 256, 256),
        ("erosion (isolated)", "erosion.png", 256, 256),
        ("highlights (isolated)", "highlights.png", 256, 256),
        ("flat baseline (no wear)", "flat_baseline.png", 360, 300),
    ]
    cells += [(f"FULL COMPOSITION: {n[10:-4]}", n, 360, 300) for n in comp_pngs]
    cells.append(("TILING PROOF (red = tile seams)", "tiling_proof.png", 768, 200))

    cols, x, y, rowh, W = 0, pad, pad, 0, 1140
    parts, cur_x = [], pad
    for title, href, w, h in cells:
        if cur_x + w + pad > W:
            cur_x = pad
            y += rowh + lab + pad
            rowh = 0
        parts.append(
            f'<text x="{cur_x}" y="{y+13}" font-family="sans-serif" font-size="12" fill="#9cf">{title}</text>'
            f'<image x="{cur_x}" y="{y+lab}" width="{w}" height="{h}" href="examples/{href}"/>'
        )
        cur_x += w + pad
        rowh = max(rowh, h)
    H = y + rowh + lab + pad
    sheet = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
             f'width="{W}" height="{H}"><rect width="{W}" height="{H}" fill="#222"/>{"".join(parts)}</svg>')
    (HERE / "contact_sheet.svg").write_text(sheet)
    # render it from a wrapper inside HERE so "examples/*.png" hrefs resolve
    html = HERE / ".contact_tmp.html"
    html.write_text("<!doctype html><meta charset=utf-8>"
                    "<style>html,body{margin:0;background:#222}svg{display:block}</style>" + sheet)
    subprocess.run(
        [CHROME, "--headless=new", "--no-sandbox", "--hide-scrollbars",
         "--force-device-scale-factor=1", f"--window-size={W},{H}",
         f"--screenshot={EXAMPLES/'contact_sheet.png'}", html.as_uri()],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    html.unlink()


def write_review_html(cfg: dict, comp_pngs: list[str]) -> None:
    comp_imgs = "".join(
        f'<figure><figcaption>full composition: {n[10:-4]}</figcaption>'
        f'<img src="examples/{n}"></figure>' for n in comp_pngs)
    (HERE / "review.html").write_text(f"""<!doctype html><html><head><meta charset="utf-8">
<title>ball-wear layers</title><style>
 body{{margin:0;background:#222;color:#ddd;font:14px/1.4 sans-serif;padding:16px}}
 h2{{color:#9cf}} .row{{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}}
 figure{{margin:0;background:#111;border:1px solid #333;padding:6px}}
 figcaption{{color:#9cf;font-size:12px;margin-bottom:4px}} img{{display:block}}
</style></head><body>
<h2>Isolated layers</h2><div class="row">
 <figure><figcaption>dimples</figcaption><img src="examples/dimples.png"></figure>
 <figure><figcaption>erosion</figcaption><img src="examples/erosion.png"></figure>
 <figure><figcaption>highlights</figcaption><img src="examples/highlights.png"></figure>
</div>
<h2>Full composition examples</h2><div class="row">
 <figure><figcaption>flat baseline (no wear)</figcaption><img src="examples/flat_baseline.png"></figure>
 {comp_imgs}
</div>
<h2>Tiling proof <small>(red lines = tile boundaries; texture should flow through)</small></h2>
<div class="row"><figure><img src="examples/tiling_proof.png"></figure></div>
</body></html>""")


if __name__ == "__main__":
    main()
