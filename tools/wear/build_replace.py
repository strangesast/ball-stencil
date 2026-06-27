#!/usr/bin/env python3
"""Replace the removed "Wilson" wordmark with new text that inherits the ball's
texture and the old graphic's wear. Implements the 5-step pipeline:

  1. identify the mask                          (tools/wilson_mask/wilson_mask.png)
  2. replace the masked area with approximate   (diffusion inpaint -> clean dimpled
     non-ink ball background (yellow)            yellow, as if never printed)
  3. create the new text sized to the old        (match glyph height; for long
     wordmark                                     strings, match old total width)
  4. apply effects to the text: ball texture +   (dimple relief + erosion whose
     wear sampled from the old removed graphic,   amount is measured from the old
     keeping an ALPHA background around it        ink) -> RGBA, transparent around
  5. apply the modified text graphic to the ball (composite the RGBA over step 2)

The original (pre-Wumbo) texture is recovered from git history; the trademarked
photo is not stored. New-text glyphs are rendered with headless Chromium.

Usage:
  python tools/wear/build_replace.py [WORD]      # default WORD=Wumbo
"""
from __future__ import annotations

import glob
import io
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
OUT = HERE / "examples_replace"
MASK = REPO / "tools" / "wilson_mask" / "wilson_mask.png"
ORIGINAL_REF = "94e5d01^:web/public/ball_optx.jpg"
INK = np.array([59, 50, 28], np.float32)   # sampled worn-ink color
YELLOW = np.array([181, 150, 45], np.float32)  # sampled panel yellow


def chrome() -> str:
    if os.environ.get("CHROME"):
        return os.environ["CHROME"]
    for c in sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"), reverse=True):
        return c
    sys.exit("set $CHROME to a chromium binary")


def recover_original() -> Image.Image:
    data = subprocess.check_output(["git", "show", ORIGINAL_REF], cwd=REPO)
    return Image.open(io.BytesIO(data)).convert("RGB")


def bbox_of(mask: np.ndarray, xlo: int, xhi: int):
    """Tight bbox of mask pixels within an x-band (isolates the center logo)."""
    sub = mask[:, xlo:xhi]
    ys, xs = np.where(sub)
    return xlo + xs.min(), ys.min(), xlo + xs.max() + 1, ys.max() + 1


def _blur(a: np.ndarray, sigma: float) -> np.ndarray:
    return np.asarray(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(sigma))).astype(np.float32)


def inpaint(ball: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Multi-scale normalized (Gaussian) convolution fill. Interpolates the
    surrounding yellow + shading smoothly into the hole -- no axis-aligned streaks
    like 4-neighbour diffusion. Coarse-to-fine so the finest scale with support wins."""
    known = (~mask).astype(np.float32)
    fill = ball.copy()
    for sigma in (64, 32, 16, 8, 4):
        den = _blur(known * 255, sigma) / 255.0
        conf = den > 0.02
        for c in range(3):
            num = _blur(ball[..., c] * known, sigma)
            est = num / np.maximum(den * 255, 1e-3) * 255.0  # /den, undo the *255 in num's input scale
            ch = fill[..., c]
            take = mask & conf
            ch[take] = est[take]
            fill[..., c] = ch
    return fill


def render_glyph(word: str, w: int = 760, h: int = 300) -> np.ndarray:
    """Upright clean glyph coverage (alpha 0..1) via headless Chromium."""
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
           f'<text x="{w//2}" y="{int(h*0.73)}" text-anchor="middle" textLength="{w-40}" '
           f'lengthAdjust="spacingAndGlyphs" font-family="DejaVu Sans, Verdana, sans-serif" '
           f'font-size="{int(h*0.7)}" font-weight="900" font-style="italic" fill="#fff">{word}</text></svg>')
    d = OUT / ".g"
    d.mkdir(parents=True, exist_ok=True)
    (d / "g.html").write_text(
        "<!doctype html><meta charset=utf-8><style>html,body{margin:0}svg{display:block}</style>" + svg)
    png = d / "g.png"
    subprocess.run([chrome(), "--headless=new", "--no-sandbox", "--hide-scrollbars",
                    "--force-device-scale-factor=1", "--default-background-color=00000000",
                    f"--window-size={w},{h}", f"--screenshot={png}", (d / "g.html").as_uri()],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    a = np.asarray(Image.open(png).split()[-1]).astype(np.float32) / 255.0
    return a


def main() -> None:
    word = sys.argv[1] if len(sys.argv) > 1 else "Wumbo"
    OUT.mkdir(exist_ok=True)
    ball = np.asarray(recover_original()).astype(np.float32)
    mask = np.asarray(Image.open(MASK).convert("L")) > 0
    H, W, _ = ball.shape

    # ---- Step 1: the mask (center logo region) ----
    x0, y0, x1, y1 = bbox_of(mask, 880, 1220)
    Image.fromarray((mask[y0:y1, x0:x1] * 255).astype(np.uint8)).save(OUT / "step1_mask.png")

    # ---- Step 2: clean non-ink background (inpaint), dimples reinjected in the hole ----
    base = inpaint(ball, mask)
    luma = ball @ [.299, .587, .114]
    patch = luma[480:760, 1300:1580]
    relief_patch = patch - patch.mean()                       # real dimple relief, zero-mean
    relief = np.zeros((H, W), np.float32)
    ph, pw = relief_patch.shape
    for yy in range(y0, y1, ph):
        for xx in range(x0, x1, pw):
            s = relief_patch[:min(ph, y1 - yy), :min(pw, x1 - xx)]
            relief[yy:yy + s.shape[0], xx:xx + s.shape[1]] = s
    mfeather = np.asarray(Image.fromarray((mask * 255).astype(np.uint8))
                          .filter(ImageFilter.GaussianBlur(2))).astype(np.float32) / 255.0
    base += (relief * mfeather)[..., None]                    # restore dimples only in the hole
    base = np.clip(base, 0, 255)
    Image.fromarray(base.astype(np.uint8)[y0 - 20:y1 + 20, x0 - 20:x1 + 20]).save(OUT / "step2_background.png")

    # ---- Step 3: new text sized to the old wordmark (match height; long -> match width) ----
    bw, bh = x1 - x0, y1 - y0                                  # UV bbox (tall: wordmark is rotated)
    g = render_glyph(word)                                     # upright coverage
    gimg = Image.fromarray((g * 255).astype(np.uint8)).rotate(-90, expand=True)  # -> UV orientation
    gimg = gimg.resize((bw, bh))
    cov = np.zeros((H, W), np.float32)
    cov[y0:y1, x0:x1] = np.asarray(gimg).astype(np.float32) / 255.0
    cov = np.asarray(Image.fromarray((cov * 255).astype(np.uint8))
                     .filter(ImageFilter.GaussianBlur(0.6))).astype(np.float32) / 255.0
    Image.fromarray((cov[y0:y1, x0:x1] * 255).astype(np.uint8)).save(OUT / "step3_text.png")

    # ---- Step 4: wear from old graphic + ball texture, on an alpha background ----
    # how worn/opaque the OLD ink was (measured from old graphic vs clean base)
    with np.errstate(divide="ignore", invalid="ignore"):
        dens = -np.log(np.clip(ball / np.clip(base, 1, None), 1e-3, 1.0))
    dens = dens @ [.299, .587, .114]
    old = dens[mask]
    old_opacity = float(np.clip(np.median(old) / (np.percentile(old, 85) + 1e-6), 0.4, 1.0))
    # erosion: ink worn off dimple tops (high relief), strength scaled by how worn the old was
    rs = relief[y0:y1, x0:x1]
    rs = (rs - rs.min()) / (np.ptp(rs) + 1e-6)
    erosion = np.ones((H, W), np.float32)
    erosion[y0:y1, x0:x1] = 1.0 - (1.0 - old_opacity) * 1.6 * np.clip((rs - 0.55) / 0.45, 0, 1)
    ink_a = np.clip(cov * erosion, 0, 1)
    rgba = np.dstack([np.full((H, W), INK[0], np.uint8), np.full((H, W), INK[1], np.uint8),
                      np.full((H, W), INK[2], np.uint8), (ink_a * 255).astype(np.uint8)])
    Image.fromarray(rgba[y0 - 10:y1 + 10, x0 - 10:x1 + 10]).save(OUT / "step4_text_worn.png")

    # ---- Step 5: apply the text graphic to the ball ----
    ratio = np.clip(INK / YELLOW, 0.05, 1.0)                   # keep dimples showing through ink
    out = base.copy()
    for c in range(3):
        out[..., c] = base[..., c] * (1.0 - ink_a * (1.0 - ratio[c]))
    out = np.clip(out, 0, 255).astype(np.uint8)
    Image.fromarray(out).save(OUT / "step5_onball.png")
    Image.fromarray(out[y0 - 30:y1 + 30, x0 - 60:x1 + 90]).save(OUT / "step5_onball_crop.png")

    # small combined preview (jpeg, for review under size limits)
    contact(word, old_opacity)
    print(f"word={word} bbox=({x0},{y0},{x1},{y1}) old_opacity={old_opacity:.2f} -> {OUT}")


def contact(word: str, op: float) -> None:
    def load(name, hgt=300):
        im = Image.open(OUT / name).convert("RGB")
        return im.resize((int(im.width * hgt / im.height), hgt))
    tiles = [("1 mask", load("step1_mask.png")), ("2 background", load("step2_background.png")),
             ("3 text", load("step3_text.png")), ("4 worn (alpha)", load("step4_text_worn.png")),
             ("5 on ball (crop)", load("step5_onball_crop.png"))]
    pad = 8
    Wt = sum(t.width for _, t in tiles) + pad * (len(tiles) + 1)
    sheet = Image.new("RGB", (Wt, 300 + 24 + pad), (34, 34, 34))
    from PIL import ImageDraw
    d = ImageDraw.Draw(sheet)
    x = pad
    for label, t in tiles:
        sheet.paste(t, (x, 24))
        d.text((x, 6), label, fill=(150, 200, 255))
        x += t.width + pad
    d.text((pad, 300 + 8), f'word="{word}"  measured old-ink opacity={op:.2f}', fill=(200, 200, 200))
    sheet.save(OUT / "contact_replace.jpg", quality=82)


if __name__ == "__main__":
    main()
