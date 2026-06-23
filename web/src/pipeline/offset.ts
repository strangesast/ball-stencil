/**
 * Robust polygon offset via Clipper 1 (js-angusj-clipper).
 *
 * clipper2-js's ClipperOffset produces spiral "curl" artifacts when dilating the
 * overlapping artwork blobs (a smooth 53-ring region becomes 1333 sharp turns),
 * which the constrained mesher then traces as a sawtooth cut edge. The original,
 * battle-tested Clipper (Angus Johnson, v1) offsets the same geometry cleanly
 * (0 sharp turns), matching Shapely/GEOS on the Python side.
 *
 * The native lib loads asynchronously (inlined WASM, asm.js fallback); after
 * that every offset call is synchronous, so the rest of the pipeline stays sync.
 * Load it once via loadOffsetLib() (the worker / tests do this on startup).
 */
import {
  loadNativeClipperLibInstanceAsync,
  NativeClipperLibRequestedFormat,
  JoinType,
  EndType,
  type ClipperLibWrapper,
} from "js-angusj-clipper";

export type IntPt = { x: number; y: number };

let lib: ClipperLibWrapper | null = null;
let loading: Promise<void> | null = null;

/** Load the Clipper 1 instance once (idempotent, safe to call concurrently). */
export async function loadOffsetLib(): Promise<void> {
  if (lib) return;
  if (!loading) {
    loading = loadNativeClipperLibInstanceAsync(
      NativeClipperLibRequestedFormat.WasmWithAsmJsFallback,
    ).then((instance) => {
      lib = instance;
    });
  }
  await loading;
}

export function offsetLibReady(): boolean {
  return lib !== null;
}

/**
 * Round-join polygon offset of integer paths. Returns null if the lib has not
 * loaded yet (the caller then falls back to clipper2's offset). `delta` and
 * `arcTolerance` are in the same integer units as the input points.
 */
export function offsetInt(paths: IntPt[][], delta: number, arcTolerance: number): IntPt[][] | null {
  if (!lib) return null;
  const out = lib.offsetToPaths({
    delta,
    arcTolerance,
    offsetInputs: [{ data: paths, joinType: JoinType.Round, endType: EndType.ClosedPolygon }],
  });
  return out ?? [];
}
