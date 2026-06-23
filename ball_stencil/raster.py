"""Raster (PNG/JPG/…) → filled-silhouette SVG. Python reference for the web port
(web/src/pipeline/trace.ts — same function name shape, options, and defaults).

This is an *input adapter only*: it turns a raster image into a filled, even-odd
``<path>`` SVG that flows through the existing, unchanged pipeline
(``svgio.load_artwork``). It is NOT a colour converter — both backends emit a
monochrome silhouette; the single sampled fill exists only to feed the
projection paint, exactly like the typed-letter generator.

Output contract (see ``svgio.load_artwork`` / ``_subpath_to_polygon``):

    <svg xmlns viewBox="0 0 W H"><path d="…" fill="#rrggbb"/></svg>

  - flat, absolute-coordinate ``<path>`` only (no ``<g>``/transform/``<image>``);
  - closed subpaths; holes/counters survive as separate, opposite-wound subpaths;
  - even-odd XOR runs across *every* subpath in the document, so we emit a SINGLE
    foreground silhouette — never a multi-colour trace, whose overlapping colour
    regions would cancel under the fold (the §2.2 "silhouette, not illustration"
    rule). The colour backend is therefore fed a pre-binarized 2-colour mask.

Backends (parity with the web port — same literal strings, same defaults):

  ``"potrace"`` (default, cleanest edge): pure-Python ``potracer``. We chose
      ``potracer`` over the native ``pypotrace`` because pypotrace fails to build
      here (it needs libpotrace + libagg + pkg-config and the right flags);
      ``potracer`` is the same Potrace algorithm with no native build, and is the
      documented fallback. Same engine as the web's esm-potrace-wasm.

  ``"color"`` (tolerant of photos): ``vtracer`` — role-parallel to the web's
      ImageTracer.js (different engine, same role + output contract; not
      byte-identical to the web, by design). vtracer is fed the same binarized
      mask so it yields a silhouette.
      NOTE: the published vtracer wheels (≤0.6.15) segfault under CPython ≥3.14
      via a pyo3 fastcall ABI bug. A segfault can't be caught, so we gate vtracer
      by version and, when it can't run, trace the same binarized mask with
      ``potracer`` instead — a contract-identical silhouette (only the curve
      fitter differs). Set ``BALL_STENCIL_FORCE_VTRACER=1`` to force vtracer.

``detail`` despeckles (potrace ``turdsize`` / vtracer ``filter_speckle``); higher
drops more tiny islands. The default already despeckles so the constrained
poly2tri mesher and chord-flattening are not choked by trace noise. The final
cut-edge fidelity is still governed downstream by ``boundary_smoothness_mm`` /
``chord_error_mm`` — a too-fine trace only wastes triangles, it does not sharpen
the drawn edge.
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass

import numpy as np
from PIL import Image

# Mirror web/src/color.ts DEFAULT_PAINT_HEX so a colourless trace paints the same
# fallback ink on both implementations.
DEFAULT_PAINT_HEX = "#d92a2e"


@dataclass
class TraceOptions:
    """Identical fields/defaults to the JS ``opts`` (web/src/pipeline/trace.ts)."""

    backend: str = "potrace"     # "potrace" | "color"
    threshold: int = 128         # 0–255 bilevel cutoff / luminance split
    invert: bool = False         # trace light-on-dark instead of dark-on-light
    detail: int = 2              # despeckle: potrace turdsize / vtracer filter_speckle
    fill: str | None = None      # force fill #rrggbb; None → sample dominant fg colour


@dataclass
class TraceResult:
    svg_text: str
    name: str                    # filename-safe, like glyph's glyphName


def raster_to_svg(path_or_bytes, opts: TraceOptions | None = None) -> TraceResult:
    """Trace ``path_or_bytes`` (a file path or raw image bytes) to a silhouette SVG.

    The returned ``svg_text`` satisfies the ``load_artwork`` contract above; set
    ``cfg.svg_path`` to a file holding it and the pipeline runs unchanged.
    """
    opts = opts or TraceOptions()
    img, name = _open_rgba(path_or_bytes)
    rgba = np.asarray(img, dtype=np.uint8)            # H×W×4
    h, w = rgba.shape[:2]

    mask = _foreground_mask(rgba, opts.threshold, opts.invert)  # bool H×W, True == ink
    if not mask.any():
        raise ValueError(
            "No foreground found at this threshold — adjust --trace-threshold "
            "or pass --trace-invert for light-on-dark artwork."
        )

    fill = opts.fill or _dominant_fill(rgba, mask)
    subpaths = _trace_backend(opts.backend, mask, opts.detail)
    if not subpaths:
        raise ValueError("Tracer produced no filled paths.")

    # One flat <path> with every subpath (outer rings + holes), like glyph.ts: the
    # even-odd fold across subpaths carves counters/holes out for free.
    d = " ".join(subpaths)
    svg_text = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">'
        f'<path d="{d}" fill="{fill}"/></svg>'
    )
    return TraceResult(svg_text=svg_text, name=name)


# -- decode + mask -----------------------------------------------------------

def _open_rgba(path_or_bytes) -> tuple[Image.Image, str]:
    if isinstance(path_or_bytes, (bytes, bytearray)):
        import io
        return Image.open(io.BytesIO(path_or_bytes)).convert("RGBA"), "image"
    img = Image.open(path_or_bytes).convert("RGBA")
    name = _safe_name(os.path.splitext(os.path.basename(str(path_or_bytes)))[0])
    return img, name


def _safe_name(stem: str) -> str:
    s = re.sub(r"\s+", "_", stem.strip())
    s = re.sub(r"[^A-Za-z0-9_-]", "", s)
    return s or "image"


def _foreground_mask(rgba: np.ndarray, threshold: int, invert: bool) -> np.ndarray:
    """Reduce to a single foreground mask (True == ink), the §2 step 2 binarize.

    Dark-on-light by default: pixels darker than ``threshold`` are foreground.
    ``invert`` flips that (light-on-dark). Fully/near-transparent pixels are
    always background so a logo on transparency traces its opaque shape.
    """
    rgb = rgba[..., :3].astype(np.float64)
    # Rec. 601 luma, matching the web core.
    luma = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    fg = luma >= threshold if invert else luma < threshold
    fg &= rgba[..., 3] >= 128
    return fg


def _dominant_fill(rgba: np.ndarray, mask: np.ndarray) -> str:
    """Mean colour of the foreground pixels → ``#rrggbb`` for the projection paint."""
    fg = rgba[mask][:, :3]
    if fg.size == 0:
        return DEFAULT_PAINT_HEX
    r, g, b = (int(round(v)) for v in fg.mean(axis=0))
    return f"#{r:02x}{g:02x}{b:02x}"


# -- backend dispatch --------------------------------------------------------

def _trace_backend(backend: str, mask: np.ndarray, detail: int) -> list[str]:
    if backend == "potrace":
        return _trace_potrace(mask, detail)
    if backend == "color":
        if _vtracer_usable():
            return _trace_vtracer(mask, detail)
        # vtracer can't run here (see module docstring): trace the same binarized
        # mask with potracer — a contract-identical silhouette.
        return _trace_potrace(mask, detail)
    raise ValueError(f"unknown trace backend {backend!r} (expected 'potrace' or 'color')")


def _vtracer_usable() -> bool:
    if os.environ.get("BALL_STENCIL_FORCE_VTRACER") == "1":
        return True
    try:
        import vtracer  # noqa: F401
    except Exception:
        return False
    # ≤0.6.15 wheels segfault under CPython ≥3.14 (pyo3 fastcall ABI). A segfault
    # is not catchable, so gate by version rather than try/except the call.
    return sys.version_info[:2] < (3, 14)


# -- potrace backend (pure-Python potracer) ----------------------------------

def _trace_potrace(mask: np.ndarray, turdsize: int) -> list[str]:
    import potrace

    # potracer reads a 0–255 image and traces DARK pixels (internally it does
    # ``data > 127.5`` then inverts), so the foreground must be black (0) on a
    # white (255) field — confirmed against the installed potracer 0.0.4.
    ink = np.where(mask, 0, 255).astype(np.uint8)
    path = potrace.Bitmap(ink).trace(turdsize=max(0, int(turdsize)))
    # Flat iteration yields outer rings AND hole rings as sibling curves, so each
    # becomes a separate subpath and the even-odd fold preserves holes.
    return [_curve_to_d(c) for c in path]


def _curve_to_d(curve) -> str:
    """One potrace curve → a closed absolute ``d`` subpath (cubics + corner lines)."""
    parts = [f"M{_n(curve.start_point.x)} {_n(curve.start_point.y)}"]
    for seg in curve.segments:
        if seg.is_corner:
            # A corner is two straight segments through the corner point.
            parts.append(f"L{_n(seg.c.x)} {_n(seg.c.y)}")
            parts.append(f"L{_n(seg.end_point.x)} {_n(seg.end_point.y)}")
        else:
            parts.append(
                f"C{_n(seg.c1.x)} {_n(seg.c1.y)} "
                f"{_n(seg.c2.x)} {_n(seg.c2.y)} "
                f"{_n(seg.end_point.x)} {_n(seg.end_point.y)}"
            )
    parts.append("Z")
    return " ".join(parts)


def _n(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


# -- color backend (vtracer; exercised only where the wheel runs) -------------

def _trace_vtracer(mask: np.ndarray, filter_speckle: int) -> list[str]:
    import vtracer

    h, w = mask.shape
    # §2.2: hand vtracer a pre-binarized 2-colour mask (ink black, field white) so
    # it returns a single silhouette, not a multi-colour illustration.
    ink = np.where(mask[..., None], 0, 255).astype(np.uint8)
    rgba = np.dstack([ink[..., 0], ink[..., 0], ink[..., 0], np.full((h, w), 255, np.uint8)])
    pixels = [tuple(int(v) for v in px) for px in rgba.reshape(-1, 4)]
    svg = vtracer.convert_pixels_to_svg(
        pixels,
        (w, h),
        colormode="binary",          # single layer; cheap and silhouette-clean
        mode="spline",
        filter_speckle=max(0, int(filter_speckle)),
    )
    return _extract_fg_subpaths(svg)


_WHITE = {"#fff", "#ffffff", "white", "#ffffffff"}


def _extract_fg_subpaths(svg_text: str) -> list[str]:
    """Pull the foreground ``<path d>``(s) out of a tracer's SVG, dropping any
    white/background layer, so we can re-wrap them in our canonical <svg>."""
    out: list[str] = []
    for m in re.finditer(r"<path\b([^>]*)\bd=\"([^\"]+)\"", svg_text):
        attrs, d = m.group(1), m.group(2)
        fm = re.search(r'fill="([^"]+)"', attrs)
        if fm and fm.group(1).strip().lower() in _WHITE:
            continue
        out.append(d.strip())
    return out
