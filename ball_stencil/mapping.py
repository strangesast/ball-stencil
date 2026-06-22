"""Plane -> sphere parameterization (Lambert azimuthal equal-area).

The SVG centre maps to the dome pole (+z).  Radial distance in the plane maps
to polar angle via the equal-area relation, scaled so the design reference
radius lands exactly at the cap angle:

    rho = |p - center|
    u   = (rho / R_ref) * sin(cap/2)        # in [0,1]
    phi = 2 * asin(u)                       # polar angle from pole
    theta = atan2(dy, dx)                   # azimuth (dy flipped if FLIP_V)

    P(r) = r * (sin phi cos theta, sin phi sin theta, cos phi)

This is an analytic *parameterization*, not a projection of pre-placed 3D
geometry: every output point originates from spherical coordinates.  Because
rho proportional to sin(phi/2), the mapping preserves area up to the constant
(R_ref / sin(cap/2))^2, so the relative size of each splash is preserved.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import sin, pi

import numpy as np


@dataclass
class Mapper:
    center: np.ndarray          # (2,) float64
    r_ref: float                # SVG units mapped to cap angle
    cap_angle_rad: float
    flip_v: bool

    @property
    def _sin_half_cap(self) -> float:
        return sin(self.cap_angle_rad / 2.0)

    def directions(self, pts_xy: np.ndarray) -> np.ndarray:
        """Unit sphere directions for planar points; returns (N,3) float64."""
        p = np.asarray(pts_xy, dtype=np.float64).reshape(-1, 2)
        d = p - self.center
        dx = d[:, 0]
        dy = -d[:, 1] if self.flip_v else d[:, 1]
        rho = np.hypot(dx, dy)
        theta = np.arctan2(dy, dx)
        u = np.clip(rho / self.r_ref * self._sin_half_cap, 0.0, 1.0)
        phi = 2.0 * np.arcsin(u)
        sphi = np.sin(phi)
        dirs = np.empty((len(p), 3), dtype=np.float64)
        dirs[:, 0] = sphi * np.cos(theta)
        dirs[:, 1] = sphi * np.sin(theta)
        dirs[:, 2] = np.cos(phi)
        return dirs

    def to_sphere(self, pts_xy: np.ndarray, radius: float) -> np.ndarray:
        """Map planar points onto the sphere of the given radius. (N,3)"""
        return self.directions(pts_xy) * radius

    # -- scale helpers (mm of surface arc per SVG unit) ----------------------
    def radial_scale(self, rho: float, radius: float) -> float:
        """d(arc length)/d(rho) at planar radius ``rho``."""
        s = self._sin_half_cap / self.r_ref
        u = min(max(rho * s, 0.0), 1.0 - 1e-12)
        dphi_drho = 2.0 * s / np.sqrt(1.0 - u * u)
        return radius * dphi_drho

    def tangential_scale(self, rho: float, radius: float) -> float:
        """Arc length per SVG unit in the tangential (azimuthal) direction."""
        if rho <= 1e-12:
            return self.radial_scale(0.0, radius)
        u = min(rho * self._sin_half_cap / self.r_ref, 1.0)
        phi = 2.0 * np.arcsin(u)
        return radius * np.sin(phi) / rho

    def scale_bounds(self, radius: float) -> tuple[float, float, float]:
        """Return (min, mid, max) surface scale across the cap, for sizing."""
        samples = np.linspace(0.0, self.r_ref, 64)
        vals = []
        for rho in samples:
            vals.append(self.radial_scale(rho, radius))
            vals.append(self.tangential_scale(rho, radius))
        vals = np.asarray(vals)
        mid = self.radial_scale(self.r_ref * 0.5, radius)
        return float(vals.min()), float(mid), float(vals.max())


def build_mapper(center, r_ref: float, cap_angle_rad: float, flip_v: bool) -> Mapper:
    return Mapper(
        center=np.asarray(center, dtype=np.float64),
        r_ref=float(r_ref),
        cap_angle_rad=float(cap_angle_rad),
        flip_v=bool(flip_v),
    )
