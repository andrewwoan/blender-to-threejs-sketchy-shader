import * as THREE from "three/webgpu";
import {
  uv,
  vec2,
  vec3,
  float,
  uniform,
  time,
  texture,
  dot,
  cos,
  sin,
  step,
  transformNormalToView,
  normalView,
  normalize,
  mix,
  color as tslColor,
} from "three/tsl";
import { getCrosshatchTexture } from "../../textures/crosshatch.js";

/**
 * METHOD B - hatching as four TONE STOPS, boiled by walking the sheet around a
 * circle.
 *
 * Where method A treats the sheet as one greyscale pattern and multiplies it in
 * by a shadow mask, this treats the three channels as an ordered TONE RAMP:
 *
 *     white  ->  R (sparse)  ->  G (medium)  ->  B (dense)
 *
 * Lighting is remapped to t in 0..3 and the four stops are blended across it, so
 * the surface does not fade toward a hatch - it steps through progressively
 * denser drawings, the way an illustrator reaches for a denser hatch rather than
 * pressing harder. The result holds its blacks and its whites instead of turning
 * grey in the middle, which is the usual failure of the multiply approach.
 *
 * The boil is where the two methods differ most. Method A swaps channels, which
 * costs nothing but ties the boil rate to the tone ramp - you cannot re-draw
 * without also changing tone. Here the tone stops are fixed and the SAMPLING UV
 * moves instead: each stop-motion step hops one golden angle around a small
 * circle and twists the sheet slightly about the UV centre. Every step therefore
 * travels the same distance (constant brightness, no step reads as a hold) and
 * no two consecutive poses can land on top of each other, which is exactly the
 * failure mode of seeding the offset randomly - a repeat reads as a dropped
 * frame.
 *
 * The trade against method A: no per-channel normalisation is needed and the
 * boil rate is independent of everything else, but you lose the shadow-threshold
 * control, so where the ink starts is baked into the ramp rather than dialled.
 */

// Golden angle (rad). Successive multiples never repeat and never land near each
// other - the classic sunflower-seed spacing.
const GOLDEN_ANGLE = 2.39996322972865332;

/** Shared across every material, so one GUI drives the whole scene. */
export const hatchUniforms = {
  hatchScale: uniform(4.0), // how many times the sheet tiles across the UVs
  boilSpeed: uniform(6.0), // stop-motion steps per second
  boilFrames: uniform(0.0), // length of the pose cycle; 0 = endless (never repeats)
  boilAmount: uniform(0.15), // UV offset magnitude per step
  boilRotate: uniform(0.03), // radians of per-pose twist (0 = pure sliding)
  // World-space direction pointing FROM the surface TO the light.
  lightDirectionWorld: uniform(vec3(0.5, 1.0, 0.3)),
};

/**
 * Build a hatched MeshStandardNodeMaterial.
 *
 * @param {object} opts
 * @param {THREE.Color|number} [opts.color]  base tint (sRGB)
 * @param {THREE.Texture} [opts.map]  optional albedo map
 * @param {boolean} [opts.transparent]
 * @param {number}  [opts.alphaTest]
 * @param {number}  [opts.side]  DoubleSide switches the shading to absolute
 *   incidence - see the note by `lighting`.
 */
export function createHatchedMaterial({
  color = 0xffffff,
  map = null,
  transparent = false,
  alphaTest = 0,
  side = THREE.FrontSide,
} = {}) {
  const material = new THREE.MeshStandardNodeMaterial({
    color,
    map,
    transparent,
    alphaTest,
    side,
  });

  // --- The boil: one golden-angle step per stop-motion frame ---
  const frame = time.mul(hatchUniforms.boilSpeed).floor();
  // boilFrames > 0 wraps the walk into an N-pose cycle; 0 lets it run forever.
  // A finite cycle is what you want when the boil has to loop seamlessly (a
  // looping render, a GIF); endless is what you want on screen, because a short
  // cycle becomes recognisable and the eye starts predicting it.
  const cycle = hatchUniforms.boilFrames;
  const pose = mix(frame, frame.mod(cycle.max(1.0)), step(0.5, cycle));

  // Equal-length hop around a circle: every step moves the same distance, so no
  // two consecutive poses can coincide and no step reads as a hold.
  const angle = pose.mul(GOLDEN_ANGLE);
  const boilOffset = vec2(cos(angle), sin(angle)).mul(hatchUniforms.boilAmount);

  // A touch of per-pose twist, so each pose is a different drawing rather than
  // the same sheet slid around. Rotated about the UV centre BEFORE tiling, to
  // keep the displacement bounded.
  //
  // sin() also keeps the twist bounded - without it the angle accumulates into a
  // slow continuous spin instead of a per-pose wobble.
  const twist = sin(pose.mul(GOLDEN_ANGLE * 0.5)).mul(hatchUniforms.boilRotate);
  const tc = cos(twist);
  const ts = sin(twist);
  const centred = uv().sub(0.5);
  const twisted = vec2(
    centred.x.mul(tc).sub(centred.y.mul(ts)),
    centred.x.mul(ts).add(centred.y.mul(tc)),
  ).add(0.5);

  const hatchUV = twisted.mul(hatchUniforms.hatchScale).add(boilOffset);
  const tex = texture(getCrosshatchTexture(), hatchUV);

  // --- Tone by lighting ---
  const lightDirView = normalize(
    transformNormalToView(hatchUniforms.lightDirectionWorld),
  );

  // `normalView` already flips on back faces, which is correct for solid
  // geometry and wrong for a cutout: turning a card around negates the dot and
  // clamps it to 0, so the same drawing goes from lit to fully hatched purely
  // from which way its plane happens to point. A card has no back, so
  // double-sided materials shade off the ABSOLUTE angle - front and back then
  // read identically and a 180-degree turn no longer changes the tone.
  const incidence = dot(normalView, lightDirView);
  const lighting = (
    side === THREE.DoubleSide ? incidence.abs() : incidence
  ).clamp(0, 1);

  // t goes 0 (lit) -> 3 (dark). Blend across the four stops [white, R, G, B].
  // Each clamp isolates one segment of the ramp, so the stops chain rather than
  // all contributing at once.
  const t = lighting.oneMinus().mul(3.0);
  const stopR = mix(float(1.0), tex.r, t.clamp(0, 1));
  const stopG = mix(stopR, tex.g, t.sub(1.0).clamp(0, 1));
  const hatch = mix(stopG, tex.b, t.sub(2.0).clamp(0, 1));

  // tslColor() does the sRGB -> linear conversion for hex numbers and
  // THREE.Color alike; texture() does it from the map's own colorSpace.
  const tint = tslColor(color);
  const albedo = map ? texture(map).rgb.mul(tint) : tint;

  material.colorNode = albedo.mul(hatch);

  // Overriding colorNode means alpha no longer comes along for the ride, so a
  // cutout - a photo on a plane, carrying its silhouette in the map's alpha -
  // has to route it explicitly or it renders as an opaque rectangle.
  if (map && (transparent || alphaTest > 0)) {
    material.opacityNode = texture(map).a;
  }

  return material;
}
