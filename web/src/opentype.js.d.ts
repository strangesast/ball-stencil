/**
 * Minimal ambient declaration for opentype.js (the package ships no types).
 * Only the surface glyph.ts uses is declared.
 */
declare module "opentype.js" {
  export interface BoundingBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }
  export interface Path {
    /** Serialize to SVG path `d` data (absolute coords, optional precision). */
    toPathData(decimalPlaces?: number): string;
    getBoundingBox(): BoundingBox;
  }
  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    /** Filled outline of `text`, baseline at (x, y), em-scaled to `fontSize`. */
    getPath(
      text: string,
      x: number,
      y: number,
      fontSize: number,
      options?: { kerning?: boolean; features?: unknown; hinting?: boolean },
    ): Path;
  }
  export function parse(buffer: ArrayBuffer): Font;
  const _default: { parse: typeof parse };
  export default _default;
}
