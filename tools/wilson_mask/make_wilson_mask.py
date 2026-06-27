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

Tiling / the seam
-----------------
The texture is an equirectangular (cylindrical) unwrap of the ball, so it is
*horizontally periodic*: column 0 and column 2048 are the same meridian. The ball
carries the wordmark twice on opposite faces, which in the unwrap puts the second
logo exactly half a width (1024 px) from the center one -- straddling the x=0/2048
seam. A naive fixed left-box + right-box misses ragged halves of it and its
dilation can't cross the wrap.

We handle this by exploiting the periodicity directly: the same logo detector is
run once in the normal frame (center logo) and once on a frame rolled by W/2
(which makes the split seam-logo whole and centered), then the second mask is
rolled back and unioned. The final dilation pads horizontally with ``mode="wrap"``
so it is continuous across the seam.

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

# A single ROI (original 2048x1024 coords) that tightly bounds ONE cursive
# "Wilson" wordmark -- deliberately excluding "AVP GAME BALL" (ends ~x970), the
# "avp" runner, FIVB, and the panel seam stitch (x>1100). The SAME box bounds the
# center logo in the normal frame and the seam logo once the frame is rolled by
# W/2 (the two logos sit half a width apart), so it is reused for both.
LOGO_ROI = (976, 318, 1100, 692)
# "WILSON.COM/PATENTS" fine print -- a single (non-periodic) occurrence.
PATENTS_ROI = (500, 876, 690, 936)
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


def _ink_in_rois(arr: np.ndarray, rois) -> np.ndarray:
    """Mark dark ink (< threshold) inside each ROI of an RGB array frame."""
    lum = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    h, w = lum.shape
    m = np.zeros((h, w), dtype=np.uint8)
    for name, l, t, r, b in rois:
        sel = lum[t:b, l:r] < INK_THRESHOLD
        m[t:b, l:r][sel] = 255
        print(f"  {name:14s}: {int(sel.sum()):6d} ink px in {r - l}x{b - t} ROI")
    return m


def _wrap_dilate(mask: np.ndarray, k: int) -> np.ndarray:
    """MaxFilter dilation that is continuous across the horizontal seam."""
    padded = np.pad(mask, ((k, k), (k, k)), mode="wrap")
    grown = np.asarray(Image.fromarray(padded, "L").filter(ImageFilter.MaxFilter(k)))
    return grown[k:-k, k:-k]


def build_mask(im: Image.Image) -> Image.Image:
    arr = np.asarray(im).astype(np.int32)
    w = arr.shape[1]
    roll = w // 2  # half a width: brings the seam-straddling 2nd logo to center

    # center logo (+ patents) in the normal frame
    mask = _ink_in_rois(arr, [("center logo", *LOGO_ROI), ("patents", *PATENTS_ROI)])
    # seam logo: detect in a rolled frame where it is whole, then roll mask back
    seam = _ink_in_rois(np.roll(arr, roll, axis=1), [("seam logo", *LOGO_ROI)])
    mask = np.maximum(mask, np.roll(seam, -roll, axis=1))

    return Image.fromarray(_wrap_dilate(mask, DILATE), "L")


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
