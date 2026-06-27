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

## What the mask covers

The wordmark appears in four places (the panel wraps across the left/right image
seam in the equirectangular projection):

| Region    | Original coords (x0,y0,x1,y1) | Content                       |
| --------- | ----------------------------- | ----------------------------- |
| `center`  | 962, 318, 1100, 690           | main cursive wordmark + ®      |
| `left`    | 0, 330, 112, 692              | wordmark wrapping off left seam|
| `right`   | 1995, 318, 2048, 605          | wordmark wrapping off right seam|
| `patents` | 500, 876, 690, 936            | "WILSON.COM/PATENTS" fine print|

Within each region the script thresholds the dark ink (luminance `< 110`) on the
bright-yellow ball, then dilates slightly. This follows the actual glyphs rather
than a crude box, and deliberately **excludes** "AVP GAME BALL", the "avp"
runner logo, and "FIVB".

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
