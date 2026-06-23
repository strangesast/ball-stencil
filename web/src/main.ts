/**
 * Main thread: UI only. Parameter editing/validation, posting parameters to the
 * geometry worker, rendering the returned transferable mesh, local persistence,
 * the translucent first-run reference ball, and the PWA shell. No geometry
 * compute here (that all lives in the worker) beyond the cheap reference-ball
 * UV sphere for the translucent preview.
 */
import { UI_DEFAULT_PARAMS, Params, validateParams, ballRadius } from "./pipeline/config";
import { uvSphereTextured } from "./pipeline/exportmesh";
import { Viewer } from "./viewer";
import { Sheets } from "./ui/sheet";
import { loadState, saveMeta, saveSvg, RenderMode, ProjectionTarget, SpinAxis, TraceBackend, ArtworkSource } from "./persist";
import { DEFAULT_PAINT_HEX, hexToRgb } from "./color";
import { initPwa } from "./pwa";
import type { MeshReport } from "./pipeline/meshcheck";
import type { BuildInfo } from "./worker";

// -- parameter schema (every parameter is user-configurable) ----------------
interface Ctl { key: keyof Params; label: string; unit?: string; step?: number; min?: number; help: string; options?: { value: string; label: string }[]; }
interface Grp { name: string; ctls: Ctl[]; }
const GROUPS: Grp[] = [
  { name: "Ball / shell", ctls: [
    { key: "sphere_diameter_mm", label: "Sphere diameter", unit: "mm", step: 1, min: 0.001, help: "Diameter of the ball the shell wraps." },
    { key: "fit_clearance_mm", label: "Fit clearance", unit: "mm", step: 0.1, min: 0, help: "Gap so the shell slips over the ball." },
    { key: "wall_thickness_mm", label: "Wall thickness", unit: "mm", step: 0.1, min: 0.001, help: "Radial thickness of the stencil shell." },
    { key: "cap_angle_deg", label: "Cap angle", unit: "deg", step: 1, min: 0.001, help: "Polar coverage; 90° is a hemisphere." },
  ]},
  { name: "Design placement", ctls: [
    { key: "design_margin", label: "Design margin", unit: "×", step: 0.01, min: 0.001, help: "Scales artwork placement on the cap." },
    { key: "design_reference_radius", label: "Reference radius", unit: "svg", help: "SVG units to fit the design; blank = auto." },
    { key: "flip_v", label: "Flip V (un-mirror)", help: "Flip vertically to un-mirror the artwork." },
  ]},
  { name: "Tessellation / meshing", ctls: [
    { key: "mesh_strategy", label: "Mesh strategy", help: "Constrained = smooth poly2tri cut edge (follows the artwork). Centroid = legacy faceted edge.", options: [
      { value: "constrained", label: "Constrained (smooth)" },
      { value: "centroid", label: "Centroid (legacy)" },
    ]},
    { key: "boundary_smoothness_mm", label: "Edge smoothness", unit: "mm", step: 0.01, min: 0.001, help: "How closely the cut edge follows the design curve (constrained only)." },
    { key: "target_edge_mm", label: "Target edge", unit: "mm", step: 0.1, min: 0.001, help: "Target triangle edge; smaller = denser mesh." },
    { key: "chord_error_mm", label: "Chord error", unit: "mm", step: 0.01, min: 0.001, help: "Max curve-flattening deviation (centroid only)." },
    { key: "min_segment_mm", label: "Min segment", unit: "mm", step: 0.01, min: 0, help: "Shortest segment when flattening curves." },
  ]},
  { name: "Cleanup", ctls: [
    { key: "cut_separation_svg", label: "Cut separation", unit: "svg", step: 0.05, min: 0, help: "Merge cuts closer than this (SVG units)." },
    { key: "snap_grid_svg", label: "Snap grid", unit: "svg", step: 0.01, min: 0, help: "Weld near-coincident points to this grid." },
    { key: "min_island_area_mm2", label: "Min island area", unit: "mm²", step: 0.5, min: 0, help: "Drop/flag material islands below this area." },
    { key: "radius_tolerance_mm", label: "Radius tolerance", unit: "mm", step: 0.001, min: 0, help: "Allowed sphere-radius error in validation." },
  ]},
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// -- restorable state -------------------------------------------------------
const restored = loadState();
let params: Params = restored ? { ...restored.params } : { ...UI_DEFAULT_PARAMS };
let svgText: string | null = restored?.svgText ?? null;
let svgName = restored?.svgName ?? "stencil";
let expandedGroups = new Set<string>(restored?.expandedGroups ?? []);
// View mode (default first view = the on-ball projection); restored if the user
// has been here before. These drive only rendering — never a worker rebuild.
let renderMode: RenderMode = restored?.renderMode ?? "projection";
let projectionTarget: ProjectionTarget = restored?.projectionTarget ?? "top";
let spinAxis: SpinAxis = restored?.spinAxis ?? "z";
// Paint colour: an explicit override wins; otherwise the design's own SVG fill;
// otherwise the configured default. `letterColor` is the swatch the generator
// embeds into a typed letter (which then flows in as the SVG's fill).
let paintOverride: string | null = restored?.paintOverride ?? null;
let letterColor: string = restored?.letterColor ?? DEFAULT_PAINT_HEX;
let lastSvgColor: string | null = null;
// The character(s) of the currently-shown generated letter (null when the
// active artwork is an uploaded SVG or a traced raster). Lets the letter-colour
// swatch re-embed a new colour into the live letter, mirroring how the trace
// threshold re-traces the current raster.
let lastLetter: string | null = null;
// Raster-trace options (apply only when the picked file is an image). Restored
// from the persisted meta; written back on change.
let traceBackend: TraceBackend = restored?.traceBackend ?? "potrace";
let traceThreshold: number = restored?.traceThreshold ?? 128;
// Which input the Artwork dialog shows: a typed letter ("text") or an image
// file ("image"). Auto-switches when new artwork arrives; user-toggleable; the
// trace options + image preview within the image pane react to the active file.
let artworkSource: ArtworkSource = restored?.artworkSource ?? "text";
// Object URL backing the image-preview thumbnail; revoked before each refresh.
let previewUrl: string | null = null;
let jobId = 0;

// Accepted raster formats — ONE source of truth for the picker accept, the
// drag/drop branch, and validation (all decodable by createImageBitmap). SVG is
// routed to the existing loader; everything matching this is traced.
const RASTER_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;
// The bundled first-run sample is a placeholder, not user data: it is re-derived
// on each empty launch, never persisted, and labelled as a sample. Any real
// artwork (file, drop, or generated letter) clears this for the session.
let isDefaultArtwork = false;
// The default loads asynchronously (lazy font); if the user supplies artwork
// before it resolves, the late default must not clobber their choice.
let userArtworkLoaded = false;

const viewer = new Viewer($("gl") as HTMLCanvasElement);
viewer.renderMode = renderMode;
viewer.projectionTarget = projectionTarget;
viewer.spinAxis = spinAxis;
viewer.setBallTexture(import.meta.env.BASE_URL + "ball_optx.jpg");

/** Colour the projection paint actually uses, in priority order. */
function resolvedPaint(): string {
  return paintOverride ?? lastSvgColor ?? DEFAULT_PAINT_HEX;
}
function applyPaint() {
  viewer.setDecalColor(hexToRgb(resolvedPaint()));
}
applyPaint();
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const sheets = new Sheets();

// -- persistence ------------------------------------------------------------
function persist() {
  saveMeta({
    params,
    svgName,
    openPanel: sheets.current(),
    expandedGroups: [...expandedGroups],
    renderMode,
    projectionTarget,
    spinAxis,
    paintOverride,
    letterColor,
    traceBackend,
    traceThreshold,
    artworkSource,
  });
}

// The five launcher panels, by their data-panel id (also used as the URL hash).
const PANELS = ["artwork", "params", "report", "downloads", "view"] as const;

/** Reflect the open panel in the URL via replaceState — a hash only, so it
 *  never adds a back/forward entry and never hits the server, yet survives a
 *  refresh or dev autoreload. Empty hash when every panel is closed. */
function syncUrl(name: string | null) {
  const base = location.pathname + location.search;
  const next = name ? `${base}#${name}` : base;
  if (next !== base + location.hash) history.replaceState(history.state, "", next);
}

// -- worker messaging -------------------------------------------------------
worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "result") {
    if (m.jobId !== jobId) return; // stale
    onResult(m.report as MeshReport, m.ok as boolean, m.info as BuildInfo,
      new Float32Array(m.positions), new Uint32Array(m.indices),
      new Float32Array(m.decalPositions), new Uint32Array(m.decalIndices),
      m.ballRadius as number);
  } else if (m.type === "error") {
    // jobId === -1 is an escaped/global worker error not tied to a build; always
    // surface it. Otherwise drop errors from superseded builds.
    if (m.jobId !== -1 && m.jobId !== jobId) return;
    showError(m.message as string);
  } else if (m.type === "export") {
    finishDownload(m.kind as string, m.buffer as ArrayBuffer);
  } else if (m.type === "exportError") {
    setOverlay("Export failed: " + m.message, true);
  }
};

// Final safety net: a worker that fails to load/instantiate (or any error the
// worker itself couldn't post) must not leave the badge stuck on "building…".
worker.onerror = (e) => {
  showError(`worker crashed: ${e.message || "unknown error"}`);
};
worker.onmessageerror = () => {
  showError("worker message could not be deserialized");
};

/** Refresh the textured reference ball to the current sphere diameter. */
function refreshBall() {
  const { vertices, faces, uvs } = uvSphereTextured(ballRadius(params), 96, 48);
  viewer.setBall(Float32Array.from(vertices), Uint32Array.from(faces), Float32Array.from(uvs));
}

function build() {
  if (svgText === null) return;
  try {
    validateParams(params);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }
  jobId += 1;
  setBadge("busy", "building…");
  worker.postMessage({ type: "build", jobId, svgText, name: svgName, params });
  refreshBall();
}

let debounceTimer = 0;
function scheduleBuild() {
  clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(build, 180);
}

let firstMesh = true;
// Base (mode-independent) summary of the latest successful build, so the HUD can
// be re-composed with the current view mode when the user toggles mode/target
// (which does not trigger a rebuild).
let lastBuildSummary: string | null = null;
let lastDecalTris = 0;
function onResult(report: MeshReport, ok: boolean, info: BuildInfo, pos: Float32Array, idx: Uint32Array,
                  decalPos: Float32Array, decalIdx: Uint32Array, _ballR: number) {
  viewer.setShell(pos, idx, info.outerRadius);
  viewer.setDecal(decalPos, decalIdx);
  lastDecalTris = info.decalTris;
  // Pick up the design's own colour and repaint (unless the user overrode it).
  lastSvgColor = info.svgColor;
  applyPaint();
  if (!paintOverride) {
    const pc = $("paint-color") as HTMLInputElement | null;
    if (pc) pc.value = resolvedPaint();
  }
  if (firstMesh) { viewer.fit(); firstMesh = false; }
  renderReport(report, ok, info);
  lastBuildSummary = `${report.nFaces.toLocaleString()} triangles · holes ${info.nCutRegions} · R_ref ${info.rRef.toFixed(1)} svg`;
  refreshViewOverlay();
  enableDownloads(true);
  // Test hooks: count rebuilds (a mode/target/colour switch must NOT increment)
  // and expose the parsed design colour.
  const w = window as unknown as { __resultCount?: number; __svgColor?: string | null };
  w.__resultCount = (w.__resultCount ?? 0) + 1;
  w.__svgColor = info.svgColor;
}

/** Append the current view mode to the build summary in the HUD overlay. The
 *  PASS/FAIL report (about the mesh) is independent of the view mode. */
function refreshViewOverlay() {
  if (lastBuildSummary === null) return;
  const mode = renderMode === "projection" ? "projection" : "3D stencil";
  let suffix = ` · ${mode} — ${projectionTarget}`;
  if (renderMode === "projection" && lastDecalTris === 0) suffix += " (nothing to paint)";
  setOverlay(lastBuildSummary + suffix);
}

// -- status HUD + report rendering ------------------------------------------
function setBadge(kind: "pass" | "fail" | "busy", text: string) {
  const b = $("badge");
  b.className = "badge " + kind;
  b.textContent = text;
}

function setHudWarn(text: string | null) {
  const w = $("hud-warn");
  if (text) { w.textContent = "⚠ " + text; w.hidden = false; }
  else { w.textContent = ""; w.hidden = true; }
}

function renderReport(r: MeshReport, ok: boolean, info: BuildInfo) {
  setBadge(ok ? "pass" : "fail", ok ? "PASS" : "FAIL");
  const yn = (b: boolean) => `<span class="${b ? "ok" : "no"}">${b ? "yes" : "no"}</span>`;
  const radPass = r.maxRadiusErrorMm <= params.radius_tolerance_mm;
  const rows: [string, string][] = [
    ["vertices / faces", `${r.nVertices.toLocaleString()} / ${r.nFaces.toLocaleString()}`],
    ["watertight", yn(r.isWatertight)],
    ["manifold (edge deg = 2)", `${yn(r.isManifold)} <span class="k">(bnd ${r.nBoundaryEdges}, nm ${r.nNonmanifoldEdges})</span>`],
    ["consistent winding", yn(r.consistentWinding)],
    ["max |‖P‖−R|", `<span class="${radPass ? "ok" : "no"}">${r.maxRadiusErrorMm.toExponential(2)} mm</span>`],
    ["edge min/mean/max", `${r.edgeLenMin.toFixed(2)} / ${r.edgeLenMean.toFixed(2)} / ${r.edgeLenMax.toFixed(2)} mm`],
    ["max aspect ratio", r.maxAspectRatio.toFixed(1)],
    ["degenerate triangles", `<span class="${r.nDegenerate === 0 ? "ok" : "no"}">${r.nDegenerate}</span>`],
    ["signed volume", `${r.signedVolumeMm3.toFixed(1)} mm³`],
    ["inner / outer radius", `${info.innerRadius.toFixed(2)} / ${info.outerRadius.toFixed(2)} mm`],
    ["mapping centre", `(${info.center[0].toFixed(1)}, ${info.center[1].toFixed(1)})`],
    ["chord error", `${info.chordErrorMm.toFixed(3)} mm`],
    ["planar verts / spacing", `${info.nPlanar.toLocaleString()} / ${info.spacingSvg.toFixed(2)} svg`],
  ];
  let html = "<table>" + rows.map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`).join("") + "</table>";

  const nComp = info.islands.length;
  html += `<div class="warn">cut holes: ${info.nCutRegions} · material components: ${nComp}`;
  let hudWarn: string | null = null;
  if (nComp > 1) {
    const frees = info.islands.slice(1).map((a) => a.toFixed(1)).join(", ");
    html += `<br/>⚠ ${nComp - 1} free island(s) — would fall out of a physical stencil (areas mm²: ${frees})`;
    hudWarn = `${nComp - 1} free island(s) — stencil would fall apart`;
  }
  html += "</div>";
  $("report-body").innerHTML = html;
  // The badge + this warning float persistently over the canvas via the HUD.
  setHudWarn(ok ? hudWarn : "build failed validation");
}

function showError(msg: string) {
  setBadge("fail", "FAIL");
  $("report-body").innerHTML = `<div class="warn no">⚠ ${escapeHtml(msg)}</div>`;
  setHudWarn(msg);
  setOverlay(msg, true);
  enableDownloads(false);
}
function escapeHtml(s: string) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!)); }

function setOverlay(text: string, error = false) {
  const o = $("overlay");
  o.textContent = text;
  o.className = "overlay" + (error ? " error" : "");
}

// -- downloads --------------------------------------------------------------
function enableDownloads(on: boolean) {
  for (const id of ["dl-stl", "dl-obj", "dl-ball"]) ($(id) as HTMLButtonElement).disabled = !on;
}
function requestDownload(kind: "stl" | "obj" | "ball") {
  worker.postMessage({ type: "export", jobId, kind });
}
function finishDownload(kind: string, buf: ArrayBuffer) {
  // The bundled sample must not download under a name implying it is the user's.
  const base = isDefaultArtwork ? `${svgName}_sample` : svgName;
  const map: Record<string, [string, string]> = {
    stl: [`${base}_stencil.stl`, "model/stl"],
    obj: [`${base}_stencil.obj`, "text/plain"],
    ball: ["ball_reference.stl", "model/stl"],
  };
  const [name, mime] = map[kind];
  const url = URL.createObjectURL(new Blob([buf], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// -- parameter panel --------------------------------------------------------
function fmt(v: number | null): string { return v === null ? "" : String(v); }

function buildPanel() {
  const root = $("params");
  root.innerHTML = "";
  GROUPS.forEach((g, gi) => {
    const expanded = expandedGroups.has(g.name);
    const sec = document.createElement("section");
    sec.className = "group" + (expanded ? "" : " collapsed");
    sec.dataset.group = g.name;
    const bodyId = `g-${gi}`;
    const head = document.createElement("button");
    head.type = "button";
    head.className = "group-head";
    head.setAttribute("aria-expanded", String(expanded));
    head.setAttribute("aria-controls", bodyId);
    head.innerHTML = `<span class="group-name">${g.name}</span><span class="chev" aria-hidden="true"></span>`;
    head.addEventListener("click", () => toggleGroup(g.name, sec, head));
    sec.appendChild(head);

    const body = document.createElement("div");
    body.className = "group-body";
    body.id = bodyId;
    for (const c of g.ctls) {
      const val = params[c.key];
      const field = document.createElement("div");
      if (c.options) {
        field.className = "field";
        const opts = c.options
          .map((o) => `<option value="${o.value}"${o.value === val ? " selected" : ""}>${o.label}</option>`)
          .join("");
        field.innerHTML = `<label for="p-${c.key}">${c.label}</label>
          <select id="p-${c.key}">${opts}</select>
          <div class="help">${c.help}</div>`;
        body.appendChild(field);
        field.querySelector("select")!.addEventListener("change", (e) => {
          (params as unknown as Record<string, unknown>)[c.key] = (e.target as HTMLSelectElement).value;
          persist();
          scheduleBuild();
        });
      } else if (typeof val === "boolean") {
        field.className = "field check";
        field.innerHTML = `<label for="p-${c.key}">${c.label}</label>
          <input type="checkbox" id="p-${c.key}" ${val ? "checked" : ""} />
          <div class="help">${c.help}</div>`;
        body.appendChild(field);
        field.querySelector("input")!.addEventListener("change", (e) => {
          (params as unknown as Record<string, unknown>)[c.key] = (e.target as HTMLInputElement).checked;
          persist();
          scheduleBuild();
        });
      } else {
        field.className = "field";
        const cur = val as number | null;
        field.innerHTML = `<label for="p-${c.key}">${c.label}${c.unit ? ` <span class="unit">(${c.unit})</span>` : ""}</label>
          <input type="number" inputmode="decimal" id="p-${c.key}" value="${fmt(cur)}" ${c.step ? `step="${c.step}"` : ""} placeholder="${c.key === "design_reference_radius" ? "auto" : ""}" />
          <div class="help">${c.help}</div>
          <div class="err" id="e-${c.key}" hidden></div>`;
        body.appendChild(field);
        const input = field.querySelector("input") as HTMLInputElement;
        input.addEventListener("input", () => {
          const raw = input.value.trim();
          let nv: number | null;
          if (raw === "") {
            // only the optional reference radius may be empty (= auto)
            nv = c.key === "design_reference_radius" ? null : NaN;
          } else nv = Number(raw);
          const errEl = $(`e-${c.key}`);
          if (nv !== null && (Number.isNaN(nv) || (c.min !== undefined && nv < c.min))) {
            input.classList.add("invalid");
            errEl.textContent = `must be a number${c.min !== undefined ? ` ≥ ${c.min}` : ""}`;
            errEl.hidden = false;
            return;
          }
          input.classList.remove("invalid");
          errEl.hidden = true;
          (params as unknown as Record<string, unknown>)[c.key] = nv;
          if (c.key === "sphere_diameter_mm") refreshBall();
          persist();
          scheduleBuild();
        });
      }
    }
    sec.appendChild(body);
    root.appendChild(sec);
  });
}

function toggleGroup(name: string, sec: HTMLElement, head: HTMLElement) {
  const open = sec.classList.toggle("collapsed") === false;
  head.setAttribute("aria-expanded", String(open));
  if (open) expandedGroups.add(name); else expandedGroups.delete(name);
  persist();
}

// -- artwork loading --------------------------------------------------------
/**
 * Canonical "new artwork arrived" routine. The file picker, drag/drop, the
 * letter generator, and the first-run default all converge here so persistence,
 * showSvgInfo and build() stay consistent.
 *
 * `isDefault` marks the bundled sample: it is NOT persisted as user data (the
 * SVG blob is cleared so it is re-derived, never resurrected over something the
 * user intentionally cleared), and the info area / download name reflect that it
 * is a sample rather than the user's own artwork.
 */
function loadSvgText(text: string, name: string, opts: { isDefault?: boolean; recenter?: boolean } = {}) {
  svgText = text;
  svgName = name || "stencil";
  isDefaultArtwork = !!opts.isDefault;
  if (!isDefaultArtwork) userArtworkLoaded = true;
  showSvgInfo();
  // Persist real artwork like an upload; never store the placeholder sample.
  saveSvg(isDefaultArtwork ? null : svgText);
  persist();
  // Intentionally do NOT re-arm firstMesh here: swapping artwork keeps the same
  // sphere, so the user's zoom/rotation stays valid and must be preserved. Only
  // the first-ever build (firstMesh initialised true) frames the scene.
  build();
  // Swing the camera to show the new artwork face-on, then resume the turntable.
  // Skipped for the auto-seeded sample (it keeps the designed 3/4 intro view)
  // and for live recolours (same artwork — see recolorCurrentLetter).
  if (opts.recenter !== false) viewer.focusOnArtwork();
  refreshArtworkUi(); // refresh the preview/trace options for the new artwork
}

function loadFile(file: File) {
  lastRasterFile = null; // SVG artwork takes over; don't re-trace a prior raster
  lastLetter = null; // an uploaded SVG is not a generated letter
  const name = file.name.replace(/\.svg$/i, "") || "stencil";
  const reader = new FileReader();
  reader.onload = () => loadSvgText(String(reader.result), name);
  reader.readAsText(file);
}

/**
 * One dispatcher for the single file entry (picker + drag/drop). SVG → the
 * existing text loader; a raster (PNG/JPG/…) → the trace worker; anything else →
 * an inline message. Routes by extension, falling back to the MIME type when the
 * dropped file has no extension.
 */
function selectFile(file: File) {
  setTraceError(null);
  const isSvg = /\.svg$/i.test(file.name) || file.type === "image/svg+xml";
  const isRaster = RASTER_RE.test(file.name) || (!/\.[a-z0-9]+$/i.test(file.name) && file.type.startsWith("image/"));
  // A picked/dropped file is image artwork — switch the dialog to the Image pane.
  // (loadFile clears lastRasterFile; traceFile sets it — so source reflects which.)
  if (isSvg) { loadFile(file); setArtworkSource("image"); }
  else if (isRaster) { traceFile(file); setArtworkSource("image"); }
  else setTraceError(`Unsupported file “${file.name}”. Choose an SVG or an image (PNG, JPG, WebP, BMP, GIF).`);
}

// The trace worker is spawned lazily (only on the first raster) so SVG/letter
// users never download the tracers, mirroring how the pipeline chunk is deferred.
let traceWorker: Worker | null = null;
function ensureTraceWorker(): Worker {
  if (!traceWorker) {
    traceWorker = new Worker(new URL("./trace.worker.ts", import.meta.url), { type: "module" });
    traceWorker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "result") {
        if (m.jobId !== traceJob) return; // stale trace, dropped by job id
        // The name is derived on the main thread (the core never sees a filename);
        // converge on the SAME entry point as the picker/drag/letter so
        // persistence, showSvgInfo, firstMesh and build() all "just work".
        loadSvgText(m.svgText as string, pendingTraceName);
      } else if (m.type === "error") {
        // jobId === -1 is an escaped/global worker error; always surface it.
        if (m.jobId !== -1 && m.jobId !== traceJob) return;
        setTraceError(m.message as string);
        setBadge("fail", "FAIL");
        setOverlay("Trace failed: " + m.message, true);
      }
    };
    traceWorker.onerror = (e) => setTraceError(`trace worker crashed: ${e.message || "unknown error"}`);
  }
  return traceWorker;
}

// Monotonic id so a superseded trace (rapid re-picks / threshold drags) is dropped.
// pendingTraceName carries the latest file's derived name across the round-trip.
let traceJob = 0;
let pendingTraceName = "image";
// The last raster picked, kept so changing the backend/threshold re-traces it
// without a re-pick (cleared implicitly when SVG/letter artwork takes over — its
// own file is never set here, and a stale re-trace would be dropped by job id).
let lastRasterFile: File | null = null;
/** Trace a raster file off-thread, then route the returned SVG through the same
 *  loadSvgText() convergence point the picker, drag/drop and letter generator use. */
function traceFile(file: File) {
  lastRasterFile = file;
  lastLetter = null; // a traced raster is not a generated letter
  pendingTraceName = file.name.replace(RASTER_RE, "") || "image";
  const worker = ensureTraceWorker();
  traceJob += 1;
  setBadge("busy", "tracing…");
  setOverlay("Tracing image…");
  worker.postMessage({
    type: "trace",
    jobId: traceJob,
    file,
    opts: { backend: traceBackend, threshold: traceThreshold },
  });
}

function setTraceError(msg: string | null) {
  const el = $("trace-err");
  if (msg) { el.textContent = msg; el.hidden = false; }
  else { el.textContent = ""; el.hidden = true; }
}

function showSvgInfo() {
  if (!svgText) return;
  const text = svgText;
  import("./pipeline/svg").then(({ parseSvg }) => {
    const p = parseSvg(text);
    const labels = p.paths.filter((x) => !x.hidden).map((x) => x.label);
    const sample = isDefaultArtwork
      ? `<div class="sample-note">Showing a sample — upload or generate a letter to replace it.</div>`
      : "";
    $("svginfo").innerHTML =
      `${sample}<b>${escapeHtml(svgName)}.svg</b> — viewBox ${p.viewBox.map((n) => +n.toFixed(2)).join(" ")}
       <div class="labels">paths: ${labels.map(escapeHtml).join(", ") || "(none)"}</div>`;
  });
}

// -- artwork source toggle (Text vs Image) ----------------------------------
/** Reflect the current source + active file in the Artwork dialog: swap the
 *  Text/Image panes, refresh the image preview, and reveal the trace options
 *  ONLY while a raster is the active artwork (never for an SVG or a letter). */
function refreshArtworkUi() {
  const text = artworkSource === "text";
  ($("artsrc-text") as HTMLInputElement).checked = text;
  ($("artsrc-image") as HTMLInputElement).checked = !text;
  $("art-text").hidden = !text;
  $("art-image").hidden = text;
  // A re-pick is required to re-trace after reload (the raster file isn't
  // persisted), so the options stay hidden until a raster is chosen this session.
  $("trace-gen").hidden = lastRasterFile === null;
  renderImagePreview();
}

/** Thumbnail of the last configured image: the original raster when one is
 *  loaded this session, otherwise the chosen SVG. Hidden for letters / no image. */
function renderImagePreview() {
  const box = $("image-preview");
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  let src: string | null = null;
  if (lastRasterFile) {
    previewUrl = URL.createObjectURL(lastRasterFile);
    src = previewUrl;
  } else if (svgText && lastLetter === null && !isDefaultArtwork) {
    src = "data:image/svg+xml;utf8," + encodeURIComponent(svgText);
  }
  if (src) {
    box.innerHTML = `<img alt="chosen artwork" src="${src}" />`;
    box.hidden = false;
  } else {
    box.innerHTML = "";
    box.hidden = true;
  }
}

/** Switch the dialog's input source (also called when new artwork arrives so
 *  the toggle follows what the user just did) and persist the choice. */
function setArtworkSource(src: ArtworkSource) {
  artworkSource = src;
  refreshArtworkUi();
  persist();
}

// -- letter generator -------------------------------------------------------
/** Generate a stencil from the typed character(s). On failure, show an inline
 *  message and leave the current artwork untouched (no blank build). */
async function generateLetter(raw: string) {
  lastRasterFile = null; // a typed letter takes over; don't re-trace a prior raster
  try {
    const { glyphToSvg } = await import("./glyph");
    const { svgText: text, name } = await glyphToSvg(raw, { fill: letterColor });
    setLetterError(null);
    loadSvgText(text, name);
    lastLetter = raw; // remember it so the colour swatch can recolour it live
    setArtworkSource("text"); // a typed letter is text artwork
  } catch (err) {
    setLetterError(err instanceof Error ? err.message : String(err));
  }
}

/** Re-embed `letterColor` into the currently-shown generated letter so the
 *  colour swatch recolours it live — the same visible effect as the view tab's
 *  paint picker (colour never changes geometry, so this is just a recolour +
 *  repaint). Preserves the sample/real status so recolouring the first-run
 *  sample doesn't silently promote it to persisted user artwork. No-op when the
 *  active artwork isn't a letter (an uploaded SVG / traced raster keeps its own
 *  colour). */
async function recolorCurrentLetter() {
  if (lastLetter === null) return;
  const wasDefault = isDefaultArtwork;
  try {
    const { glyphToSvg } = await import("./glyph");
    const { svgText: text, name } = await glyphToSvg(lastLetter, { fill: letterColor });
    loadSvgText(text, name, { isDefault: wasDefault, recenter: false });
  } catch {
    /* leave the current artwork untouched on a transient load failure */
  }
}

function setLetterError(msg: string | null) {
  const el = $("letter-err");
  if (msg) { el.textContent = msg; el.hidden = false; }
  else { el.textContent = ""; el.hidden = true; }
}

// -- visual viewport (mobile keyboard / iOS toolbar) ------------------------
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  root.style.setProperty("--vvh", `${vv.height}px`);
  // keyboard inset: how much of the layout viewport the on-screen keyboard hides
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  root.style.setProperty("--kb", `${kb}px`);
}

// -- wire up ----------------------------------------------------------------
function init() {
  buildPanel();
  refreshBall(); // first-run: translucent reference ball, sized to diameter

  // letter generator: live (debounced) on input, plus an explicit Generate button
  const letterInput = $("letter") as HTMLInputElement;
  let letterTimer = 0;
  const fireLetter = () => generateLetter(letterInput.value);
  letterInput.addEventListener("input", () => {
    clearTimeout(letterTimer);
    letterTimer = window.setTimeout(fireLetter, 180);
  });
  letterInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); clearTimeout(letterTimer); fireLetter(); }
  });
  $("letter-go").addEventListener("click", () => { clearTimeout(letterTimer); fireLetter(); });

  // single file entry (SVG or raster) + drag/drop (drop anywhere on the page);
  // one dispatcher routes by type.
  $("pick").addEventListener("click", () => ($("file") as HTMLInputElement).click());
  ($("file") as HTMLInputElement).addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) selectFile(f);
  });

  // artwork source toggle (Text vs Image): swaps the two input panes
  ($("artsrc-text") as HTMLInputElement).addEventListener("change", () => setArtworkSource("text"));
  ($("artsrc-image") as HTMLInputElement).addEventListener("change", () => setArtworkSource("image"));
  refreshArtworkUi(); // reflect the restored source + any restored artwork
  const dropHi = (on: boolean) => document.body.classList.toggle("dropping", on);
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dropHi(true); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dropHi(false); }));
  document.addEventListener("drop", (e) => {
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) selectFile(f);
  });

  // raster-trace options: backend radio + threshold (consulted by traceFile).
  // Changing the backend re-traces the current raster (if one is loaded); the
  // threshold re-traces on release (debounced) so the slider stays responsive.
  const bkPotrace = $("tracebk-potrace") as HTMLInputElement;
  const bkColor = $("tracebk-color") as HTMLInputElement;
  const thr = $("trace-threshold") as HTMLInputElement;
  bkPotrace.checked = traceBackend === "potrace";
  bkColor.checked = traceBackend === "color";
  thr.value = String(traceThreshold);
  const onBackend = () => {
    traceBackend = bkColor.checked ? "color" : "potrace";
    persist();
    if (lastRasterFile) traceFile(lastRasterFile);
  };
  bkPotrace.addEventListener("change", onBackend);
  bkColor.addEventListener("change", onBackend);
  let thrTimer = 0;
  thr.addEventListener("input", () => {
    traceThreshold = Math.min(255, Math.max(0, Math.round(Number(thr.value))));
    persist();
    clearTimeout(thrTimer);
    if (lastRasterFile) thrTimer = window.setTimeout(() => traceFile(lastRasterFile!), 200);
  });

  $("reset").addEventListener("click", () => {
    params = { ...UI_DEFAULT_PARAMS };
    buildPanel();
    persist(); // overwrite persisted params with defaults (forget customizations)
    refreshBall();
    scheduleBuild();
  });

  $("dl-stl").addEventListener("click", () => requestDownload("stl"));
  $("dl-obj").addEventListener("click", () => requestDownload("obj"));
  $("dl-ball").addEventListener("click", () => requestDownload("ball"));

  // view toggles (respect reduced-motion for the default spin)
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  viewer.autoRotate = !reduceMotion;
  ($("t-spin") as HTMLInputElement).checked = !reduceMotion;
  ($("t-ball") as HTMLInputElement).addEventListener("change", (e) => { viewer.showBall = (e.target as HTMLInputElement).checked; });
  ($("t-wire") as HTMLInputElement).addEventListener("change", (e) => { viewer.wireframe = (e.target as HTMLInputElement).checked; });
  ($("t-spin") as HTMLInputElement).addEventListener("change", (e) => { viewer.autoRotate = (e.target as HTMLInputElement).checked; });

  // auto-rotate spin axis (configurable like "Project onto")
  const spinSel = $("spin-axis") as HTMLSelectElement;
  spinSel.value = spinAxis;
  spinSel.addEventListener("change", () => {
    spinAxis = spinSel.value as SpinAxis;
    viewer.spinAxis = spinAxis;
    persist();
  });

  // render-mode + projection-target — view-only, never rebuild the mesh.
  // "Project onto" applies to BOTH the on-ball projection and the 3D stencil
  // shell, so it stays enabled in either mode.
  const projSel = $("proj-target") as HTMLSelectElement;
  ($("m-proj") as HTMLInputElement).checked = renderMode === "projection";
  ($("m-stencil") as HTMLInputElement).checked = renderMode === "stencil";
  projSel.value = projectionTarget;
  const onMode = (m: RenderMode) => {
    renderMode = m;
    viewer.renderMode = m;
    refreshViewOverlay();
    persist();
  };
  ($("m-proj") as HTMLInputElement).addEventListener("change", () => onMode("projection"));
  ($("m-stencil") as HTMLInputElement).addEventListener("change", () => onMode("stencil"));
  projSel.addEventListener("change", () => {
    projectionTarget = projSel.value as ProjectionTarget;
    viewer.projectionTarget = projectionTarget;
    viewer.focusOnArtwork(); // swing to the newly-chosen face
    refreshViewOverlay();
    persist();
  });

  // paint colour: a checkbox to override, plus the swatch. Unchecked = follow the
  // design's SVG fill (or the default); the swatch then just shows what's in use.
  const paintChk = $("t-paint") as HTMLInputElement;
  const paintColor = $("paint-color") as HTMLInputElement;
  paintChk.checked = paintOverride !== null;
  paintColor.value = paintOverride ?? resolvedPaint();
  paintColor.disabled = paintOverride === null;
  paintChk.addEventListener("change", () => {
    paintColor.disabled = !paintChk.checked;
    paintOverride = paintChk.checked ? paintColor.value : null;
    if (!paintChk.checked) paintColor.value = resolvedPaint();
    applyPaint();
    persist();
  });
  paintColor.addEventListener("input", () => {
    if (!paintChk.checked) return;
    paintOverride = paintColor.value;
    applyPaint();
    persist();
  });

  // letter generator colour swatch. While a generated letter is shown it
  // recolours it live, exactly like the view tab's paint picker: `input` fires
  // continuously as you drag, so we only repaint (cheap, no rebuild — colour
  // never changes geometry); `change` fires once on commit, when we re-embed the
  // colour into the letter's SVG so it survives reload and downloads carry it.
  // When the artwork isn't a letter the swatch only sets the next letter's
  // colour (an uploaded SVG / traced raster keeps its own).
  const letterColorInput = $("letter-color") as HTMLInputElement;
  letterColorInput.value = letterColor;
  letterColorInput.addEventListener("input", () => {
    letterColor = letterColorInput.value;
    persist();
    if (lastLetter !== null) {
      lastSvgColor = letterColor; // the live letter's design colour
      applyPaint(); // repaint the projection now, mirroring onResult
      if (!paintOverride) paintColor.value = resolvedPaint();
    }
  });
  letterColorInput.addEventListener("change", () => { void recolorCurrentLetter(); });

  // persist which panel is open — both to localStorage and the URL hash
  sheets.onChange((name) => { persist(); syncUrl(name); });

  // mobile keyboard / toolbar handling
  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);
  syncViewport();

  setBadge("busy", "—");

  // restore prior session, or seed a fresh launch with the bundled sample letter
  if (svgText !== null) {
    showSvgInfo();
    setOverlay("Restoring your last stencil…");
    build();
  } else {
    // First-run void: build the default letter through the same generator path
    // so a brand-new visitor immediately sees a finished stencil. Re-derived on
    // every empty launch; never persisted (see loadSvgText `isDefault`).
    setOverlay("Building a sample stencil…");
    import("./glyph").then(async ({ glyphToSvg, DEFAULT_LETTER }) => {
      try {
        const { svgText: text, name } = await glyphToSvg(DEFAULT_LETTER, { fill: letterColor });
        if (userArtworkLoaded) return; // user supplied artwork while we loaded
        loadSvgText(text, name, { isDefault: true, recenter: false });
        lastLetter = DEFAULT_LETTER; // the sample is a letter too — recolourable
      } catch (err) {
        if (userArtworkLoaded) return;
        setOverlay(err instanceof Error ? err.message : "Load an SVG to build a stencil.", true);
      }
    });
  }
  // Restore the open panel: the URL hash wins (shareable / survives autoreload),
  // falling back to the last panel saved in localStorage. Keep the URL in sync.
  const hashPanel = location.hash.replace(/^#/, "");
  const initialPanel = (PANELS as readonly string[]).includes(hashPanel)
    ? hashPanel
    : restored?.openPanel ?? null;
  if (initialPanel) sheets.open(initialPanel, { silent: true });
  syncUrl(initialPanel);

  initPwa();
}

init();
