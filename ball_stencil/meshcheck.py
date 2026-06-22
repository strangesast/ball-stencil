"""Mesh validation: watertight manifold, winding, radius, triangle quality."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class MeshReport:
    n_vertices: int
    n_faces: int
    is_watertight: bool
    is_manifold: bool
    consistent_winding: bool
    n_boundary_edges: int
    n_nonmanifold_edges: int
    max_radius_error_mm: float
    edge_len_min: float
    edge_len_max: float
    edge_len_mean: float
    max_aspect_ratio: float
    signed_volume_mm3: float
    n_degenerate: int

    def ok(self, cfg) -> bool:
        return (
            self.is_watertight
            and self.is_manifold
            and self.consistent_winding
            and self.max_radius_error_mm <= cfg.radius_tolerance_mm
            and self.n_degenerate == 0
        )

    def format(self, cfg) -> str:
        status = "PASS" if self.ok(cfg) else "FAIL"
        lines = [
            f"  manifold check ............ {status}",
            f"  vertices / faces .......... {self.n_vertices} / {self.n_faces}",
            f"  watertight ................ {self.is_watertight}",
            f"  manifold (edge deg==2) .... {self.is_manifold} "
            f"(boundary={self.n_boundary_edges}, nonmanifold={self.n_nonmanifold_edges})",
            f"  consistent winding ........ {self.consistent_winding}",
            f"  max |‖P‖-R| ............... {self.max_radius_error_mm:.2e} mm "
            f"(tol {cfg.radius_tolerance_mm})",
            f"  edge length min/mean/max .. {self.edge_len_min:.2f} / "
            f"{self.edge_len_mean:.2f} / {self.edge_len_max:.2f} mm",
            f"  max aspect ratio .......... {self.max_aspect_ratio:.2f}",
            f"  degenerate triangles ...... {self.n_degenerate}",
            f"  signed volume ............. {self.signed_volume_mm3:.1f} mm^3",
        ]
        return "\n".join(lines)


def check_mesh(mesh, cfg) -> MeshReport:
    v = mesh.vertices
    f = mesh.faces
    n = mesh.n_planar

    # --- edges ---------------------------------------------------------------
    directed = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    undirected = np.sort(directed, axis=1)
    uniq, counts = np.unique(undirected, axis=0, return_counts=True)
    n_boundary = int(np.sum(counts == 1))
    n_nonmanifold = int(np.sum(counts > 2))
    # An empty mesh must not pass: np.all([]) is True and sums over empty
    # arrays are 0, which would otherwise report watertight/manifold/clean.
    has_faces = len(f) > 0
    is_watertight = has_faces and n_boundary == 0 and n_nonmanifold == 0
    is_manifold = bool(has_faces and np.all(counts == 2))

    # consistent winding: each directed edge appears at most once
    du = np.unique(directed, axis=0, return_counts=True)[1]
    consistent = bool(np.all(du == 1)) and is_watertight

    # --- radius error --------------------------------------------------------
    norms = np.linalg.norm(v, axis=1)
    err_outer = np.abs(norms[:n] - cfg.outer_radius_mm)
    err_inner = np.abs(norms[n:] - cfg.inner_radius_mm)
    max_radius_error = float(max(err_outer.max(initial=0.0), err_inner.max(initial=0.0)))

    # --- triangle quality ----------------------------------------------------
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    e0 = np.linalg.norm(b - a, axis=1)
    e1 = np.linalg.norm(c - b, axis=1)
    e2 = np.linalg.norm(a - c, axis=1)
    edges = np.concatenate([e0, e1, e2])
    longest = np.maximum.reduce([e0, e1, e2])
    shortest = np.minimum.reduce([e0, e1, e2])
    with np.errstate(divide="ignore", invalid="ignore"):
        aspect = np.where(shortest > 1e-12, longest / shortest, np.inf)
    # Degeneracy by AREA, not just shortest edge: a near-collinear sliver can
    # have three non-trivial edges yet ~zero area and an ill-defined normal.
    areas = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    n_degenerate = int(np.sum((areas <= 1e-9) | (shortest <= 1e-12)))
    max_aspect = float(np.max(aspect[np.isfinite(aspect)], initial=0.0))

    # --- signed volume -------------------------------------------------------
    vol = float(np.sum(a * np.cross(b, c)) / 6.0)

    return MeshReport(
        n_vertices=len(v),
        n_faces=len(f),
        is_watertight=is_watertight,
        is_manifold=is_manifold,
        consistent_winding=consistent,
        n_boundary_edges=n_boundary,
        n_nonmanifold_edges=n_nonmanifold,
        max_radius_error_mm=max_radius_error,
        edge_len_min=float(edges.min(initial=0.0)),
        edge_len_max=float(edges.max(initial=0.0)),
        edge_len_mean=float(edges.mean()) if len(edges) else 0.0,
        max_aspect_ratio=max_aspect,
        signed_volume_mm3=vol,
        n_degenerate=n_degenerate,
    )
