/**
 * Local persistence (resume-where-you-left-off). Stores the last loaded SVG
 * (text + name), all parameter values, and panel/group open state in
 * localStorage. Everything here is LOCAL ONLY — nothing persisted triggers a
 * network call. Reads are defensive: a corrupt, oversized, or partial value
 * falls back to defaults + the first-run reference-ball state.
 *
 * Two keys: small metadata (params/panel/groups) is written synchronously on
 * every change so a reload always reflects the latest state; the large SVG blob
 * lives under its own key and is rewritten only when the SVG actually changes,
 * so we never re-serialize ~140 kB on each keystroke.
 */
import { DEFAULT_PARAMS, Params } from "./pipeline/config";
import { DEFAULT_PAINT_HEX } from "./color";

/** A persisted colour value must be a #rrggbb string we wrote ourselves. */
function isHex(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

const META_KEY = "ball-stencil:state:v1";
const SVG_KEY = "ball-stencil:svg:v1";
// The SVG can be ~140 kB; cap what we accept back to guard against a corrupt or
// maliciously-huge stored blob.
const MAX_SVG_CHARS = 2_000_000;

export type RenderMode = "projection" | "stencil";
export type ProjectionTarget = "top" | "front" | "back";
export type SpinAxis = "z" | "x" | "y";
export type TraceBackend = "potrace" | "color";
/** Which artwork input the dialog shows: a typed letter or an image file. */
export type ArtworkSource = "text" | "image";

export interface PersistMeta {
  params: Params;
  svgName: string;
  openPanel: string | null;
  expandedGroups: string[];
  renderMode: RenderMode;
  projectionTarget: ProjectionTarget;
  /** World axis the auto-rotate turntable spins about. */
  spinAxis: SpinAxis;
  /** Explicit paint-colour override (#rrggbb), or null to follow the SVG/default. */
  paintOverride: string | null;
  /** Last colour chosen in the letter generator (#rrggbb). */
  letterColor: string;
  /** Raster-trace backend toggle. */
  traceBackend: TraceBackend;
  /** Raster-trace bilevel threshold (0–255). */
  traceThreshold: number;
  /** Which artwork input the dialog shows (a typed letter vs an image file). */
  artworkSource: ArtworkSource;
}
export interface RestoredState extends PersistMeta {
  svgText: string | null;
}

function sanitizeParams(p: unknown): Params {
  const out: Params = { ...DEFAULT_PARAMS };
  if (p && typeof p === "object") {
    const src = p as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_PARAMS) as (keyof Params)[]) {
      const v = src[k];
      const d = DEFAULT_PARAMS[k];
      if (typeof d === "number" && typeof v === "number" && Number.isFinite(v)) {
        (out as unknown as Record<string, unknown>)[k] = v;
      } else if (typeof d === "boolean" && typeof v === "boolean") {
        (out as unknown as Record<string, unknown>)[k] = v;
      } else if (k === "design_reference_radius" && v === null) {
        out.design_reference_radius = null;
      } else if (k === "mapping" && typeof v === "string") {
        out.mapping = v;
      } else if (k === "mesh_strategy" && (v === "constrained" || v === "centroid")) {
        out.mesh_strategy = v;
      }
    }
  }
  return out;
}

export function loadState(): RestoredState | null {
  let raw: string | null = null;
  let svg: string | null = null;
  try {
    raw = localStorage.getItem(META_KEY);
    svg = localStorage.getItem(SVG_KEY);
  } catch {
    return null; // storage unavailable (private mode etc.)
  }
  if (raw === null && svg === null) return null;
  let meta: PersistMeta;
  try {
    const o = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return null;
    meta = {
      params: sanitizeParams(o.params),
      svgName: typeof o.svgName === "string" ? o.svgName : "stencil",
      openPanel: typeof o.openPanel === "string" ? o.openPanel : null,
      expandedGroups: Array.isArray(o.expandedGroups)
        ? o.expandedGroups.filter((x): x is string => typeof x === "string")
        : [],
      // Default first view is the on-ball projection (Top); a returning user's
      // persisted choice overrides it.
      renderMode: o.renderMode === "stencil" ? "stencil" : "projection",
      projectionTarget:
        o.projectionTarget === "front" || o.projectionTarget === "back"
          ? o.projectionTarget
          : "top",
      spinAxis: o.spinAxis === "x" || o.spinAxis === "y" ? o.spinAxis : "z",
      paintOverride: isHex(o.paintOverride) ? (o.paintOverride as string) : null,
      letterColor: isHex(o.letterColor) ? (o.letterColor as string) : DEFAULT_PAINT_HEX,
      traceBackend: o.traceBackend === "color" ? "color" : "potrace",
      traceThreshold:
        typeof o.traceThreshold === "number" && Number.isFinite(o.traceThreshold)
          ? Math.min(255, Math.max(0, Math.round(o.traceThreshold)))
          : 128,
      artworkSource: o.artworkSource === "image" ? "image" : "text",
    };
  } catch {
    return null; // corrupt JSON → defaults
  }
  const svgText = typeof svg === "string" && svg.length <= MAX_SVG_CHARS ? svg : null;
  return { ...meta, svgText };
}

/** Synchronous, cheap: params + panel/group state. */
export function saveMeta(meta: PersistMeta) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* quota / unavailable — non-fatal */
  }
}

/** Only called when the loaded SVG changes (or is cleared). */
export function saveSvg(text: string | null) {
  try {
    if (text === null) localStorage.removeItem(SVG_KEY);
    else localStorage.setItem(SVG_KEY, text);
  } catch {
    // Quota: the SVG is too big to store. Drop it so meta still persists; the
    // app falls back to the reference-ball state for that blob on next launch.
    try { localStorage.removeItem(SVG_KEY); } catch { /* ignore */ }
  }
}

export function clearState() {
  try {
    localStorage.removeItem(META_KEY);
    localStorage.removeItem(SVG_KEY);
  } catch {
    /* ignore */
  }
}
