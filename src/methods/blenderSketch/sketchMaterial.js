import * as THREE from "three/webgpu";
import {
  screenUV,
  screenSize,
  vec2,
  vec3,
  vec4,
  float,
  uniform,
  time,
  texture,
  dot,
  mix,
  select,
  smoothstep,
  output,
  mx_noise_float,
  color as tslColor,
} from "three/tsl";
import { getMarkSheets, MARK_STYLES } from "../../textures/markSheets.js";

/**
 * METHOD C - the Blender "Sketch Shader" approach, ported.
 *
 * This is a port of the node group in `sketch shader v1.0.blend`, and it differs
 * from methods A and B on the three axes that actually matter:
 *
 *  1. THE COORDINATE IS THE SCREEN, not the mesh's UVs.
 *     Blender feeds `Texture Coordinate > Window` through an aspect-ratio fix
 *     into the sampler. So the marks live on the PAGE: they never inherit a bad
 *     unwrap, never stretch on a torus knot, and never need a per-object scale
 *     fudge the way the ground plane does in A and B. What you give up is any
 *     sense that the strokes belong to the surface - spin an object and the ink
 *     stays put, which is right for a drawing and wrong for a texture.
 *
 *  2. TONE COMES FROM THE REAL LIGHTING.
 *     Blender's `Shader to RGB` takes the finished EEVEE shading and hands it
 *     back as a colour. `output` inside `outputNode` is exactly that node: the
 *     lit pixel, after every light, the ambient, and the shadow term. A and B
 *     both refuse this on purpose and shade off a hand-authored light-direction
 *     uniform instead, which is art-directable but has to be told about every
 *     light by hand. C gets bounce, falloff and cast shadows for free and gives
 *     up that control - which is why C needs no `drawnShadow` path at all:
 *     a cast shadow lowers the luminance, the tone drops, and marks appear.
 *
 *  3. THE SHEET IS A THRESHOLD MAP, not a set of fixed densities.
 *     See markSheets.js. Tone selects how many strokes are shown rather than
 *     crossfading between pre-baked drawings, so the response is continuous and
 *     one greyscale channel covers the whole ramp. That is what lets C carry six
 *     different mark STYLES where B carries three densities of one.
 *
 * The banding (`Bands Sharpness` in the Blender group) is what keeps it reading
 * as drawn rather than rendered: quantising tone before the threshold means
 * strokes arrive in discrete sets, the way a hand commits to a shading pass,
 * instead of fading in individually.
 */

/** Shared across every material in the pane, so one GUI drives the scene. */
export const sketchUniforms = {
  // --- The sheet, in screen space ---
  // Tiles across the screen HEIGHT. Because the coordinate is aspect-corrected,
  // this is a real mark size and not a per-object fudge factor.
  markScale: uniform(19.0),
  // Which of the six sheets in markSheets.js. Held as a float so the GUI can
  // drive it without recompiling the graph - see the note by `pickStyle`.
  style: uniform(2), // "lines"
  // Softness of the threshold test.
  //
  // At 0 a stroke is either fully in or fully out, which aliases badly and reads
  // as a stencil. Pushed up, the threshold instead FADES each stroke in across a
  // band of ranks, so strokes arrive by getting darker rather than by appearing -
  // much closer to a pencil laid down with increasing pressure. At this setting
  // it is doing most of the tonal work, which is why `bands` can sit as low as 2.
  markSoftness: uniform(0.3),
  inkStrength: uniform(1.0),

  // --- Tone (Blender's Map Range on Brightness, then Bands Sharpness) ---
  // Where the lit result is taken as fully dark and fully lit. These exist
  // because `output` is real radiance and can sit well above 1 - an ambient of
  // 1.6 plus a key of 2.2 does not land in 0..1 on its own.
  toneBlack: uniform(0.0),
  toneWhite: uniform(1.07),
  // Two bands, not four: paper and ink. With `markSoftness` this high the
  // gradation inside a band already carries the tone, so extra bands only add
  // steps you cannot see. Raise it if you turn the softness back down.
  bands: uniform(2.0),
  // 1 = hard posterised steps, 0 = a smooth ramp with no banding at all.
  bandSharpness: uniform(0.62),
  // How much the paper itself darkens under tone, on top of the marks. Small on
  // purpose: in this style the STROKES are meant to carry the shading.
  shadeAmount: uniform(0.18),

  // --- Texture Flicker ---
  flickerSpeed: uniform(6.0), // stop-motion steps per second
  flickerAmount: uniform(0.02), // offset magnitude, in sheet units
  // How many steps the walk takes before it turns round. The Blender group runs
  // its clock through PINGPONG, so the sheet bounces between a finite set of
  // poses rather than drifting away forever - a redrawn frame revisits the same
  // hand positions, it does not wander off.
  flickerCycle: uniform(7.0),

  inkColor: uniform(tslColor(0x1a1410)), // dark brown ink, never pure black
};

/**
 * Six samples, one index. Blender does this with a chain of `Greater Than` into
 * `Mix` factors; this is the same multiplexer written as nested `select`.
 *
 * Every branch is evaluated - that is how a GPU works, and how the Blender node
 * tree behaves too - so all six channels cost a fetch whichever one is chosen.
 * Packing them into two RGB textures is what keeps that at two fetches instead
 * of six. If you only ever needed one style, sample one channel and delete this.
 */
function pickStyle(index, values) {
  let node = values[values.length - 1];
  for (let i = values.length - 2; i >= 0; i--) {
    node = select(index.lessThan(i + 0.5), values[i], node);
  }
  return node;
}

/**
 * Build a sketch-shaded MeshStandardNodeMaterial.
 *
 * @param {object} opts
 * @param {THREE.Color|number} [opts.color]  paper tint for this surface (sRGB)
 * @param {boolean} [opts.drawnShadow]  Accepted and ignored - see the header.
 *   The shared dummy scene asks for it on the ground; C gets drawn cast shadows
 *   on every surface for free, because tone is read from the lit result.
 * @param {number} [opts.side]
 */
export function createSketchMaterial({
  color = 0xffffff,
  drawnShadow = false, // eslint-disable-line no-unused-vars
  side = THREE.FrontSide,
} = {}) {
  // White base, matte. The Blender group feeds a greyscale `Brightness` into the
  // Principled BSDF for the same reason: it wants `Shader to RGB` to hand back
  // LIGHT, not light times albedo. The surface's own colour is applied at the
  // end instead, so it tints the paper without skewing the tone ramp. Roughness
  // 1 / metalness 0 keeps a specular hotspot from reading as a highlight the
  // marks would then have to explain.
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    side,
  });
  material.colorNode = vec3(1.0);

  const u = sketchUniforms;
  const sheets = getMarkSheets();

  // --- Texture Flicker: one global offset per stop-motion tick ---
  //
  // Worth knowing, because it is not obvious from the node tree: the noise
  // textures in the Blender group have NOTHING plugged into their Vector input.
  // Only `W` is driven, by the clock. So the noise is a walk in time alone and
  // the offset is the SAME for every pixel on screen - the whole sheet slides as
  // one rigid piece. It is not a per-pixel distortion, and it must not be:
  // displacing the sheet locally would smear the strokes.
  const tick = time.mul(u.flickerSpeed).floor();

  // PINGPONG: fold the ever-climbing tick into a triangle wave.
  const span = u.flickerCycle;
  const pong = span.sub(tick.mod(span.mul(2.0)).sub(span).abs());

  // Three octaves, as in the group - one alone is too regular to read as a hand.
  const walk = (seed) =>
    mx_noise_float(vec3(float(seed), float(seed * 1.7), pong));
  const flicker = vec2(
    walk(11.3).add(walk(31.7).mul(0.5)).add(walk(57.1).mul(0.25)),
    walk(83.9).add(walk(97.3).mul(0.5)).add(walk(113.7).mul(0.25)),
  ).mul(u.flickerAmount);

  // --- Aspect Ratio Scaling ---
  //
  // screenUV is 0..1 on both axes whatever shape the pane is, so sampling it
  // directly stretches every mark with the window. Multiplying x by the aspect
  // makes the coordinate square, which is all the Blender group's
  // resolution-divide is doing. Centred first so resizing scales about the
  // middle of the frame rather than sliding the sheet from a corner.
  const aspect = screenSize.x.div(screenSize.y);
  const coord = screenUV
    .sub(0.5)
    .mul(vec2(aspect, 1.0))
    .mul(u.markScale)
    .add(flicker);

  const sheetA = texture(sheets.a, coord);
  const sheetB = texture(sheets.b, coord);
  const markValue = pickStyle(u.style, [
    sheetA.r,
    sheetA.g,
    sheetA.b,
    sheetB.r,
    sheetB.g,
    sheetB.b,
  ]);

  // --- Shader to RGB ---
  // `output` is the finished lit pixel. Because colorNode is white, this is the
  // lighting on its own - key, ambient and the cast-shadow term together.
  const lit = dot(output.rgb, vec3(0.2126, 0.7152, 0.0722));
  const tone = smoothstep(u.toneBlack, u.toneWhite, lit);

  // --- Bands Sharpness ---
  // Quantise tone into `bands` steps. Sharpness controls how abruptly one step
  // gives way to the next: a smoothstep across the fractional part, whose width
  // collapses to nothing at sharpness 1 (hard posterise) and opens to the full
  // step at 0 (no banding, a plain ramp).
  const scaled = tone.mul(u.bands);
  const lower = scaled.floor();
  const softness = u.bandSharpness.oneMinus().mul(0.5).max(0.0005);
  const stepped = smoothstep(
    float(0.5).sub(softness),
    float(0.5).add(softness),
    scaled.sub(lower),
  );
  const banded = lower.add(stepped).div(u.bands).clamp(0, 1);

  // --- The threshold ---
  // The sheet stores rank: 0 is the first stroke drawn, 1 is bare paper. Invert
  // it so `inkAmount` is "how early was this stroke", then show every stroke
  // earlier than the current tone.
  //
  // The range is nudged just past 0..1 at both ends. Without that, a fully lit
  // surface still passes its darkest strokes (the test lands exactly on the
  // boundary) and a fully dark one never quite reaches solid.
  const inkAmount = markValue.oneMinus();
  const threshold = mix(float(-0.03), float(1.03), banded);
  const shown = smoothstep(
    threshold.sub(u.markSoftness),
    threshold.add(u.markSoftness),
    inkAmount,
  ).mul(u.inkStrength);

  // --- Composite ---
  const paper = tslColor(color);
  const shaded = paper.mul(mix(float(1.0), banded.mul(0.45).add(0.55), u.shadeAmount));

  material.outputNode = vec4(mix(shaded, u.inkColor, shown), output.a);

  return material;
}

export { MARK_STYLES };
