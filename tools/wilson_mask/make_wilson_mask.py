#!/usr/bin/env python3
"""Locate the "Wilson" wordmark in the original ball_optx.jpg and emit a mask.

Background
----------
The ball texture ``web/public/ball_optx.jpg`` originally carried the trademarked
"Wilson" AVP game-ball wordmark. Commit 94e5d01 replaced it with "Wumbo". This
script recovers the *original* texture from git history and uses brightness
thresholding inside hand-picked regions of interest to build a binary mask that
isolates only the "Wilson" lettering (the cursive wordmark in three places where
the equirectangular panel wraps, plus the small "WILSON.COM/PATENTS" fine print).

The resulting mask follows the LaMa convention (https://advimman.github.io/lama-project/):

    white (255) = pixels to inpaint / remove
    black (0)   = pixels to keep

Feed ``ball_optx_original.jpg`` + ``wilson_mask.png`` to LaMa to erase the
wordmark with a clean, texture-aware fill. A quick diffusion-based approximation
is also written here so the mask placement can be eyeballed without running LaMa.

Usage
-----
    python tools/wilson_mask/make_wilson_mask.py

Requires ``pillow`` and ``numpy`` (already project dependencies) and a git
checkout (the original texture is read from ``94e5d01^`` via ``git show``).
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
# The commit that scrubbed "Wilson" -> "Wumbo"; its parent holds the original.
ORIGINAL_REF = "94e5d01^:web/public/ball_optx.jpg"

# Regions of interest (original 2048x1024 coords) that contain ONLY the "Wilson"
# wordmark -- deliberately excluding "AVP GAME BALL", the "avp" runner, and FIVB.
ROIS = [
    ("center",   962, 318, 1100, 690),  # main cursive wordmark + (R)
    ("left",       0, 330,  112, 692),  # wrap of the wordmark off the left seam
    ("right",   1995, 318, 2048, 605),  # wrap of the wordmark off the right seam
    ("patents",  500, 876,  690, 936),  # "WILSON.COM/PATENTS" fine print
]
INK_THRESHOLD = 110  # luminance below this is dark ink on the bright yellow ball
DILATE = 7           # MaxFilter kernel; grows the mask for inpainting margin


def load_original() -> Image.Image:
    """Read the pre-Wumbo texture straight out of git history."""
    try:
        data = subprocess.check_output(
            ["git", "show", ORIGINAL_REF], cwd=REPO, stderr=subprocess.PIPE
        )
    except (OSError, subprocess.CalledProcessError) as exc:  # pragma: no cover
        sys.exit(f"could not recover original from git ({ORIGINAL_REF}): {exc}")
    from io import BytesIO

    return Image.open(BytesIO(data)).convert("RGB")


def build_mask(im: Image.Image) -> Image.Image:
    arr = np.asarray(im).astype(np.int32)
    lum = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    h, w = lum.shape
    mask = np.zeros((h, w), dtype=np.uint8)
    for name, l, t, r, b in ROIS:
        sel = lum[t:b, l:r] < INK_THRESHOLD
        mask[t:b, l:r][sel] = 255
        print(f"  {name:8s}: {int(sel.sum()):6d} ink px in {r - l}x{b - t} ROI")
    return Image.fromarray(mask, "L").filter(ImageFilter.MaxFilter(DILATE))


def overlay(im: Image.Image, mask: Image.Image) -> Image.Image:
    arr = np.asarray(im).astype(np.uint8).copy()
    md = np.asarray(mask) > 0
    arr[md] = (0.30 * arr[md] + np.array([255, 0, 0]) * 0.70).astype(np.uint8)
    return Image.fromarray(arr)


def diffusion_inpaint(im: Image.Image, mask: Image.Image, iters: int = 400) -> Image.Image:
    """Cheap Laplacian fill so mask placement is verifiable without LaMa."""
    arr = np.asarray(im).astype(np.float32)
    md = np.asarray(mask) > 0
    fill = arr.copy()
    for c in range(3):
        fill[..., c][md] = np.nan
    for _ in range(iters):
        for c in range(3):
            ch = fill[..., c]
            nan = np.isnan(ch)
            if not nan.any():
                continue
            stack = np.stack(
                [np.roll(ch, 1, 0), np.roll(ch, -1, 0), np.roll(ch, 1, 1), np.roll(ch, -1, 1)]
            )
            with np.errstate(invalid="ignore"):
                avg = np.nanmean(stack, axis=0)
            ch[nan] = avg[nan]
            fill[..., c] = ch
    return Image.fromarray(np.clip(np.nan_to_num(fill, nan=200.0), 0, 255).astype(np.uint8))


def main() -> None:
    print(f"recovering original texture from {ORIGINAL_REF}")
    im = load_original()
    print("building Wilson mask:")
    mask = build_mask(im)
    mask.save(HERE / "wilson_mask.png")
    overlay(im, mask).convert("RGB").save(HERE / "wilson_overlay.jpg", quality=86, optimize=True)
    print("running diffusion inpaint preview (LaMa gives a sharper result)")
    diffusion_inpaint(im, mask).save(
        HERE / "wilson_removed_demo.jpg", quality=86, optimize=True
    )
    print(f"wrote wilson_mask.png, wilson_overlay.jpg, wilson_removed_demo.jpg to {HERE}")


if __name__ == "__main__":
    main()
