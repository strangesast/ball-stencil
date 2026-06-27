# Wilson wordmark mask (for LaMa inpainting)

This tool locates the trademarked **"Wilson"** wordmark in the *original*
`ball_optx.jpg` texture and produces a binary mask that isolates only that
lettering, ready to feed to [**LaMa** — *Resolution-robust Large Mask Inpainting
with Fourier Convolutions*](https://advimman.github.io/lama-project/).

## Background

`web/public/ball_optx.jpg` is an equirectangular photo-texture of an AVP beach
volleyball. It originally carried the **Wilson** wordmark. Commit `94e5d01`
("replace the trademarked 'Wilson' ball wordmark with 'Wumbo'") swapped it out,
so the current texture says *Wumbo*. The original is still in git history at:

```
git show 94e5d01^:web/public/ball_optx.jpg > ball_optx_original.jpg
```

`make_wilson_mask.py` reads that original directly from history — the trademarked
photo is **not** re-committed to the repo.

## Tiling: the texture is horizontally periodic

`ball_optx.jpg` is an **equirectangular (cylindrical) unwrap** of the ball, so it
wraps horizontally — column `0` and column `2048` are the same meridian. The ball
carries the wordmark **twice**, on opposite faces ("the ball looks the same on two
sides"), which in the unwrap places the two logos exactly **half a width (1024 px)
apart**. One logo lands in the center; the other straddles the `x=0 / x=2048`
seam, so it shows up as a ragged half on the far left *and* a ragged half on the
far right.

A naive "left box + right box" handles that badly: each box clips part of the
glyphs, and a normal dilation can't grow across the wrap, so strokes near the seam
stay uncovered. The fix exploits the periodicity:

1. Detect the **center** logo in the normal frame.
2. `np.roll(img, 1024)` to bring the seam logo whole into the center, detect it
   with the **same** ROI, then `np.roll` the result back.
3. Union the two, and dilate with `np.pad(..., mode="wrap")` so growth is
   continuous across the seam.

Because the two logos are identical, the same `LOGO_ROI` bounds both — the script
confirms this (center and seam logos report near-identical ink-pixel counts).

### Other approaches to the same problem

- **Wrap-mode morphology only** — keep separate left/right boxes but pad with
  `mode="wrap"` before dilation. Fixes seam-crossing dilation but not clipped
  detection; weaker than rolling.
- **Periodic replication** — detect the center logo once and paste a copy shifted
  by `±1024 px (mod width)`. Cheapest, but assumes the period is exactly 1024 and
  the offset is pixel-perfect; rolling re-detects on real pixels and is robust to
  small offsets.
- **Tile horizontally (`np.tile` / 3×-wide canvas)**, mask the middle copy, crop
  back — equivalent to rolling, just more memory.
- **Operate on the sphere** — unproject to the ball surface, mask there, reproject.
  Most correct in principle but far more machinery than this 2-logo case needs.

## What the mask covers

| Region       | Frame              | Original coords (x0,y0,x1,y1) | Content                         |
| ------------ | ------------------ | ----------------------------- | ------------------------------- |
| center logo  | normal             | 976, 318, 1100, 692           | cursive wordmark + ®            |
| seam logo    | rolled by 1024     | 976, 318, 1100, 692           | the 2nd wordmark, split L/R     |
| patents      | normal             | 500, 876, 690, 936            | "WILSON.COM/PATENTS" fine print |

Within each region the script thresholds the dark ink (luminance `< 110`) on the
bright-yellow ball, then dilates slightly. This follows the actual glyphs rather
than a crude box, and deliberately **excludes** "AVP GAME BALL" (ends ~x970), the
"avp" runner logo, the panel seam stitch (x>1100), and "FIVB". The fine print is a
single (non-periodic) occurrence — the other face shows "FIVB™" there instead.

## Mask convention

LaMa expects an image + a single-channel mask where:

- **white (255)** = pixels to inpaint / remove
- **black (0)** = pixels to keep

`wilson_mask.png` follows this convention.

## Outputs

Running `python tools/wilson_mask/make_wilson_mask.py` writes:

- `wilson_mask.png` — the binary mask (this is the deliverable for LaMa)
- `wilson_overlay.jpg` — original with the masked Wilson pixels tinted red (so you
  can verify the mask "identifies" the right text and nothing else)
- `wilson_removed_demo.jpg` — a quick diffusion fill so the mask placement is
  visible without running LaMa (LaMa produces a sharper, texture-aware result)

## Removing it with LaMa

```bash
# 1. recover the original texture
git show 94e5d01^:web/public/ball_optx.jpg > ball_optx_original.jpg

# 2. regenerate the mask
python tools/wilson_mask/make_wilson_mask.py

# 3. run LaMa (https://github.com/advimman/lama)
#    place the pair so basenames match: image.png + image_mask.png
python bin/predict.py model.path=$(pwd)/big-lama \
    indir=$(pwd)/wilson_in outdir=$(pwd)/wilson_out
```

You can also drop the original + `wilson_mask.png` into the interactive
LaMa/cleanup demo and paint nothing extra — the mask already marks the wordmark.
