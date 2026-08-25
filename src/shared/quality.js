/**
 * One place that decides how expensive this is allowed to be.
 *
 * Every number here was a constant somewhere else first. Collecting them means
 * the mobile path is a table you can read in one go rather than a `matchMedia`
 * repeated in five files that quietly drift apart - and it makes the shape of
 * the cost obvious: almost all of it is either fragments (pixel ratio, MSAA,
 * shadow blur) or primitives drawn once at load (the sheets).
 *
 * The breakpoint is the same 64rem the layout and `selectPanes()` use. Mobile
 * already builds a single pane; this is about making that one pane cheap.
 */
export const IS_MOBILE =
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 64rem)").matches;

export const QUALITY = {
  // --- Fragments ---
  //
  // The single biggest lever, because cost scales with the SQUARE of this. A
  // phone reporting devicePixelRatio 3 was being clamped to 2, i.e. four times
  // the fragments of the CSS pixel grid, for shaders doing six texture fetches
  // and a twelve-tap edge detector. 1.25 is about 2.6x cheaper than 2 and the
  // drawing survives it, because the look is deliberately rough to begin with.
  pixelRatio: IS_MOBILE ? 1.25 : 2,

  // MSAA is pure bandwidth, and bandwidth is what a mobile GPU has least of.
  // Hatching and a boiling outline hide the aliasing better than most content
  // would - this is the cheapest quality to give up here.
  antialias: !IS_MOBILE,

  // --- Shadows ---
  //
  // VSM blurs the map in a separate pass at 2 x blurSamples taps per texel, so
  // the cost is (mapSize^2 x blurSamples) and both terms are worth halving:
  // 512 at 24 samples is ~12.6M taps, 256 at 8 is ~1M.
  //
  // The penumbra is preserved rather than sacrificed. Radius is in TEXELS, so
  // its world size is radius x frustum / mapSize - halving the map doubles what
  // a texel is worth, and 8 texels at 256 covers almost exactly the same ground
  // as 18 at 512. Same softness, a twelfth of the work.
  shadowMapSize: IS_MOBILE ? 256 : 512,
  shadowRadius: IS_MOBILE ? 8 : 18,
  shadowBlurSamples: IS_MOBILE ? 8 : 24,

  // --- Generated sheets ---
  //
  // Half resolution on mobile: quarters the memory and the rasterising cost,
  // and costs nothing visually because stroke lengths are fractions of the sheet
  // and widths scale with it.
  sheetSize: IS_MOBILE ? 512 : 1024,

  // Stroke COUNT stays at full, and the reason is worth recording because the
  // alternative looked reasonable and was not.
  //
  // Halving the count and doubling the width keeps coverage - (count x length x
  // width) / area - and therefore keeps the TONE. But it does not keep the LOOK:
  // half as many strokes at twice the width is a visibly coarser sheet, and in
  // methods C and D the marks are screen-space, so that coarse pattern runs
  // continuously across the ground and the objects and reads as a single layer
  // sitting in front of the scene.
  //
  // It was also solving the wrong problem. The load time was `darken`
  // compositing, not the path count - see markSheets.js. With that gone there is
  // nothing here worth trading appearance for.
  sheetDensity: 1,

  // Paper is a subtle multiply that nobody looks at directly; fewer fibres reads
  // as slightly smoother stock and saves 18,000 paths at load.
  paperStrokes: IS_MOBILE ? 8000 : 26000,

  // --- Method D's CPU solve ---
  //
  // The contour solve is JavaScript on the main thread, so on a phone it
  // competes with the frame it is feeding.
  //
  // Dropping the rate is only safe because the strokes are written in each
  // mesh's LOCAL space and parented to it - see the note by `strokeSets` in
  // objectSpace/index.js. Without that, 12Hz leaves the outline a stale
  // world-space shell that the object rotates out of, 2.9 degrees at a time, and
  // the parts that end up inside the new surface get culled by the depth buffer
  // and pop back on the next solve. That reads as heavy jitter, and only on the
  // objects that spin.
  //
  // Parented, what is left is a silhouette whose SHAPE is a few degrees old,
  // which is a far subtler error than one sliding around on top of the model.
  solveHz: IS_MOBILE ? 12 : 0,
  // Coarser resampling means fewer points to chain, smooth and threshold. The
  // strokes are a couple of pixels wide on a phone - the extra precision was
  // never visible there.
  maxSegment: IS_MOBILE ? 0.07 : 0.035,
};
