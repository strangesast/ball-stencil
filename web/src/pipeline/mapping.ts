/**
 * Plane -> sphere parameterization (Lambert azimuthal equal-area).
 * Port of ball_stencil/mapping.py.
 *
 *   rho = |p - center|
 *   u   = (rho / R_ref) * sin(cap/2)        # in [0,1]
 *   phi = 2 * asin(u)                       # polar angle from pole
 *   theta = atan2(dy, dx)                   # azimuth (dy flipped if flip_v)
 *   P(r) = r * (sin phi cos theta, sin phi sin theta, cos phi)
 */

export class Mapper {
  readonly cx: number;
  readonly cy: number;
  readonly rRef: number;
  readonly capAngleRad: number;
  readonly flipV: boolean;

  constructor(
    center: [number, number],
    rRef: number,
    capAngleRad: number,
    flipV: boolean,
  ) {
    if (!(rRef > 0.0)) {
      throw new Error(
        `design reference radius must be > 0 (got ${rRef}); the artwork may ` +
          "have collapsed to a single point or an empty region",
      );
    }
    this.cx = center[0];
    this.cy = center[1];
    this.rRef = rRef;
    this.capAngleRad = capAngleRad;
    this.flipV = flipV;
  }

  get sinHalfCap(): number {
    return Math.sin(this.capAngleRad / 2.0);
  }

  /** Unit sphere direction for one planar point. */
  direction(x: number, y: number): [number, number, number] {
    const dx = x - this.cx;
    const dyRaw = y - this.cy;
    const dy = this.flipV ? -dyRaw : dyRaw;
    const rho = Math.hypot(dx, dy);
    const theta = Math.atan2(dy, dx);
    let u = (rho / this.rRef) * this.sinHalfCap;
    if (u < 0) u = 0;
    else if (u > 1) u = 1;
    const phi = 2.0 * Math.asin(u);
    const sphi = Math.sin(phi);
    return [sphi * Math.cos(theta), sphi * Math.sin(theta), Math.cos(phi)];
  }

  /** d(arc length)/d(rho) at planar radius rho. */
  radialScale(rho: number, radius: number): number {
    const s = this.sinHalfCap / this.rRef;
    let u = rho * s;
    if (u < 0.0) u = 0.0;
    else if (u > 1.0 - 1e-12) u = 1.0 - 1e-12;
    const dphiDrho = (2.0 * s) / Math.sqrt(1.0 - u * u);
    return radius * dphiDrho;
  }

  /** Arc length per SVG unit in the tangential (azimuthal) direction. */
  tangentialScale(rho: number, radius: number): number {
    if (rho <= 1e-12) return this.radialScale(0.0, radius);
    let u = (rho * this.sinHalfCap) / this.rRef;
    if (u > 1.0) u = 1.0;
    const phi = 2.0 * Math.asin(u);
    return (radius * Math.sin(phi)) / rho;
  }

  /** Surface area (mm^2) per unit planar area at planar radius rho. */
  arealScale(rho: number, radius: number): number {
    return this.radialScale(rho, radius) * this.tangentialScale(rho, radius);
  }

  /** Return [min, mid, max] surface scale across the cap, for sizing. */
  scaleBounds(radius: number): [number, number, number] {
    let mn = Infinity;
    let mx = -Infinity;
    const N = 64;
    for (let i = 0; i < N; i++) {
      const rho = (this.rRef * i) / (N - 1);
      const r = this.radialScale(rho, radius);
      const t = this.tangentialScale(rho, radius);
      if (r < mn) mn = r;
      if (r > mx) mx = r;
      if (t < mn) mn = t;
      if (t > mx) mx = t;
    }
    const mid = this.radialScale(this.rRef * 0.5, radius);
    return [mn, mid, mx];
  }
}
