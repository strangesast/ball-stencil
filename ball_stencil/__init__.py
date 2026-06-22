"""Vector SVG -> spherical draw-through stencil pipeline.

Converts filled SVG artwork into a watertight, thickened hemispherical shell
that slips over a ball, with through-cut holes where the artwork is filled.
"""

from .config import Config
from .pipeline import run, PipelineResult

__all__ = ["Config", "run", "PipelineResult"]
