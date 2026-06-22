/**
 * SVG path parsing + adaptive Bezier/segment tessellation.
 * Port of ball_stencil/tessellate.py (flattening) plus the path-data parsing
 * that svgpathtools provides on the Python side.
 *
 * Each segment exposes point(t); subpaths are flattened by recursive
 * subdivision until the midpoint's perpendicular distance from the chord falls
 * below the tolerance (SVG units), capped at depth 18 — identical to the
 * reference _flatten_segment.
 */

export type Pt = [number, number];

interface Seg {
  point(t: number): Pt;
}

class LineSeg implements Seg {
  constructor(private a: Pt, private b: Pt) {}
  point(t: number): Pt {
    return [this.a[0] + (this.b[0] - this.a[0]) * t, this.a[1] + (this.b[1] - this.a[1]) * t];
  }
}

class QuadSeg implements Seg {
  constructor(private p0: Pt, private p1: Pt, private p2: Pt) {}
  point(t: number): Pt {
    const u = 1 - t;
    const a = u * u, b = 2 * u * t, c = t * t;
    return [
      a * this.p0[0] + b * this.p1[0] + c * this.p2[0],
      a * this.p0[1] + b * this.p1[1] + c * this.p2[1],
    ];
  }
}

class CubicSeg implements Seg {
  constructor(private p0: Pt, private p1: Pt, private p2: Pt, private p3: Pt) {}
  point(t: number): Pt {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [
      a * this.p0[0] + b * this.p1[0] + c * this.p2[0] + d * this.p3[0],
      a * this.p0[1] + b * this.p1[1] + c * this.p2[1] + d * this.p3[1],
    ];
  }
}

/** SVG elliptical arc, via endpoint -> centre parameterization (SVG spec). */
class ArcSeg implements Seg {
  private cx = 0;
  private cy = 0;
  private theta = 0;
  private delta = 0;
  private rx: number;
  private ry: number;
  private cosPhi: number;
  private sinPhi: number;
  private degenerate: LineSeg | null = null;

  constructor(
    start: Pt,
    rx: number,
    ry: number,
    xRotDeg: number,
    largeArc: boolean,
    sweep: boolean,
    end: Pt,
  ) {
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const phi = (xRotDeg * Math.PI) / 180.0;
    this.cosPhi = Math.cos(phi);
    this.sinPhi = Math.sin(phi);
    if (rx === 0 || ry === 0) {
      this.degenerate = new LineSeg(start, end);
      this.rx = rx;
      this.ry = ry;
      return;
    }
    const dx2 = (start[0] - end[0]) / 2.0;
    const dy2 = (start[1] - end[1]) / 2.0;
    const x1p = this.cosPhi * dx2 + this.sinPhi * dy2;
    const y1p = -this.sinPhi * dx2 + this.cosPhi * dy2;
    // correct out-of-range radii
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
      const s = Math.sqrt(lambda);
      rx *= s;
      ry *= s;
    }
    this.rx = rx;
    this.ry = ry;
    const sign = largeArc !== sweep ? 1 : -1;
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    if (num < 0) num = 0;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const co = sign * Math.sqrt(den === 0 ? 0 : num / den);
    const cxp = (co * rx * y1p) / ry;
    const cyp = (-co * ry * x1p) / rx;
    this.cx = this.cosPhi * cxp - this.sinPhi * cyp + (start[0] + end[0]) / 2.0;
    this.cy = this.sinPhi * cxp + this.cosPhi * cyp + (start[1] + end[1]) / 2.0;
    const ang = (ux: number, uy: number, vx: number, vy: number): number => {
      const dot = ux * vx + uy * vy;
      const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    };
    this.theta = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dtheta = ang(
      (x1p - cxp) / rx,
      (y1p - cyp) / ry,
      (-x1p - cxp) / rx,
      (-y1p - cyp) / ry,
    );
    if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
    else if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
    this.delta = dtheta;
  }

  point(t: number): Pt {
    if (this.degenerate) return this.degenerate.point(t);
    const a = this.theta + t * this.delta;
    const x = this.rx * Math.cos(a);
    const y = this.ry * Math.sin(a);
    return [
      this.cosPhi * x - this.sinPhi * y + this.cx,
      this.sinPhi * x + this.cosPhi * y + this.cy,
    ];
  }
}

export interface Subpath {
  segs: Seg[];
}

const NUM_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

interface Token {
  cmd: string;
  args: number[];
}

/** Tokenize a path 'd' string into commands with numeric args (arc-flag aware). */
function tokenize(d: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = d.length;
  const isCmd = (ch: string) => /[MmLlHhVvCcSsQqTtAaZz]/.test(ch);

  const readNumber = (): number | null => {
    // skip separators
    while (i < n && (d[i] === " " || d[i] === "," || d[i] === "\t" || d[i] === "\n" || d[i] === "\r")) i++;
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(d);
    if (!m || m.index !== i) return null;
    i = NUM_RE.lastIndex;
    return parseFloat(m[0]);
  };
  const readFlag = (): number | null => {
    while (i < n && (d[i] === " " || d[i] === "," || d[i] === "\t" || d[i] === "\n" || d[i] === "\r")) i++;
    if (i < n && (d[i] === "0" || d[i] === "1")) {
      const v = d[i] === "1" ? 1 : 0;
      i++;
      return v;
    }
    return null;
  };

  while (i < n) {
    const ch = d[i];
    if (ch === " " || ch === "," || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (!isCmd(ch)) {
      // stray number with no command: stop
      break;
    }
    const cmd = ch;
    i++;
    if (cmd === "Z" || cmd === "z") {
      tokens.push({ cmd, args: [] });
      continue;
    }
    const lower = cmd.toLowerCase();
    const arity =
      lower === "m" || lower === "l" || lower === "t"
        ? 2
        : lower === "h" || lower === "v"
        ? 1
        : lower === "c"
        ? 6
        : lower === "s" || lower === "q"
        ? 4
        : lower === "a"
        ? 7
        : 2;
    // Read at least one group; repeat while numbers remain.
    let first = true;
    while (true) {
      const args: number[] = [];
      let ok = true;
      for (let k = 0; k < arity; k++) {
        if (lower === "a" && (k === 3 || k === 4)) {
          const f = readFlag();
          if (f === null) { ok = false; break; }
          args.push(f);
        } else {
          const v = readNumber();
          if (v === null) { ok = false; break; }
          args.push(v);
        }
      }
      if (!ok) {
        if (first) {
          // malformed command with no args; skip
        }
        break;
      }
      tokens.push({ cmd, args });
      first = false;
      // peek: if next token is a command letter, stop repeating
      let j = i;
      while (j < n && (d[j] === " " || d[j] === "," || d[j] === "\t" || d[j] === "\n" || d[j] === "\r")) j++;
      if (j >= n || isCmd(d[j])) break;
    }
  }
  return tokens;
}

/** Parse path data into continuous subpaths of segments. */
export function parsePathSubpaths(d: string): Subpath[] {
  const tokens = tokenize(d);
  const subpaths: Subpath[] = [];
  let cur: Seg[] = [];
  let started = false;
  let pos: Pt = [0, 0];
  let startPt: Pt = [0, 0];
  let prevCmd = "";
  let prevCtrl: Pt | null = null;

  const startSub = (p: Pt) => {
    if (started && cur.length) subpaths.push({ segs: cur });
    cur = [];
    started = true;
    startPt = [p[0], p[1]];
    pos = [p[0], p[1]];
  };

  for (const { cmd, args } of tokens) {
    const rel = cmd === cmd.toLowerCase() && cmd !== cmd.toUpperCase();
    const lower = cmd.toLowerCase();
    const ax = (i: number) => (rel ? pos[0] + args[i] : args[i]);
    const ay = (i: number) => (rel ? pos[1] + args[i] : args[i]);

    if (lower === "m") {
      startSub([ax(0), ay(1)]);
      prevCtrl = null;
    } else if (lower === "z") {
      if (started && cur.length) {
        if (pos[0] !== startPt[0] || pos[1] !== startPt[1]) {
          cur.push(new LineSeg([pos[0], pos[1]], [startPt[0], startPt[1]]));
        }
        pos = [startPt[0], startPt[1]];
      }
      prevCtrl = null;
    } else if (lower === "l") {
      const p: Pt = [ax(0), ay(1)];
      cur.push(new LineSeg([pos[0], pos[1]], p));
      pos = p;
      prevCtrl = null;
    } else if (lower === "h") {
      const x = rel ? pos[0] + args[0] : args[0];
      const p: Pt = [x, pos[1]];
      cur.push(new LineSeg([pos[0], pos[1]], p));
      pos = p;
      prevCtrl = null;
    } else if (lower === "v") {
      const y = rel ? pos[1] + args[0] : args[0];
      const p: Pt = [pos[0], y];
      cur.push(new LineSeg([pos[0], pos[1]], p));
      pos = p;
      prevCtrl = null;
    } else if (lower === "c") {
      const c1: Pt = [ax(0), ay(1)];
      const c2: Pt = [ax(2), ay(3)];
      const p: Pt = [ax(4), ay(5)];
      cur.push(new CubicSeg([pos[0], pos[1]], c1, c2, p));
      pos = p;
      prevCtrl = c2;
    } else if (lower === "s") {
      const reflect: Pt =
        prevCmd === "c" || prevCmd === "s"
          ? [2 * pos[0] - prevCtrl![0], 2 * pos[1] - prevCtrl![1]]
          : [pos[0], pos[1]];
      const c2: Pt = [ax(0), ay(1)];
      const p: Pt = [ax(2), ay(3)];
      cur.push(new CubicSeg([pos[0], pos[1]], reflect, c2, p));
      pos = p;
      prevCtrl = c2;
    } else if (lower === "q") {
      const c1: Pt = [ax(0), ay(1)];
      const p: Pt = [ax(2), ay(3)];
      cur.push(new QuadSeg([pos[0], pos[1]], c1, p));
      pos = p;
      prevCtrl = c1;
    } else if (lower === "t") {
      const reflect: Pt =
        prevCmd === "q" || prevCmd === "t"
          ? [2 * pos[0] - prevCtrl![0], 2 * pos[1] - prevCtrl![1]]
          : [pos[0], pos[1]];
      const p: Pt = [ax(0), ay(1)];
      cur.push(new QuadSeg([pos[0], pos[1]], reflect, p));
      pos = p;
      prevCtrl = reflect;
      // (T uses ax(0)/ay(1) for its single endpoint)
    } else if (lower === "a") {
      const p: Pt = [ax(5), ay(6)];
      cur.push(
        new ArcSeg(
          [pos[0], pos[1]],
          args[0],
          args[1],
          args[2],
          args[3] !== 0,
          args[4] !== 0,
          p,
        ),
      );
      pos = p;
      prevCtrl = null;
    }
    prevCmd = lower;
  }
  if (started && cur.length) subpaths.push({ segs: cur });
  return subpaths;
}

function flattenSegment(
  seg: Seg,
  t0: number,
  t1: number,
  tol: number,
  depth: number,
  maxDepth: number,
  out: Pt[],
): void {
  const p0 = seg.point(t0);
  const p1 = seg.point(t1);
  const tm = (t0 + t1) / 2;
  const pm = seg.point(tm);
  const chordX = p1[0] - p0[0];
  const chordY = p1[1] - p0[1];
  const clen = Math.hypot(chordX, chordY);
  let dev: number;
  if (clen <= 1e-12) {
    dev = Math.hypot(pm[0] - p0[0], pm[1] - p0[1]);
  } else {
    dev = Math.abs((pm[0] - p0[0]) * -chordY + (pm[1] - p0[1]) * chordX) / clen;
  }
  if (dev <= tol || depth >= maxDepth) {
    out.push(p1);
    return;
  }
  flattenSegment(seg, t0, tm, tol, depth + 1, maxDepth, out);
  flattenSegment(seg, tm, t1, tol, depth + 1, maxDepth, out);
}

/** Flatten one continuous subpath to a polyline (both endpoints included). */
export function flattenSubpath(sub: Subpath, tol: number, maxDepth = 18): Pt[] {
  const pts: Pt[] = [];
  if (sub.segs.length === 0) return pts;
  pts.push(sub.segs[0].point(0));
  for (const seg of sub.segs) flattenSegment(seg, 0, 1, tol, 0, maxDepth, pts);
  return pts;
}

/** Remove consecutive duplicate points (eps = 1e-9, matching the reference). */
export function dedupePolyline(points: Pt[], eps = 1e-9): Pt[] {
  if (points.length === 0) return [];
  const out: Pt[] = [points[0]];
  for (let k = 1; k < points.length; k++) {
    const a = points[k];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) > eps || Math.abs(a[1] - b[1]) > eps) out.push(a);
  }
  return out;
}
