"""Raster → silhouette SVG tracing (ball_stencil/raster.py).

Generates tiny PIL images, traces them with each backend, and asserts the output
satisfies the load_artwork contract: a viewBox sized to the source pixels and a
non-empty even-odd region. A shape-with-hole (annulus) must trace to a region
whose hole is *preserved* (even-odd), not filled — the silhouette-correctness
guarantee end to end. One image is run all the way through the pipeline to a
watertight/manifold PASS, mirroring the CLI raster path.

Runnable standalone (``python tests/test_raster_trace.py``) or via pytest; kept
dependency-light like the other test module.
"""
from __future__ import annotations

import os
import sys
import tempfile

import shapely
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ball_stencil.config import Config
from ball_stencil.pipeline import run
from ball_stencil.raster import TraceOptions, raster_to_svg
from ball_stencil.svgio import load_artwork

# Both backends are always available: "potrace" uses pure-Python potracer, and
# "color" uses vtracer where its wheel runs, falling back to potracer otherwise
# (see raster.py). So no backend needs gating here.
BACKENDS = ("potrace", "color")

W = H = 200


def _disc_png(path: str, fill=(40, 90, 200)) -> None:
    img = Image.new("RGB", (W, H), (255, 255, 255))
    ImageDraw.Draw(img).ellipse([30, 30, 170, 170], fill=fill)
    img.save(path)


def _ring_png(path: str) -> None:
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.ellipse([20, 20, 180, 180], fill=(0, 0, 0))        # outer disc
    d.ellipse([70, 70, 130, 130], fill=(255, 255, 255))  # punched hole
    img.save(path)


def _trace_to_region(make_png, backend: str):
    with tempfile.TemporaryDirectory() as td:
        png = os.path.join(td, "art.png")
        make_png(png)
        res = raster_to_svg(png, TraceOptions(backend=backend))
        svg = os.path.join(td, "traced.svg")
        with open(svg, "w") as f:
            f.write(res.svg_text)
        art = load_artwork(svg, 0.5)
        return res, art


def _n_holes(region) -> int:
    polys = region.geoms if hasattr(region, "geoms") else [region]
    return sum(len(p.interiors) for p in polys if not p.is_empty)


def test_disc_traces_to_nonempty_region_sized_to_source():
    for backend in BACKENDS:
        res, art = _trace_to_region(_disc_png, backend)
        assert res.name == "art"
        # viewBox spans the source pixel dimensions.
        assert art.viewbox == (0.0, 0.0, float(W), float(H)), backend
        assert art.center == (W / 2.0, H / 2.0), backend
        # A non-empty filled silhouette, comfortably the disc area.
        assert art.region.area > 0.5 * 3.14159 * 70 * 70, backend
        # A solid disc has no carved hole.
        assert _n_holes(art.region) == 0, backend


def test_ring_preserves_its_hole_under_even_odd():
    for backend in BACKENDS:
        _res, art = _trace_to_region(_ring_png, backend)
        # The punched hole survives as an interior ring (even-odd), not filled.
        assert _n_holes(art.region) >= 1, backend
        # And the region is the annulus, not the full outer disc.
        assert art.region.area < 3.14159 * 80 * 80, backend


def test_sampled_fill_is_the_foreground_colour():
    res, _art = _trace_to_region(_disc_png, "potrace")
    # Mean of the blue disc pixels (40,90,200) -> #285ac8.
    assert 'fill="#285ac8"' in res.svg_text


def test_explicit_fill_override():
    with tempfile.TemporaryDirectory() as td:
        png = os.path.join(td, "art.png")
        _disc_png(png)
        res = raster_to_svg(png, TraceOptions(fill="#123456"))
        assert 'fill="#123456"' in res.svg_text


def test_invert_traces_light_on_dark():
    with tempfile.TemporaryDirectory() as td:
        png = os.path.join(td, "art.png")
        # white disc on black: only --trace-invert finds the (light) foreground.
        img = Image.new("RGB", (W, H), (0, 0, 0))
        ImageDraw.Draw(img).ellipse([30, 30, 170, 170], fill=(255, 255, 255))
        img.save(png)
        res = raster_to_svg(png, TraceOptions(invert=True))
        svg = os.path.join(td, "t.svg")
        with open(svg, "w") as f:
            f.write(res.svg_text)
        assert load_artwork(svg, 0.5).region.area > 0


def test_empty_mask_raises():
    with tempfile.TemporaryDirectory() as td:
        png = os.path.join(td, "blank.png")
        Image.new("RGB", (W, H), (255, 255, 255)).save(png)  # all background
        try:
            raster_to_svg(png, TraceOptions())
        except ValueError as e:
            assert "foreground" in str(e).lower()
        else:
            raise AssertionError("expected ValueError on an all-background image")


def test_traced_raster_builds_a_pass_stencil():
    """End-to-end: a traced disc runs through the unchanged pipeline to a PASS."""
    with tempfile.TemporaryDirectory() as td:
        png = os.path.join(td, "art.png")
        _disc_png(png)
        res = raster_to_svg(png, TraceOptions())
        svg = os.path.join(td, "traced.svg")
        with open(svg, "w") as f:
            f.write(res.svg_text)
        out = run(Config(svg_path=svg, out_dir=os.path.join(td, "out")), verbose=False)
        assert out.report.ok(Config(svg_path=svg))
        assert out.report.is_watertight
        assert out.report.is_manifold


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all raster-trace tests passed")
