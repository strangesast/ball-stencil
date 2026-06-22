/**
 * Mesh export: binary STL and Wavefront OBJ (dependency-free).
 * Port of ball_stencil/export.py.
 */

function faceNormal(
  v: Float64Array,
  ia: number,
  ib: number,
  ic: number,
): [number, number, number] {
  const ax = v[ia * 3], ay = v[ia * 3 + 1], az = v[ia * 3 + 2];
  const bx = v[ib * 3], by = v[ib * 3 + 1], bz = v[ib * 3 + 2];
  const cx = v[ic * 3], cy = v[ic * 3 + 1], cz = v[ic * 3 + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const wx = cx - ax, wy = cy - ay, wz = cz - az;
  let nx = uy * wz - uz * wy;
  let ny = uz * wx - ux * wz;
  let nz = ux * wy - uy * wx;
  let ln = Math.hypot(nx, ny, nz);
  if (ln === 0) ln = 1.0;
  return [nx / ln, ny / ln, nz / ln];
}

/** Binary STL: 80-byte header, uint32 count, then per-tri normal+verts+attr. */
export function writeStl(vertices: Float64Array, faces: Int32Array): ArrayBuffer {
  const nFaces = faces.length / 3;
  const buf = new ArrayBuffer(84 + nFaces * 50);
  const dv = new DataView(buf);
  const header = "ball-stencil binary STL";
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nFaces, true);
  let off = 84;
  for (let i = 0; i < nFaces; i++) {
    const ia = faces[i * 3], ib = faces[i * 3 + 1], ic = faces[i * 3 + 2];
    const [nx, ny, nz] = faceNormal(vertices, ia, ib, ic);
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
    off += 12;
    for (const idx of [ia, ib, ic]) {
      dv.setFloat32(off, vertices[idx * 3], true);
      dv.setFloat32(off + 4, vertices[idx * 3 + 1], true);
      dv.setFloat32(off + 8, vertices[idx * 3 + 2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return buf;
}

/** Wavefront OBJ with 1-based indices, 6-decimal vertices. */
export function writeObj(vertices: Float64Array, faces: Int32Array): string {
  const nV = vertices.length / 3;
  const nF = faces.length / 3;
  const lines: string[] = ["# ball-stencil OBJ"];
  for (let i = 0; i < nV; i++) {
    lines.push(
      `v ${vertices[i * 3].toFixed(6)} ${vertices[i * 3 + 1].toFixed(6)} ${vertices[i * 3 + 2].toFixed(6)}`,
    );
  }
  for (let i = 0; i < nF; i++) {
    lines.push(`f ${faces[i * 3] + 1} ${faces[i * 3 + 1] + 1} ${faces[i * 3 + 2] + 1}`);
  }
  return lines.join("\n") + "\n";
}

/** UV sphere (reference ball): nu longitude x nv latitude segments. */
export function uvSphere(radius: number, nu = 96, nv = 48): { vertices: Float64Array; faces: Int32Array } {
  const verts: number[] = [];
  for (let iv = 0; iv < nv; iv++) {
    const vv = (Math.PI * iv) / (nv - 1);
    for (let iu = 0; iu < nu; iu++) {
      const uu = (2 * Math.PI * iu) / nu;
      verts.push(
        radius * Math.sin(vv) * Math.cos(uu),
        radius * Math.sin(vv) * Math.sin(uu),
        radius * Math.cos(vv),
      );
    }
  }
  const faces: number[] = [];
  for (let i = 0; i < nv - 1; i++) {
    for (let j = 0; j < nu; j++) {
      const a = i * nu + j;
      const b = i * nu + ((j + 1) % nu);
      const c = (i + 1) * nu + j;
      const d = (i + 1) * nu + ((j + 1) % nu);
      faces.push(a, c, b, b, c, d);
    }
  }
  return { vertices: new Float64Array(verts), faces: new Int32Array(faces) };
}
