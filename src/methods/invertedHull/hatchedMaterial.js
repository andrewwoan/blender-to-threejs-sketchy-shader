import * as THREE from "three/webgpu";
import {
  uv,
  vec3,
  float,
  uniform,
  time,
  texture,
  dot,
  transformNormalToView,
  normalView,
  smoothstep,
  normalize,
  select,
  mix,
  max,
  length,
  positionLocal,
  mx_noise_float,
  color as tslColor,
} from "three/tsl";
import { getCrosshatchTexture } from "../../textures/crosshatch.js";

/**
 * METHOD A - hatching as a shadow-masked multiply, boiled by permuting channels.
 *
 * The idea in one line: work out how lit the surface is, turn that into a 0..1
 * "how much of this is in shadow" mask, and multiply the albedo down by the
 * hatch sheet in proportion to that mask.
 *
 *     albedo * (1 - (1 - hatch) * shadowMask * strength)
 *
 * So the strokes only ever DARKEN, and only where the surface is already turning
 * away from the light. Lit areas stay untouched paper regardless of what the
 * sheet says there.
 *
 * The boil - the frame-to-frame redraw of hand-inked animation - comes from
 * cycling which CHANNEL of the sheet is read. Each channel is an independently
 * drawn set of strokes, so stepping R -> G -> B on a slow clock swaps the whole
 * drawing for a different drawing of the same thing. That is exactly what an
 * animator flipping between three inked cels produces, and it is why the three
 * channels first get normalised against each other: if they do not sit at the
 * same average tone, the cycle reads as a brightness flicker instead of a
 * redraw. Hence the per-channel balance/contrast below.
 *
 * The trade: strokes are locked to the mesh UVs, so they swim with the surface
 * as it turns, and on-screen stroke density depends on how the model was
 * unwrapped. Compare method B, which pays for screen-stable strokes by giving up
 * this direct control.
 */

/** Shared across every material, so one GUI drives the whole scene. */
export const hatchUniforms = {
  hatchScale: uniform(4.0),
  hatchStrength: uniform(0.85),
  // Where along the lighting ramp the hatching takes over, and how abruptly.
  shadowThreshold: uniform(0.78),
  shadowSoftness: uniform(0.3),
  // Channel swaps per second. This is the boil.
  permuteSpeed: uniform(2.0),
  // Per-channel normalisation. These numbers are a property of YOUR sheet, not
  // of the technique - retune them if you swap the texture. The goal is that all
  // three channels read at the same average tone, so the permute is a redraw and
  // not a flicker.
  channelBalanceR: uniform(0.72),
  channelBalanceG: uniform(1.0),
  channelBalanceB: uniform(2.0),
  channelContrastR: uniform(1.45),
  channelContrastG: uniform(1.0),
  channelContrastB: uniform(1.0),
  // World-space direction pointing FROM the surface TO the light. The pane keeps
  // this in sync with the real directional light.
  lightDirectionWorld: uniform(vec3(0.5, 1.0, 0.3)),
};

/**
 * The scene's crosshatch strokes as a single 0..1 value: the sheet sampled at
 * `uvNode`, each channel normalised by its own balance/contrast, then cycled per
 * tick so the strokes boil like re-drawn ink.
 *
 * Exported on its own because anything else painting ink into the same scene has
 * to boil in lockstep - sampling the sheet independently gives a pattern that
 * sits still, or worse flashes, against everything around it.
 */
export function boiledHatchStrokes(uvNode) {
  const hatchSample = texture(getCrosshatchTexture(), uvNode);

  // Scale the channel, then stretch it about its midpoint. Balance moves the
  // average tone; contrast changes how hard the strokes read.
  const adjust = (channel, balance, contrast) =>
    channel.mul(balance).sub(0.5).mul(contrast).add(0.5);

  const balancedR = adjust(
    hatchSample.r,
    hatchUniforms.channelBalanceR,
    hatchUniforms.channelContrastR,
  );
  const balancedG = adjust(
    hatchSample.g,
    hatchUniforms.channelBalanceG,
    hatchUniforms.channelContrastG,
  );
  const balancedB = adjust(
    hatchSample.b,
    hatchUniforms.channelBalanceB,
    hatchUniforms.channelContrastB,
  );

  // floor() is the whole stop-motion trick: the clock advances continuously but
  // the drawing only changes on integer ticks, so each pose is HELD.
  const tick = time.mul(hatchUniforms.permuteSpeed).floor();
  const channelIndex = tick.mod(3.0);

  return select(
    channelIndex.lessThan(0.5),
    balancedR,
    select(channelIndex.lessThan(1.5), balancedG, balancedB),
  );
}

/**
 * Build a hatched MeshStandardNodeMaterial.
 *
 * @param {object} opts
 * @param {THREE.Color|number} [opts.color]  base tint (sRGB)
 * @param {THREE.Texture} [opts.map]  optional albedo map
 * @param {number} [opts.reveal]  0 = grayscale, 1 = full colour. Lands on
 *   `material.userData.uReveal` so callers can tween it.
 * @param {boolean} [opts.fluidReveal]  Adds a localised "ink bleed" reveal:
 *   colour floods in around a moving point behind a soft, noisy, BOILING edge.
 *   Exposes `material.userData.uRevealCenter` (vec3, object-local) and
 *   `material.userData.uRevealRadius` (float) for the caller to drive.
 * @param {number} [opts.revealSoftness]   width of the patch's soft edge
 * @param {number} [opts.revealNoise]      how much the edge breaks up
 * @param {number} [opts.revealBoilSpeed]  steps/sec the edge boils
 */
export function createHatchedMaterial({
  color = 0xffffff,
  map = null,
  reveal = 1,
  fluidReveal = false,
  revealSoftness = 0.12,
  revealNoise = 0.16,
  revealBoilSpeed = 8,
} = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ color, map });

  // --- Lighting ---
  // The light direction is authored in world space (it is a fact about the
  // scene), but `normalView` is in view space, so bring the direction across
  // rather than the normal - one transform on a uniform instead of one per
  // fragment.
  const lightDirView = normalize(
    transformNormalToView(hatchUniforms.lightDirectionWorld),
  );
  const lighting = dot(normalView, lightDirView).clamp(0, 1);

  // Note the reversed edge order: this ramps 0 -> 1 as `lighting` FALLS, so the
  // mask says "how much shadow is here", not "how much light".
  const shadowMask = smoothstep(
    hatchUniforms.shadowThreshold.add(hatchUniforms.shadowSoftness),
    hatchUniforms.shadowThreshold.sub(hatchUniforms.shadowSoftness),
    lighting,
  );

  // --- The strokes ---
  const hatchValue = boiledHatchStrokes(uv().mul(hatchUniforms.hatchScale));

  const hatchDarkness = float(1.0).sub(hatchValue);
  const hatchEffect = hatchDarkness
    .mul(shadowMask)
    .mul(hatchUniforms.hatchStrength);

  // --- Albedo, in the right colour space ---
  // tslColor() does the sRGB -> linear conversion for hex numbers and
  // THREE.Color alike; texture() does it from the map's own colorSpace.
  const tint = tslColor(color);
  const albedo = map ? texture(map).rgb.mul(tint) : tint;

  const colored = albedo.mul(float(1.0).sub(hatchEffect));
  const lum = dot(colored, vec3(0.2126, 0.7152, 0.0722));
  const gray = vec3(lum, lum, lum);

  const uReveal = uniform(reveal);
  material.userData.uReveal = uReveal;
  let revealAmt = uReveal;

  if (fluidReveal) {
    // A patch of colour sits under a moving point in OBJECT-LOCAL space, so it
    // sticks to the surface as the mesh spins. Its edge is a soft smoothstep
    // pushed around by noise - and that noise is stepped in time, so the shape
    // jitters frame to frame like boiling ink rather than flowing like a liquid.
    const uRevealCenter = uniform(vec3(0, 0, 0));
    const uRevealRadius = uniform(0);
    const uRevealSoftness = uniform(revealSoftness);
    const uRevealNoise = uniform(revealNoise);
    const uBoilSpeed = uniform(revealBoilSpeed);
    material.userData.uRevealCenter = uRevealCenter;
    material.userData.uRevealRadius = uRevealRadius;
    material.userData.uRevealSoftness = uRevealSoftness;
    material.userData.uRevealNoise = uRevealNoise;
    material.userData.uRevealBoilSpeed = uBoilSpeed;

    const dist = length(positionLocal.sub(uRevealCenter));

    // Same floor() hold as the channel permute - one boil idea, two uses.
    const boil = time.mul(uBoilSpeed).floor();
    const p = positionLocal.mul(3.0).add(boil);
    const wobble = mx_noise_float(p);

    const edge = dist.add(wobble.mul(uRevealNoise));
    const fluidMask = smoothstep(
      uRevealRadius,
      uRevealRadius.sub(uRevealSoftness),
      edge,
    );

    revealAmt = max(uReveal, fluidMask);
  }

  material.colorNode = mix(gray, colored, revealAmt.clamp(0, 1));
  return material;
}
