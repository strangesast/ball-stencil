/**
 * Minimal hand-rolled WebGL2 preview: one opaque flat-shaded shell + one
 * translucent reference ball, an orbit camera, a slow turntable, and a
 * wireframe toggle. This is the only main-thread compute (render loop +
 * auto-rotation) — all mesh *computation* happens in the worker and arrives
 * here as transferable buffers. No 3D framework dependency (per spec).
 */

// -- tiny mat4 (column-major) ----------------------------------------------
type Mat4 = Float32Array;

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1.0 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye: number[], center: number[], up: number[]): Mat4 {
  const z = norm([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

const IDENT = (): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Rotation about +Y (column-major). Maps the design pole +z to the chosen face. */
function rotY(theta: number): Mat4 {
  const c = Math.cos(theta), s = Math.sin(theta);
  return new Float32Array([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1,
  ]);
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Rotate vector v about unit axis k by angle θ (Rodrigues). The trackball
 *  rotates its basis vectors about the *current* screen axes, which never hit a
 *  gimbal singularity — you can spin the full circumference around any axis. */
function rotateVec(v: number[], k: number[], theta: number): number[] {
  const c = Math.cos(theta), s = Math.sin(theta);
  const kv = dot(k, v);
  const cx = k[1] * v[2] - k[2] * v[1];
  const cy = k[2] * v[0] - k[0] * v[2];
  const cz = k[0] * v[1] - k[1] * v[0];
  return [
    v[0] * c + cx * s + k[0] * kv * (1 - c),
    v[1] * c + cy * s + k[1] * kv * (1 - c),
    v[2] * c + cz * s + k[2] * kv * (1 - c),
  ];
}

// -- shaders ----------------------------------------------------------------
const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uProj, uView, uModel;
out vec3 vWorld;
void main() {
  vWorld = (uModel * vec4(aPos, 1.0)).xyz;   // rotated to the chosen face (Top/Front/Back)
  gl_Position = uProj * uView * vec4(vWorld, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vWorld;
uniform vec3 uColor;
uniform float uAlpha;
uniform vec3 uEye;
out vec4 frag;
void main() {
  // flat per-face normal from screen-space derivatives
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 V = normalize(uEye - vWorld);
  if (dot(n, V) < 0.0) n = -n;               // two-sided (holes/inner wall)
  vec3 L = normalize(vec3(0.4, 0.5, 0.8));
  float diff = max(dot(n, L), 0.0);
  float amb = 0.35 + 0.15 * n.z;
  vec3 c = uColor * (amb + 0.75 * diff);
  frag = vec4(c, uAlpha);
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 frag;
void main() { frag = vec4(uColor, 1.0); }`;

// Textured reference ball: smooth per-vertex normal (sphere centred at origin),
// equirectangular UVs, flat albedo relit by the same simple diffuse+ambient as
// the shell so the two read consistently.
const TEX_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
uniform mat4 uProj, uView;
out vec2 vUV;
out vec3 vN;
void main() {
  vUV = aUV;
  vN = normalize(aPos);
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const TEX_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vN;
uniform sampler2D uTex;
out vec4 frag;
void main() {
  vec3 n = normalize(vN);
  vec3 L = normalize(vec3(0.4, 0.5, 0.8));
  float diff = max(dot(n, L), 0.0);
  float amb = 0.55 + 0.12 * n.z;
  vec3 c = texture(uTex, vUV).rgb * (amb + 0.55 * diff);
  frag = vec4(c, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
  return s;
}
function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
  return p;
}

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  tris: WebGLBuffer;
  lines: WebGLBuffer;
  nTris: number;
  nLines: number;
}

/** Which view the user sees. "projection" = paint on the ball (default first
 *  view); "stencil" = the opaque draw-through shell over the reference ball. */
export type RenderMode = "projection" | "stencil";
/** Which face of the ball the design lands on. Convention (see render()):
 *  top → pole at +z; front → pole rotated to +x (faces the default camera);
 *  back → pole rotated to −x (far side). Pure rotations, so chirality (and the
 *  flip_v un-mirroring) is preserved for every target. */
export type ProjectionTarget = "top" | "front" | "back";
/** World axis the auto-rotate turntable spins about. */
export type SpinAxis = "z" | "x" | "y";

export class Viewer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private lineProg: WebGLProgram;
  private texProg: WebGLProgram;
  private tex: WebGLTexture;
  private texReady = false;
  private shell: GpuMesh | null = null;
  private ball: GpuMesh | null = null;
  private decal: GpuMesh | null = null;

  // camera — free trackball: `dir` points from the target to the eye, `up` is
  // the camera's up. Both are rotated about the current screen axes on drag, so
  // there is no pole/gimbal lock (full-circumference rotation about any axis).
  // Upright 3/4 view: the design's "up" is world +Y (the decal's pole is +z and
  // the model matrix only ever rotates about Y, so +Y is the letter's top on
  // every face). `up` therefore keeps a positive Y so letters read right-side-up.
  private dir = norm([0.466, -0.565, 0.681]); // front-right-above, looking at the top cap
  private up = norm([0.319, 0.825, 0.466]);   // letter top (+Y) points up on screen
  private dist = 320;
  // Pivot is locked to the ball centre (the world origin, where the ball, shell
  // and decal are all centred) so the ball stays centred in the viewport through
  // every rotation and zoom — the standard fixed-pivot orbit ("turntable") rig.
  // There is deliberately no pan, so nothing can push the centre off-screen.
  private target = [0, 0, 0];
  private radiusHint = 105;

  // options
  showBall = true;
  wireframe = false;
  autoRotate = true;
  /** World axis the turntable spins about (configurable, like "Project onto"). */
  spinAxis: SpinAxis = "z";
  /** Default first view: the design projected onto the ball (not the shell). */
  renderMode: RenderMode = "projection";
  projectionTarget: ProjectionTarget = "top";
  /** Projection paint colour (RGB 0..1). Set from the SVG / letter / override. */
  private decalColor: [number, number, number] = [0.85, 0.16, 0.18];
  private dragging = false;
  private rafPaused = false;
  // Active camera fly-to (set/changed artwork → swing it to face the viewer).
  // null when idle; the render loop advances it, then the turntable resumes.
  private anim: { sd: number[]; su: number[]; axis: number[]; angle: number; roll: number; t0: number; dur: number } | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.prog = program(gl, VERT, FRAG);
    this.lineProg = program(gl, VERT, LINE_FRAG);
    this.texProg = program(gl, TEX_VERT, TEX_FRAG);
    this.tex = gl.createTexture()!;
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.09, 0.10, 0.12, 1);
    this.bindInput();
    requestAnimationFrame(this.frame);
  }

  private bindInput() {
    const c = this.canvas;
    const ROT = 0.01; // radians per pixel of drag
    let lastX = 0, lastY = 0; // drag always orbits (no pan — keeps the ball centred)
    // Active touch/mouse pointers, so two fingers can zoom + rotate + twist.
    const pts = new Map<number, { x: number; y: number }>();
    // Two-finger gesture state (centroid, spread, twist angle).
    let prevCx = 0, prevCy = 0, prevDist = 0, prevAng = 0;
    const twoFinger = () => {
      const [a, b] = [...pts.values()];
      return {
        cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        ang: Math.atan2(b.y - a.y, b.x - a.x),
      };
    };
    const beginTwoFinger = () => {
      const g = twoFinger();
      prevCx = g.cx; prevCy = g.cy; prevDist = g.dist; prevAng = g.ang;
    };
    c.addEventListener("pointerdown", (e) => {
      this.anim = null; // grabbing the ball cancels any in-flight fly-to
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.setPointerCapture(e.pointerId);
      if (pts.size === 1) {
        this.dragging = true;
        lastX = e.clientX; lastY = e.clientY;
      } else if (pts.size === 2) {
        this.dragging = false; // hand off to the two-finger gesture
        beginTwoFinger();
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2) {
        // Two fingers do everything at once: pinch = zoom, drag = orbit,
        // twist = roll. (Camera rotation in addition to zoom, per request.)
        const g = twoFinger();
        if (prevDist > 0 && g.dist > 0) {
          this.dist = Math.max(20, Math.min(2000, this.dist * (prevDist / g.dist)));
        }
        this.orbit((g.cx - prevCx) * ROT, (g.cy - prevCy) * ROT);
        let dA = g.ang - prevAng;
        if (dA > Math.PI) dA -= 2 * Math.PI; else if (dA < -Math.PI) dA += 2 * Math.PI;
        this.roll(dA);
        prevCx = g.cx; prevCy = g.cy; prevDist = g.dist; prevAng = g.ang;
        return;
      }
      if (!this.dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this.orbit(dx * ROT, dy * ROT);
    });
    const end = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      try { c.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      if (pts.size === 0) this.dragging = false;
      else if (pts.size === 1) {
        // resume single-pointer orbit from the remaining finger
        this.dragging = true;
        const [p] = [...pts.values()];
        lastX = p.x; lastY = p.y;
      } else if (pts.size === 2) {
        beginTwoFinger();
      }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    const ROT_WHEEL = 0.005; // radians per wheel pixel for trackpad orbit
    // A wheel event is a *mouse wheel* (→ zoom, as before) when it's Firefox's
    // line-mode delta, or a coarse vertical-only step (no deltaX, |deltaY|≥100).
    // Otherwise it's a trackpad two-finger scroll (→ orbit). Pinch arrives as a
    // wheel with ctrlKey set on every platform and always zooms. Touch devices
    // never fire wheel (they use the pointer pinch/orbit path), so they're
    // unaffected; drag-orbit stays as a universal fallback for every input.
    const isMouseWheel = (e: WheelEvent) =>
      e.deltaMode !== 0 ||
      (e.deltaX === 0 && Math.abs(e.deltaY) >= 100 && Number.isInteger(e.deltaY));
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.anim = null; // scrolling/zooming cancels any in-flight fly-to
      if (e.ctrlKey || isMouseWheel(e)) {
        // pinch-zoom / mouse-wheel: dolly in and out
        const k = e.ctrlKey ? 0.01 : 0.001; // pinch deltas are much smaller
        this.dist = Math.max(20, Math.min(2000, this.dist * Math.exp(e.deltaY * k)));
      } else {
        // trackpad two-finger scroll: orbit (deltaX about screen-up, deltaY about
        // screen-right) — the same gesture native macOS/Windows 3D viewers use.
        this.orbit(-e.deltaX * ROT_WHEEL, -e.deltaY * ROT_WHEEL);
      }
    }, { passive: false });
  }

  /** Upload a new shell mesh from transferable buffers. */
  setShell(positions: Float32Array, indices: Uint32Array, outerRadius: number) {
    this.radiusHint = outerRadius;
    this.shell = this.upload(positions, indices);
  }

  setBall(positions: Float32Array, indices: Uint32Array, uvs?: Float32Array) {
    this.ball = this.upload(positions, indices, uvs);
  }

  /** Upload the projection decal (cut holes lifted to the ball). May be empty. */
  setDecal(positions: Float32Array, indices: Uint32Array) {
    this.decal = indices.length ? this.upload(positions, indices) : null;
  }

  /** Set the projection paint colour (RGB components in [0,1]). */
  setDecalColor(rgb: [number, number, number]) {
    this.decalColor = rgb;
  }

  /** Model matrix that rotates the design pole +z onto the chosen face. Applies
   *  in BOTH modes (projection decal AND stencil shell) so "Project onto" is a
   *  first-class control either way; the decal and shell share it so they stay
   *  registered. The reference ball is unrotated. */
  private modelMatrix(): Mat4 {
    if (this.projectionTarget === "front") return rotY(Math.PI / 2); // +z → +x
    if (this.projectionTarget === "back") return rotY(-Math.PI / 2); // +z → −x
    return IDENT(); // top
  }

  /** Orthonormal screen basis: camera right and (true) up for the current dir. */
  private basis(): { right: number[]; up: number[] } {
    const right = norm(cross(this.up, this.dir));
    const up = cross(this.dir, right); // re-orthogonalized true up
    return { right, up };
  }

  /** Trackball orbit: horizontal drag spins about the screen up axis, vertical
   *  about the screen right axis. No clamping — rotation is unbounded. */
  private orbit(dx: number, dy: number) {
    const { right, up } = this.basis();
    this.dir = norm(rotateVec(rotateVec(this.dir, up, -dx), right, -dy));
    this.up = norm(rotateVec(rotateVec(this.up, up, -dx), right, -dy));
  }

  /** Roll about the view direction (two-finger twist). */
  private roll(theta: number) {
    this.up = norm(rotateVec(this.up, this.dir, theta));
  }

  /** World axis the turntable spins about, for the current spinAxis setting. */
  private spinAxisVec(): number[] {
    if (this.spinAxis === "x") return [1, 0, 0];
    if (this.spinAxis === "y") return [0, 1, 0];
    return [0, 0, 1];
  }

  /** World direction from the ball centre to the projected artwork, for the
   *  current face. The decal is built with its pole at +z, then `modelMatrix`
   *  rotates it onto Top(+z) / Front(+x) / Back(−x). */
  private artworkNormal(): number[] {
    if (this.projectionTarget === "front") return [1, 0, 0];
    if (this.projectionTarget === "back") return [-1, 0, 0];
    return [0, 0, 1];
  }

  /** Shortest-arc axis to rotate `from` onto `to`. For the antipodal case
   *  (cross ≈ 0) any axis ⟂ the view works, so fall back to the camera up. */
  private rotAxis(from: number[], to: number[], angle: number): number[] {
    if (angle < 1e-6) return [0, 0, 1];
    if (Math.PI - angle < 1e-3) return norm(this.basis().up);
    return norm(cross(from, to));
  }

  /** Smoothly swing the camera so the projected artwork faces the viewer,
   *  centred AND upright, then let the turntable spin resume if it's enabled.
   *  Called when artwork is set or changed. The view direction rotates onto the
   *  face along the shortest arc; the up vector is then rolled to world +Y (the
   *  design's top on every face) so letters always read right-side-up. */
  focusOnArtwork(durationMs = 650) {
    const to = this.artworkNormal();
    const from = this.dir;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(from, to))));
    const axis = this.rotAxis(from, to, angle);
    // Desired upright up: world +Y made orthogonal to the new view direction.
    const upArc = norm(rotateVec(this.up, axis, angle)); // up carried along the arc
    let upT = [0 - to[0] * to[1], 1 - to[1] * to[1], 0 - to[2] * to[1]]; // +Y ⟂ `to`
    upT = norm(upT);
    // Signed roll about `to` that takes the carried up onto the upright up.
    const c = Math.max(-1, Math.min(1, dot(upArc, upT)));
    const roll = Math.atan2(dot(cross(upArc, upT), to), c);
    // Honour reduced-motion, a zero duration, or an already-aligned ball: snap.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || durationMs <= 0 || (angle < 1e-3 && Math.abs(roll) < 1e-3)) {
      this.dir = to.slice();
      this.up = upT;
      this.anim = null;
      return;
    }
    this.anim = { sd: from.slice(), su: this.up.slice(), axis, angle, roll, t0: performance.now(), dur: durationMs };
  }

  /** Load the equirectangular albedo for the textured ball (one-time GPU upload). */
  setBallTexture(url: string) {
    const gl = this.gl;
    const img = new Image();
    img.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);          // longitude wraps
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);   // clamp at poles
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.texReady = true;
    };
    // If the albedo can't be fetched/decoded (offline before precache, bad path,
    // decode error), fall back to a flat grey pixel so the reference ball still
    // renders (lit, untextured) instead of silently never appearing.
    img.onerror = () => {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE,
        new Uint8Array([160, 160, 165]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.texReady = true;
      console.warn(`ball texture failed to load (${url}); using flat fallback`);
    };
    img.src = url;
  }

  /** Frame the camera distance to fit the current shell radius. The pivot stays
   *  at the ball centre (origin) so the ball is centred in the viewport. */
  fit() {
    this.dist = this.radiusHint * 3.0;
    this.target = [0, 0, 0];
  }

  private upload(positions: Float32Array, indices: Uint32Array, uvs?: Float32Array): GpuMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const pos = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    if (uvs) {
      const uv = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, uv);
      gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    }
    const tris = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, tris);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    // unique wireframe edges
    const edges = new Set<number>();
    const lineIdx: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const key = u < v ? u * 4294967296 + v : v * 4294967296 + u;
        if (!edges.has(key)) { edges.add(key); lineIdx.push(u, v); }
      }
    }
    const lines = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lines);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(lineIdx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, tris, lines, nTris: indices.length, nLines: lineIdx.length };
  }

  private frame = () => {
    if (!this.rafPaused) this.render();
    requestAnimationFrame(this.frame);
  };

  pause(p: boolean) { this.rafPaused = p; }

  private render() {
    const gl = this.gl;
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(c.clientWidth * dpr), h = Math.floor(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Camera fly-to: swing the projected artwork to face the viewer (centred),
    // then hand control back to the turntable. Runs only when artwork is set or
    // changed. Eases in/out and carries the up vector so roll is preserved.
    if (this.anim) {
      const e = Math.min(1, (performance.now() - this.anim.t0) / this.anim.dur);
      const k = e * e * (3 - 2 * e); // smoothstep
      const d = norm(rotateVec(this.anim.sd, this.anim.axis, this.anim.angle * k));
      // Swing the view onto the face, then roll the up vector to upright (+Y).
      let u = norm(rotateVec(this.anim.su, this.anim.axis, this.anim.angle * k));
      u = norm(rotateVec(u, d, this.anim.roll * k));
      this.dir = d;
      this.up = u;
      if (e >= 1) this.anim = null;
    }

    // Turntable spin about the configured world axis; free trackball drag still
    // works. Suppressed during a fly-to so the two don't fight.
    if (this.autoRotate && !this.dragging && !this.anim) {
      const ax = this.spinAxisVec();
      this.dir = norm(rotateVec(this.dir, ax, 0.0045));
      this.up = norm(rotateVec(this.up, ax, 0.0045));
    }

    const { up: trueUp } = this.basis();
    const eye = [
      this.target[0] + this.dist * this.dir[0],
      this.target[1] + this.dist * this.dir[1],
      this.target[2] + this.dist * this.dir[2],
    ];
    const proj = perspective((45 * Math.PI) / 180, w / Math.max(1, h), 1, 6000);
    const view = lookAt(eye, this.target, trueUp);
    const model = this.modelMatrix();
    const projection = this.renderMode === "projection";

    // shell (opaque) — stencil mode only; rotated with `model` (identity here).
    if (!projection && this.shell) {
      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uProj"), false, proj);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uView"), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uModel"), false, model);
      gl.uniform3f(gl.getUniformLocation(this.prog, "uEye"), eye[0], eye[1], eye[2]);
      gl.bindVertexArray(this.shell.vao);
      if (this.wireframe) {
        // uniforms apply to the *currently bound* program, so switch first —
        // otherwise uColor is written against this.prog and lineProg stays black.
        gl.useProgram(this.lineProg);
        gl.uniform3f(gl.getUniformLocation(this.lineProg, "uColor"), 0.8, 0.85, 0.9);
        gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, "uProj"), false, proj);
        gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, "uView"), false, view);
        gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, "uModel"), false, model);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.shell.lines);
        gl.drawElements(gl.LINES, this.shell.nLines, gl.UNSIGNED_INT, 0);
      } else {
        gl.uniform3f(gl.getUniformLocation(this.prog, "uColor"), 0.72, 0.74, 0.8);
        gl.uniform1f(gl.getUniformLocation(this.prog, "uAlpha"), 1.0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.shell.tris);
        gl.drawElements(gl.TRIANGLES, this.shell.nTris, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);
    }

    // Reference ball. When the toggle is on, the textured, lit sphere is drawn
    // (both modes). When it is OFF in projection mode, the ball is instead drawn
    // as a *transparent* sphere — a depth-only pass (colour writes masked) that
    // still occludes the far side of the decal, so the paint reads as sitting on
    // a clear sphere instead of an unoccluded flat cut-out.
    if (this.ball && this.texReady && this.showBall) {
      gl.useProgram(this.texProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.texProg, "uProj"), false, proj);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.texProg, "uView"), false, view);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(gl.getUniformLocation(this.texProg, "uTex"), 0);
      gl.bindVertexArray(this.ball.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ball.tris);
      gl.drawElements(gl.TRIANGLES, this.ball.nTris, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    } else if (projection && this.ball) {
      // invisible occluder: write depth only, no colour
      gl.useProgram(this.texProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.texProg, "uProj"), false, proj);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.texProg, "uView"), false, view);
      gl.colorMask(false, false, false, false);
      gl.bindVertexArray(this.ball.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ball.tris);
      gl.drawElements(gl.TRIANGLES, this.ball.nTris, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      gl.colorMask(true, true, true, true);
    }

    // projection decal — the paint on the ball. Drawn last, in a strong ink
    // tone, with a polygon-offset pull toward the camera (on top of the outward
    // epsilon baked into the geometry) so it never z-fights the sphere.
    if (projection && this.decal) {
      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uProj"), false, proj);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uView"), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uModel"), false, model);
      gl.uniform3f(gl.getUniformLocation(this.prog, "uEye"), eye[0], eye[1], eye[2]);
      gl.uniform3f(gl.getUniformLocation(this.prog, "uColor"),
        this.decalColor[0], this.decalColor[1], this.decalColor[2]);
      gl.uniform1f(gl.getUniformLocation(this.prog, "uAlpha"), 1.0);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1.0, -1.0);
      gl.bindVertexArray(this.decal.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.decal.tris);
      gl.drawElements(gl.TRIANGLES, this.decal.nTris, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
  }
}
