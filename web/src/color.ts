/**
 * Tiny, DOM-free colour helpers shared by the worker (SVG fill extraction), the
 * glyph generator (embedded letter fill) and the viewer (GL uniform). Kept
 * dependency-free so it runs in the Web Worker, Node tests, and the main thread.
 */

/** Fallback paint colour when the artwork specifies none and the user has set no
 *  override. A strong ink tone, distinct from the grey shell and ball albedo. */
export const DEFAULT_PAINT_HEX = "#d92a2e";

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000",
  lime: "#00ff00", blue: "#0000ff", yellow: "#ffff00", cyan: "#00ffff",
  magenta: "#ff00ff", gray: "#808080", grey: "#808080", orange: "#ffa500",
  purple: "#800080", navy: "#000080", teal: "#008080", maroon: "#800000",
};

/**
 * Normalise an SVG-ish colour string to `#rrggbb`, or null if it is empty,
 * `none`, `currentColor`, transparent, or otherwise unrecognised (caller then
 * falls back to the configured default). Alpha is dropped.
 */
export function normalizeColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s || s === "none" || s === "transparent" || s === "currentcolor") return null;
  if (NAMED[s]) return NAMED[s];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
    else h = h.slice(0, 6);
    return "#" + h;
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
  if (rgb) {
    const to = (v: string) => {
      const n = Math.round(Math.max(0, Math.min(255, parseFloat(v))));
      return n.toString(16).padStart(2, "0");
    };
    return "#" + to(rgb[1]) + to(rgb[2]) + to(rgb[3]);
  }
  return null;
}

/** `#rrggbb` (or any normalisable colour) → linear-ish [r,g,b] in [0,1] for GL. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeColor(hex) ?? DEFAULT_PAINT_HEX;
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
