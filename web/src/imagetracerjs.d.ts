/**
 * Minimal ambient declaration for imagetracerjs (ships no types). Only the
 * surface trace.ts uses is declared (mirrors opentype.js.d.ts's discipline).
 */
declare module "imagetracerjs" {
  interface ImageTracer {
    /** Trace an ImageData to an SVG string. `options` is the documented bag
     *  (numberofcolors, pathomit, ltres, qtres, …). */
    imagedataToSVG(imageData: ImageData, options?: Record<string, unknown>): string;
  }
  const ImageTracer: ImageTracer;
  export default ImageTracer;
}
