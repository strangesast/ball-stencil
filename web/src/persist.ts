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

const META_KEY = "ball-stencil:state:v1";
const SVG_KEY = "ball-stencil:svg:v1";
// The SVG can be ~140 kB; cap what we accept back to guard against a corrupt or
// maliciously-huge stored blob.
const MAX_SVG_CHARS = 2_000_000;

export interface PersistMeta {
  params: Params;
  svgName: string;
  openPanel: string | null;
  expandedGroups: string[];
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
