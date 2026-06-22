/**
 * Main thread: UI only. Parameter editing/validation, posting parameters to the
 * geometry worker, and rendering the returned transferable mesh. No geometry
 * compute here (that all lives in the worker) beyond the cheap reference-ball
 * UV sphere for the translucent preview.
 */
import { DEFAULT_PARAMS, Params, validateParams, ballRadius } from "./pipeline/config";
import { uvSphere } from "./pipeline/exportmesh";
import { Viewer } from "./viewer";
import type { MeshReport } from "./pipeline/meshcheck";
import type { BuildInfo } from "./worker";

// -- parameter schema (every parameter is user-configurable) ----------------
interface Ctl { key: keyof Params; label: string; unit?: string; step?: number; min?: number; }
interface Grp { name: string; ctls: Ctl[]; }
const GROUPS: Grp[] = [
  { name: "Ball / shell", ctls: [
    { key: "sphere_diameter_mm", label: "Sphere diameter", unit: "mm", step: 1, min: 0.001 },
    { key: "fit_clearance_mm", label: "Fit clearance", unit: "mm", step: 0.1, min: 0 },
    { key: "wall_thickness_mm", label: "Wall thickness", unit: "mm", step: 0.1, min: 0.001 },
    { key: "cap_angle_deg", label: "Cap angle", unit: "deg", step: 1, min: 0.001 },
  ]},
  { name: "Design placement", ctls: [
    { key: "design_margin", label: "Design margin", unit: "×", step: 0.01, min: 0.001 },
    { key: "design_reference_radius", label: "Reference radius", unit: "svg" },
    { key: "flip_v", label: "Flip V (un-mirror)" },
  ]},
  { name: "Tessellation / meshing", ctls: [
    { key: "target_edge_mm", label: "Target edge", unit: "mm", step: 0.1, min: 0.001 },
    { key: "chord_error_mm", label: "Chord error", unit: "mm", step: 0.01, min: 0.001 },
    { key: "min_segment_mm", label: "Min segment", unit: "mm", step: 0.01, min: 0 },
  ]},
  { name: "Cleanup", ctls: [
    { key: "cut_separation_svg", label: "Cut separation", unit: "svg", step: 0.05, min: 0 },
    { key: "snap_grid_svg", label: "Snap grid", unit: "svg", step: 0.01, min: 0 },
    { key: "min_island_area_mm2", label: "Min island area", unit: "mm²", step: 0.5, min: 0 },
    { key: "radius_tolerance_mm", label: "Radius tolerance", unit: "mm", step: 0.001, min: 0 },
  ]},
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let params: Params = { ...DEFAULT_PARAMS };
let svgText: string | null = null;
let svgName = "stencil";
let jobId = 0;
let lastReportOk = false;

const viewer = new Viewer($("gl") as HTMLCanvasElement);
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

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
  // refresh the translucent reference ball to match diameter
  const { vertices, faces } = uvSphere(ballRadius(params), 96, 48);
  viewer.setBall(Float32Array.from(vertices), Uint32Array.from(faces));
}

let debounceTimer = 0;
function scheduleBuild() {
  clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(build, 180);
}

let firstMesh = true;
function onResult(report: MeshReport, ok: boolean, info: BuildInfo, pos: Float32Array, idx: Uint32Array, _ballR: number) {
  lastReportOk = ok;
  viewer.setShell(pos, idx, info.outerRadius);
  if (firstMesh) { viewer.fit(); firstMesh = false; }
  renderReport(report, ok, info);
  setOverlay(`${report.nFaces.toLocaleString()} triangles · holes ${info.nCutRegions} · R_ref ${info.rRef.toFixed(1)} svg`);
  enableDownloads(true);
}

// -- report rendering -------------------------------------------------------
function setBadge(kind: "pass" | "fail" | "busy", text: string) {
  const b = $("badge");
  b.className = "badge " + kind;
  b.textContent = text;
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
  if (nComp > 1) {
    const frees = info.islands.slice(1).map((a) => a.toFixed(1)).join(", ");
    html += `<br/>⚠ ${nComp - 1} free island(s) — would fall out of a physical stencil (areas mm²: ${frees})`;
  }
  html += "</div>";
  $("report-body").innerHTML = html;
}

function showError(msg: string) {
  setBadge("fail", "FAIL");
  $("report-body").innerHTML = `<div class="warn no">⚠ ${escapeHtml(msg)}</div>`;
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
  for (const g of GROUPS) {
    const gd = document.createElement("div");
    gd.className = "group";
    gd.innerHTML = `<div class="glabel">${g.name}</div>`;
    for (const c of g.ctls) {
      const val = params[c.key];
      const field = document.createElement("div");
      if (typeof val === "boolean") {
        field.className = "field check";
        field.innerHTML = `<label for="p-${c.key}">${c.label}</label>
          <input type="checkbox" id="p-${c.key}" ${val ? "checked" : ""} />`;
        gd.appendChild(field);
        field.querySelector("input")!.addEventListener("change", (e) => {
          (params as any)[c.key] = (e.target as HTMLInputElement).checked;
          scheduleBuild();
        });
      } else {
        field.className = "field";
        const cur = val as number | null;
        field.innerHTML = `<label for="p-${c.key}">${c.label}${c.unit ? ` <span class="unit">(${c.unit})</span>` : ""}</label>
          <input type="number" id="p-${c.key}" value="${fmt(cur)}" ${c.step ? `step="${c.step}"` : ""} placeholder="${c.key === "design_reference_radius" ? "auto" : ""}" />
          <div class="err" id="e-${c.key}" hidden></div>`;
        gd.appendChild(field);
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
          (params as any)[c.key] = nv;
          scheduleBuild();
        });
      }
    }
    root.appendChild(gd);
  }
}

// -- file loading -----------------------------------------------------------
function loadFile(file: File) {
  svgName = file.name.replace(/\.svg$/i, "") || "stencil";
  const reader = new FileReader();
  reader.onload = () => {
    svgText = String(reader.result);
    showSvgInfo();
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

// -- wire up ----------------------------------------------------------------
function init() {
  buildPanel();
  $("pick").addEventListener("click", () => ($("file") as HTMLInputElement).click());
  ($("file") as HTMLInputElement).addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadFile(f);
  });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => {
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });
  $("reset").addEventListener("click", () => { params = { ...DEFAULT_PARAMS }; buildPanel(); scheduleBuild(); });

  $("dl-stl").addEventListener("click", () => requestDownload("stl"));
  $("dl-obj").addEventListener("click", () => requestDownload("obj"));
  $("dl-ball").addEventListener("click", () => requestDownload("ball"));

  ($("t-ball") as HTMLInputElement).addEventListener("change", (e) => { viewer.showBall = (e.target as HTMLInputElement).checked; });
  ($("t-wire") as HTMLInputElement).addEventListener("change", (e) => { viewer.wireframe = (e.target as HTMLInputElement).checked; });
  ($("t-spin") as HTMLInputElement).addEventListener("change", (e) => { viewer.autoRotate = (e.target as HTMLInputElement).checked; });

  setBadge("busy", "—");
  void lastReportOk; // referenced for potential external checks
}

init();
