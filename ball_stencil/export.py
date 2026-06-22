"""Mesh export: binary STL and Wavefront OBJ (dependency-free)."""

from __future__ import annotations

import struct

import numpy as np


def _face_normals(v: np.ndarray, f: np.ndarray) -> np.ndarray:
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    n = np.cross(b - a, c - a)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln == 0] = 1.0
    return n / ln


def write_stl(path: str, vertices: np.ndarray, faces: np.ndarray) -> None:
    """Write a binary STL file."""
    v = np.asarray(vertices, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64)
    normals = _face_normals(v, f).astype(np.float32)
    tris = v[f].astype(np.float32)  # (F,3,3)

    with open(path, "wb") as fh:
        fh.write(b"ball-stencil binary STL".ljust(80, b"\0"))
        fh.write(struct.pack("<I", len(f)))
        buf = bytearray()
        for i in range(len(f)):
            buf += normals[i].tobytes()
            buf += tris[i].tobytes()
            buf += b"\0\0"
        fh.write(buf)


def write_obj(path: str, vertices: np.ndarray, faces: np.ndarray) -> None:
    """Write a Wavefront OBJ file (1-based indices)."""
    v = np.asarray(vertices, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64) + 1
    with open(path, "w") as fh:
        fh.write("# ball-stencil OBJ\n")
        np.savetxt(fh, v, fmt="v %.6f %.6f %.6f")
        np.savetxt(fh, f, fmt="f %d %d %d")
