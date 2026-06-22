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

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// -- shaders ----------------------------------------------------------------
const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uProj, uView;
out vec3 vWorld;
void main() {
  vWorld = aPos;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
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

export class Viewer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private lineProg: WebGLProgram;
  private shell: GpuMesh | null = null;
  private ball: GpuMesh | null = null;

  // camera
  private az = 0.6;
  private el = 0.5;
  private dist = 320;
  private target = [0, 0, 40];
  private radiusHint = 105;

  // options
  showBall = true;
  wireframe = false;
  autoRotate = true;
  private dragging = false;
  private rafPaused = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.prog = program(gl, VERT, FRAG);
    this.lineProg = program(gl, VERT, LINE_FRAG);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.09, 0.10, 0.12, 1);
    this.bindInput();
    requestAnimationFrame(this.frame);
  }

  private bindInput() {
    const c = this.canvas;
    let lastX = 0, lastY = 0, mode = 0;
    // Active touch/mouse pointers, so two-finger pinch can zoom on mobile.
    const pts = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    const twoFingerDist = () => {
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    c.addEventListener("pointerdown", (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.setPointerCapture(e.pointerId);
      if (pts.size === 1) {
        this.dragging = true;
        mode = e.button === 2 || e.shiftKey ? 2 : 1;
        lastX = e.clientX; lastY = e.clientY;
      } else if (pts.size === 2) {
        this.dragging = false; // hand off to pinch
        pinchDist = twoFingerDist();
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2) {
        // pinch-to-zoom (dist tracks the camera distance, not render math)
        const d = twoFingerDist();
        if (pinchDist > 0 && d > 0) {
          this.dist = Math.max(20, Math.min(2000, this.dist * (pinchDist / d)));
        }
        pinchDist = d;
        return;
      }
      if (!this.dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (mode === 1) {
        this.az -= dx * 0.01;
        this.el = Math.max(-1.5, Math.min(1.5, this.el + dy * 0.01));
      } else {
        const k = this.dist * 0.0015;
        this.target[0] -= dx * k * Math.cos(this.az);
        this.target[1] += dx * k * Math.sin(this.az);
        this.target[2] += dy * k;
      }
    });
    const end = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      try { c.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      if (pts.size < 2) pinchDist = 0;
      if (pts.size === 0) this.dragging = false;
      else if (pts.size === 1) {
        // resume single-pointer orbit from the remaining finger
        this.dragging = true; mode = 1;
        const [p] = [...pts.values()];
        lastX = p.x; lastY = p.y;
      }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.dist = Math.max(20, Math.min(2000, this.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
  }

  /** Upload a new shell mesh from transferable buffers. */
  setShell(positions: Float32Array, indices: Uint32Array, outerRadius: number) {
    this.radiusHint = outerRadius;
    this.shell = this.upload(positions, indices);
  }

  setBall(positions: Float32Array, indices: Uint32Array) {
    this.ball = this.upload(positions, indices);
  }

  /** Frame the camera distance to fit the current shell radius. */
  fit() {
    this.dist = this.radiusHint * 3.0;
    this.target = [0, 0, this.radiusHint * 0.35];
  }

  private upload(positions: Float32Array, indices: Uint32Array): GpuMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const pos = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
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

    if (this.autoRotate && !this.dragging) this.az += 0.0045;

    const ce = Math.cos(this.el), se = Math.sin(this.el);
    const eye = [
      this.target[0] + this.dist * ce * Math.cos(this.az),
      this.target[1] + this.dist * ce * Math.sin(this.az),
      this.target[2] + this.dist * se,
    ];
    const proj = perspective((45 * Math.PI) / 180, w / Math.max(1, h), 1, 6000);
    const view = lookAt(eye, this.target, [0, 0, 1]);

    // shell (opaque)
    if (this.shell) {
      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uProj"), false, proj);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uView"), false, view);
      gl.uniform3f(gl.getUniformLocation(this.prog, "uEye"), eye[0], eye[1], eye[2]);
      gl.bindVertexArray(this.shell.vao);
      if (this.wireframe) {
        gl.uniform3f(gl.getUniformLocation(this.lineProg, "uColor"), 0.8, 0.85, 0.9);
        gl.useProgram(this.lineProg);
        gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, "uProj"), false, proj);
        gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, "uView"), false, view);
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

    // translucent ball
    if (this.ball && this.showBall) {
      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uProj"), false, proj);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uView"), false, view);
      gl.uniform3f(gl.getUniformLocation(this.prog, "uEye"), eye[0], eye[1], eye[2]);
      gl.uniform3f(gl.getUniformLocation(this.prog, "uColor"), 0.95, 0.55, 0.2);
      gl.uniform1f(gl.getUniformLocation(this.prog, "uAlpha"), 0.28);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(this.ball.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ball.tris);
      gl.drawElements(gl.TRIANGLES, this.ball.nTris, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }
}
