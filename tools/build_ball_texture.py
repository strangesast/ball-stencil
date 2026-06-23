# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26", "pillow>=10.0"]
# ///
"""
Bake an equirectangular albedo texture for the OPTX ball from registered product
photos.

Input : ball_texture.config.json (from photo_register.html) + the photos it names.
Output: an equirectangular PNG (and a gap-filled variant + a coverage map).

Method — for each output texel (lon,lat):
  1. body point p = [sin v cos u, sin v sin u, cos v]   (v=polar from +Z, matches
     the viewer's uvSphere; texture top row = +Z TOP, bottom row = -Z VALVE).
  2. for each photo: rotate p by its quaternion q (body->camera). If it faces the
     camera (z>0) sample the photo orthographically at (cx+r*x, cy-r*y).
  3. blend the views with feathered weights that fall to zero at each view's
     silhouette (z->0), so overlapping views cross-fade instead of hard-cutting.

De-lighting divides each photo by its own low-frequency luminance so the result is
roughly flat albedo (the viewer relights it). Run:  uv run tools/build_ball_texture.py
"""
import argparse
import json
import math
import pathlib
import numpy as np
from PIL import Image, ImageFilter

# face index = fix*2 + (sign>0):  0=-X BACK, 1=+X FRONT, 2=-Y SIDE2, 3=+Y SIDE1,
# 4=-Z VALVE, 5=+Z TOP. NORMALS/_E index the 3 cube axes.
_E = [[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]]
FACE_NAME = ["BACK", "FRONT", "SIDE2", "SIDE1", "VALVE", "TOP"]
FACE_NORMAL = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]


def qrot(q, V):
    """Rotate a field of vectors V (...,3) by unit quaternion q=[x,y,z,w]."""
    qv = np.asarray(q[:3], float)
    qw = float(q[3])
    cross1 = np.stack([
        qv[1] * V[..., 2] - qv[2] * V[..., 1],
        qv[2] * V[..., 0] - qv[0] * V[..., 2],
        qv[0] * V[..., 1] - qv[1] * V[..., 0],
    ], axis=-1)
    t = 2.0 * cross1
    cross2 = np.stack([
        qv[1] * t[..., 2] - qv[2] * t[..., 1],
        qv[2] * t[..., 0] - qv[0] * t[..., 2],
        qv[0] * t[..., 1] - qv[1] * t[..., 0],
    ], axis=-1)
    return V + qw * t + cross2


# scalar quaternion / vector helpers for the symmetry transforms
def qmul(a, b):
    return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
            a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
            a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
            a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]


def qaxis(ax, deg):
    h = math.radians(deg) / 2
    s = math.sin(h)
    return [ax[0] * s, ax[1] * s, ax[2] * s, math.cos(h)]


def _vc(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _vd(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _vn(a):
    l = math.hypot(*a) or 1.0
    return [a[0] / l, a[1] / l, a[2] / l]


def qfromto(a, b):
    """Shortest-arc quaternion rotating unit vector a onto unit vector b."""
    a, b = _vn(a), _vn(b)
    d = _vd(a, b)
    if d > 0.99999:
        return [0, 0, 0, 1]
    if d < -0.99999:
        ax = _vc([1, 0, 0], a)
        if _vd(ax, ax) < 1e-6:
            ax = _vc([0, 1, 0], a)
        return qaxis(_vn(ax), 180)
    ax = _vc(a, b)
    q = [ax[0], ax[1], ax[2], 1 + d]
    l = math.hypot(*q)
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]


def face_frame(fi, weave):
    """Return (normal, cut-axis, run-axis) unit vectors for a face index."""
    fix, s = fi // 2, (1 if fi % 2 else -1)
    cyc = (fix + 2) % 3
    cut = (3 - fix - cyc) if weave else cyc
    n = [s * _E[fix][0], s * _E[fix][1], s * _E[fix][2]]
    return n, _E[cut], _E[3 - fix - cut]


def home_face(q):
    """Which face this photo's quaternion brings most toward the camera (+Z)."""
    zs = [qrot(q, np.array(FACE_NORMAL[f], float))[2] for f in range(6)]
    return int(np.argmax(zs))


def face_transform(tf, hf, weave):
    """Cube rotation mapping target face tf onto source home face hf, with the
    in-plane twist that best lines the strips up (so the duplicated panel reads
    as a proper panel of the target face)."""
    nT, cutT, _ = face_frame(tf, weave)
    nH, cutH, _ = face_frame(hf, weave)
    base = qfromto(nT, nH)
    best, score = base, -9.0
    for k in range(4):
        Rk = qmul(qaxis(nH, 90 * k), base)
        al = abs(_vd(list(qrot(Rk, np.array(cutT, float))), cutH))
        if al > score:
            score, best = al, Rk
    return best


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def delight(img, cx, cy, r):
    """Divide an RGB float photo by its low-frequency luminance (flat albedo)."""
    h, w, _ = img.shape
    ys, xs = np.mgrid[0:h, 0:w]
    ball = ((xs - cx) ** 2 + (ys - cy) ** 2) <= (r * 0.97) ** 2
    lum = img @ np.array([0.299, 0.587, 0.114])
    mean = float(lum[ball].mean()) if ball.any() else float(lum.mean())
    # neutralise the background so the blur doesn't drag the rim toward white/black
    L = np.where(ball, lum, mean).astype(np.float32)
    sigma = max(4.0, r * 0.22)
    Lb = np.asarray(Image.fromarray(np.clip(L, 0, 255).astype(np.uint8))
                    .filter(ImageFilter.GaussianBlur(sigma)), dtype=np.float32)
    ratio = np.clip(Lb / max(mean, 1e-3), 0.45, 2.3)
    return np.clip(img / ratio[..., None], 0, 255)


def bilinear(img, sx, sy):
    """Bilinear sample img (h,w,3) at float coords; returns (color, valid mask)."""
    h, w, _ = img.shape
    valid = (sx >= 0) & (sx <= w - 1) & (sy >= 0) & (sy <= h - 1)
    x0 = np.clip(np.floor(sx).astype(int), 0, w - 1)
    y0 = np.clip(np.floor(sy).astype(int), 0, h - 1)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = np.clip(sx - x0, 0, 1)[..., None]
    fy = np.clip(sy - y0, 0, 1)[..., None]
    c = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy)
         + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)
    return c, valid


def pushpull_fill(color, weight):
    """Fill zero-weight texels from coarser levels (simple push-pull inpaint)."""
    cs, ws = [color * weight[..., None]], [weight.astype(np.float32).copy()]
    while ws[-1].shape[0] > 1 and ws[-1].shape[1] > 1:
        c, w = cs[-1], ws[-1]
        h, wd = w.shape
        h2, w2 = h // 2, wd // 2
        c = c[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2, 3).sum((1, 3))
        w = w[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2).sum((1, 3))
        cs.append(c)
        ws.append(w)
    up = None
    for c, w in zip(reversed(cs), reversed(ws)):
        norm = np.where(w[..., None] > 0, c / np.maximum(w[..., None], 1e-8), 0.0)
        conf = np.clip(w, 0, 1)[..., None]
        if up is None:
            up = norm
        else:
            u = up.repeat(2, 0).repeat(2, 1)[:norm.shape[0], :norm.shape[1]]
            up = norm * conf + u * (1 - conf)
    return np.clip(up, 0, 255)


# --- multi-band (Laplacian pyramid) blending ------------------------------
def _blur(a):
    """5-tap binomial blur; reflect in v (rows), wrap in u (cols, longitude)."""
    def b(x, axis, mode):
        pad = [(0, 0)] * x.ndim
        pad[axis] = (2, 2)
        xp = np.pad(x, pad, mode=mode)
        sl = lambda o: tuple(slice(o, o + x.shape[axis]) if i == axis else slice(None)
                             for i in range(x.ndim))
        return (xp[sl(0)] + 4 * xp[sl(1)] + 6 * xp[sl(2)] + 4 * xp[sl(3)] + xp[sl(4)]) / 16.0
    return b(b(a, 0, "reflect"), 1, "wrap")


def _down(a):
    return _blur(a)[::2, ::2]


def _up(a, shape):
    out = np.zeros((shape[0], shape[1]) + a.shape[2:], a.dtype)
    out[::2, ::2] = a
    return 4.0 * _blur(out)


def _max_levels(h, w, cap=7):
    n = 1
    while n < cap and h % 2 == 0 and w % 2 == 0:
        h //= 2
        w //= 2
        n += 1
    return n


def multiband_blend(cols, wgts):
    """Blend per-view colors using their weights, band by band (Burt-Adelson)."""
    H, W = wgts[0].shape
    L = _max_levels(H, W)
    # fill each view's uncovered region so its Laplacian has no garbage edges
    filled = [pushpull_fill(c.astype(np.float64), w) for c, w in zip(cols, wgts)]
    gpyr = [[f.astype(np.float64)] for f in filled]
    wpyr = [[w.astype(np.float64)] for w in wgts]
    for i in range(len(filled)):
        for _ in range(L - 1):
            gpyr[i].append(_down(gpyr[i][-1]))
            wpyr[i].append(_down(wpyr[i][-1]))
    out = []
    for l in range(L):
        num = np.zeros_like(gpyr[0][l])
        den = np.zeros((gpyr[0][l].shape[0], gpyr[0][l].shape[1]))
        for i in range(len(filled)):
            lap = gpyr[i][l] if l == L - 1 else gpyr[i][l] - _up(gpyr[i][l + 1], gpyr[i][l].shape)
            num += lap * wpyr[i][l][..., None]
            den += wpyr[i][l]
        out.append(num / np.maximum(den, 1e-6)[..., None])
    img = out[-1]
    for l in range(L - 2, -1, -1):
        img = _up(img, out[l].shape) + out[l]
    return img


def panel_id(P, strip, weave):
    """Label every texel with its watertight panel 0..17 (= face*3 + strip).

    Face = the dominant cube axis (spherical-cube partition). The strip is the band
    along the face's cut axis (cyclic X->Z,Y->X,Z->Y; weave swaps to the other
    in-plane axis), split at the gnomonic cut coordinate +/- `strip`.
    """
    fix = np.argmax(np.abs(P), axis=2)
    cyc = (fix + 2) % 3
    cut = (3 - fix - cyc) if weave else cyc
    pf = np.take_along_axis(P, fix[..., None], 2)[..., 0]
    pc = np.take_along_axis(P, cut[..., None], 2)[..., 0]
    g = pc / np.maximum(np.abs(pf), 1e-9)
    sidx = np.where(g < -strip, 0, np.where(g > strip, 2, 1))
    face = fix * 2 + (pf > 0).astype(int)
    return (face * 3 + sidx).astype(np.int32)


def main():
    ap = argparse.ArgumentParser()
    here = pathlib.Path(__file__).parent
    ap.add_argument("--config", default=here / "ball_texture.config.json")
    ap.add_argument("--photos", default=here / "ball_photos")
    ap.add_argument("--out", default=here / "ball_optx.png")
    ap.add_argument("--web", default=here.parent / "web" / "public" / "ball_optx.jpg",
                    help="optimized JPEG written for the web app (set '' to skip)")
    ap.add_argument("--quality", type=int, default=86, help="web JPEG quality")
    ap.add_argument("--width", type=int, default=2048)
    ap.add_argument("--tau", type=float, default=0.45, help="feather: weight->1 by this z")
    ap.add_argument("--no-delight", action="store_true")
    args = ap.parse_args()

    W = args.width
    H = W // 2
    cfg = json.loads(pathlib.Path(args.config).read_text())
    photos = cfg["photos"]

    # body points for every texel (v = polar from +Z, u = azimuth)
    u = (np.arange(W) + 0.5) / W * 2 * np.pi
    v = (np.arange(H) + 0.5) / H * np.pi
    uu, vv = np.meshgrid(u, v)
    P = np.stack([np.sin(vv) * np.cos(uu), np.sin(vv) * np.sin(uu), np.cos(vv)], axis=-1)

    weave = bool(cfg["model"]["weave"])
    # each cube face is sourced from a real photo's HOME face; missing faces reuse a
    # photo via a cube-symmetry rotation. Mapping (target face -> source home face):
    #   FRONT,BACK <- front;  SIDE1,SIDE2,TOP <- back;  VALVE <- valve.
    SRC = {1: 1, 0: 1, 3: 0, 2: 0, 5: 0, 4: 4}
    by_home = {home_face(p["q"]): (name, p) for name, p in photos.items()}
    print("photo home faces:", {FACE_NAME[home_face(p["q"])]: n for n, p in photos.items()})

    loaded = {}
    view_cols, view_good, view_spec, view_face = [], [], [], []
    for tf in range(6):
        hf = SRC.get(tf)
        if hf not in by_home:
            print(f"  {FACE_NAME[tf]}: no source (home {FACE_NAME[hf]} missing) — skipped")
            continue
        name, p = by_home[hf]
        R = [0, 0, 0, 1] if tf == hf else face_transform(tf, hf, weave)
        qeff = qmul(p["q"], R)
        tag = "real" if tf == hf else f"dup of {FACE_NAME[hf]}"
        print(f"  {FACE_NAME[tf]:6s} <- {name} ({tag})")

        if name not in loaded:
            img = np.asarray(Image.open(pathlib.Path(args.photos) / name).convert("RGB"), np.float32)
            if not args.no_delight:
                img = delight(img, p["cx"], p["cy"], p["radius"])
            loaded[name] = img
        img = loaded[name]
        C = qrot(qeff, P)
        z = C[..., 2]
        rs = p["radius"] * 0.985
        sx = p["cx"] + rs * C[..., 0]
        sy = p["cy"] - rs * C[..., 1]
        col, valid = bilinear(img, sx, sy)
        mx = col.max(-1)
        mn = col.min(-1)
        val = mx / 255.0
        sat = (mx - mn) / np.maximum(mx, 1e-3)
        spec = 1.0 - 0.8 * smoothstep(0.82, 1.0, val) * (1.0 - smoothstep(0.25, 0.5, sat))
        bg = (val > 0.88) & (sat < 0.18)
        view_cols.append(col)
        view_good.append(valid & (z > 0) & ~bg)
        view_spec.append(spec)
        view_face.append(tf)

    # each view owns its target face's 3 panels (seam-bounded)
    panel = panel_id(P, float(cfg["model"]["strip"]), weave)
    pface = panel // 3
    n = len(view_cols)
    owner = np.full(pface.shape, -1, np.int32)
    for i, tf in enumerate(view_face):
        owner[pface == tf] = i

    # panel-bounded weights — each view contributes only inside the panels it owns
    # (sharp, seam-bounded, no circular falloff). Multi-band then carries low-freq
    # colour across the grooves so the hard panel cuts read as seamless joins.
    weights = []
    for i in range(n):
        base = view_good[i].astype(np.float64) * view_spec[i]
        # owner dominates inside its panels; elsewhere a small weight lets a view
        # fill a neighbour's owned-but-uncovered gap with real pixels, not blur
        w = np.where(owner == i, base, 0.06 * base)
        w = _blur(_blur(w))                     # tiny anti-alias feather at the seam
        weights.append(w)

    wsum = np.sum(weights, axis=0)
    cover = wsum > 1e-6
    print(f"total coverage: {100 * cover.mean():.1f}% ({(~cover).sum()} empty texels)")
    print("multi-band blending…")
    blended = np.clip(multiband_blend(view_cols, weights), 0, 255).astype(np.float32)

    out = pathlib.Path(args.out)
    # 1) blended with alpha = coverage (gaps transparent)
    rgba = np.dstack([blended, np.where(cover, 255, 0).astype(np.float32)]).astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(out)
    # 2) opaque variant (multi-band already filled the gaps) — what the viewer wraps
    fp = out.with_name(out.stem + "_filled.png")
    Image.fromarray(blended.astype(np.uint8), "RGB").save(fp)
    # 3) coverage map (diagnostic)
    cov = (255 * np.clip(wsum / max(wsum.max(), 1e-6), 0, 1)).astype(np.uint8)
    cp = out.with_name(out.stem + "_coverage.png")
    Image.fromarray(cov, "L").save(cp)

    print(f"wrote {out.name} (alpha), {fp.name} (filled), {cp.name} (coverage) "
          f"@ {W}x{H}")

    # 4) optimized JPEG for the web app (no alpha needed for the opaque ball)
    if str(args.web):
        web = pathlib.Path(args.web)
        web.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(blended.astype(np.uint8), "RGB").save(
            web, quality=args.quality, optimize=True, progressive=True)
        print(f"wrote {web} ({web.stat().st_size // 1024} KB, q{args.quality})")


if __name__ == "__main__":
    main()
