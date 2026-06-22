/**
 * Main thread: UI only. Parameter editing/validation, posting parameters to the
 * geometry worker, rendering the returned transferable mesh, local persistence,
 * the translucent first-run reference ball, and the PWA shell. No geometry
 * compute here (that all lives in the worker) beyond the cheap reference-ball
 * UV sphere for the translucent preview.
 */
import { DEFAULT_PARAMS, Params, validateParams, ballRadius } from "./pipeline/config";
import { uvSphere } from "./pipeline/exportmesh";
import { Viewer } from "./viewer";
import { Sheets } from "./ui/sheet";
import { loadState, saveMeta, saveSvg } from "./persist";
import { initPwa } from "./pwa";
import type { MeshReport } from "./pipeline/meshcheck";
import type { BuildInfo } from "./worker";

// -- parameter schema (every parameter is user-configurable) ----------------
interface Ctl { key: keyof Params; label: string; unit?: string; step?: number; min?: number; help: string; }
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
    { key: "target_edge_mm", label: "Target edge", unit: "mm", step: 0.1, min: 0.001, help: "Target triangle edge; smaller = denser mesh." },
    { key: "chord_error_mm", label: "Chord error", unit: "mm", step: 0.01, min: 0.001, help: "Max curve-flattening deviation." },
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
let params: Params = restored ? { ...restored.params } : { ...DEFAULT_PARAMS };
let svgText: string | null = restored?.svgText ?? null;
let svgName = restored?.svgName ?? "stencil";
let expandedGroups = new Set<string>(restored?.expandedGroups ?? []);
let jobId = 0;

const viewer = new Viewer($("gl") as HTMLCanvasElement);
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const sheets = new Sheets();

// -- persistence ------------------------------------------------------------
function persist() {
  saveMeta({
    params,
    svgName,
    openPanel: sheets.current(),
    expandedGroups: [...expandedGroups],
  });
}

// -- worker messaging -------------------------------------------------------
worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "result") {
    if (m.jobId !== jobId) return; // stale
    onResult(m.report as MeshReport, m.ok as boolean, m.info as BuildInfo,
      new Float32Array(m.positions), new Uint32Array(m.indices), m.ballRadius as number);
  } else if (m.type === "error") {
    if (m.jobId !== jobId) return;
    showError(m.message as string);
  } else if (m.type === "export") {
    finishDownload(m.kind as string, m.buffer as ArrayBuffer);
  } else if (m.type === "exportError") {
    setOverlay("Export failed: " + m.message, true);
  }
};

/** Refresh the translucent reference ball to the current sphere diameter. */
function refreshBall() {
  const { vertices, faces } = uvSphere(ballRadius(params), 96, 48);
  viewer.setBall(Float32Array.from(vertices), Uint32Array.from(faces));
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
function onResult(report: MeshReport, ok: boolean, info: BuildInfo, pos: Float32Array, idx: Uint32Array, _ballR: number) {
  viewer.setShell(pos, idx, info.outerRadius);
  if (firstMesh) { viewer.fit(); firstMesh = false; }
  renderReport(report, ok, info);
  setOverlay(`${report.nFaces.toLocaleString()} triangles · holes ${info.nCutRegions} · R_ref ${info.rRef.toFixed(1)} svg`);
  enableDownloads(true);
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
  const map: Record<string, [string, string]> = {
    stl: [`${svgName}_stencil.stl`, "model/stl"],
    obj: [`${svgName}_stencil.obj`, "text/plain"],
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
      if (typeof val === "boolean") {
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

// -- file loading -----------------------------------------------------------
function loadFile(file: File) {
  svgName = file.name.replace(/\.svg$/i, "") || "stencil";
  const reader = new FileReader();
  reader.onload = () => {
    svgText = String(reader.result);
    showSvgInfo();
    saveSvg(svgText);
    persist();
    firstMesh = true;
    build();
  };
  reader.readAsText(file);
}

function showSvgInfo() {
  if (!svgText) return;
  import("./pipeline/svg").then(({ parseSvg }) => {
    const p = parseSvg(svgText!);
    const labels = p.paths.filter((x) => !x.hidden).map((x) => x.label);
    $("svginfo").innerHTML =
      `<b>${escapeHtml(svgName)}.svg</b> — viewBox ${p.viewBox.map((n) => +n.toFixed(2)).join(" ")}
       <div class="labels">paths: ${labels.map(escapeHtml).join(", ") || "(none)"}</div>`;
  });
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

  // file picker + drag/drop (drop anywhere on the page)
  $("pick").addEventListener("click", () => ($("file") as HTMLInputElement).click());
  ($("file") as HTMLInputElement).addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadFile(f);
  });
  const dropHi = (on: boolean) => document.body.classList.toggle("dropping", on);
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dropHi(true); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dropHi(false); }));
  document.addEventListener("drop", (e) => {
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f && /\.svg$/i.test(f.name)) loadFile(f);
  });

  $("reset").addEventListener("click", () => {
    params = { ...DEFAULT_PARAMS };
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

  // persist which panel is open
  sheets.onChange(() => persist());

  // mobile keyboard / toolbar handling
  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);
  syncViewport();

  setBadge("busy", "—");

  // restore prior session
  if (svgText !== null) {
    showSvgInfo();
    setOverlay("Restoring your last stencil…");
    build();
  } else {
    setOverlay("Load an SVG to build a stencil.");
  }
  if (restored?.openPanel) sheets.open(restored.openPanel, { silent: true });

  initPwa();
}

init();
