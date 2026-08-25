import * as THREE from "three/webgpu";
import {
  uv,
  vec3,
  float,
  uniform,
  time,
  texture,
  dot,
  normalWorld,
  positionWorld,
  smoothstep,
  normalize,
  select,
  mix,
  max,
  length,
  positionLocal,
  mx_noise_float,
  Fn,
  output,
  vec4,
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
  // How much of the CAST shadow is drawn rather than dimmed. 0 reproduces the
  // usual flat darkened patch; 1 replaces it entirely with hatch strokes.
  shadowHatch: uniform(0.85),
  // How far the drawn shadow is pulled down. The sheet averages well above zero,
  // so without this the hatched shadow lands much LIGHTER than the flat one it
  // replaced and the objects stop sitting on the ground. Tuned so the two read
  // at about the same weight - flip `shadowHatch` between 0 and 1 to check.
  shadowDepth: uniform(1.0),
  // Cast-shadow stroke size, as a multiple of hatchScale. Coarse on purpose -
  // see the note by `shadowStrokes`.
  shadowScale: uniform(0.06),
  // --- Directional falloff, along the light's cast direction ---
  //
  // The penumbra field above fades a shadow at EVERY edge equally, because that
  // is all it knows: how near the boundary a fragment is. A drawn shadow does
  // not behave that way. It is heaviest where it meets the object and thins as
  // it runs AWAY from the light, so the fade wants to be a gradient along the
  // ground rather than a rim.
  //
  // Measured in world units from `shadowAnchor` along the flattened light
  // direction, so it is a real distance you can reason about, not a curve shape.
  shadowFalloffStart: uniform(0.35),
  shadowFalloffLength: uniform(2.4),
  // Where that distance is measured from. Kept in sync with the light's target,
  // so dragging the target gizmo moves the anchor with it.
  shadowAnchor: uniform(vec3(0, 0, 0)),
  // Where the fade starts and where it reaches full strength, measured on the
  // shadow-map's own falloff field.
  //
  // These exist because widening the penumbra alone does NOT give a wide fade.
  // VSM light-bleeds as its blur grows: past a modest radius the shadow does not
  // spread, it evaporates - the core never reaches full darkness any more. So the
  // usable part of the field is stretched back over the full range here, which
  // restores the contrast the blur cost and makes the fade's SPATIAL width a
  // control rather than a side effect.
  //
  // Widen the gap between them and more of the shadow is transition; close it up
  // and you get a hard edge. `fadeEnd` above the field's actual peak leaves the
  // whole shadow in fade, which is the "50% of it fades out" look.
  shadowFadeStart: uniform(0.02),
  shadowFadeEnd: uniform(0.35),
  // How much the shadow's boundary is broken up, and at what scale. Without this
  // the edge is a clean contour and gives the whole thing away as rendered.
  //
  // Scale is in cycles per UV unit, so it has to be read against the RECEIVER's
  // unwrap, not the world: too fine and the lumps land far below the size of the
  // shadow and average out into a smooth edge again.
  shadowEdgeBreak: uniform(0.38),
  shadowEdgeScale: uniform(3.5),
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
 * @param {boolean} [opts.drawnShadow]  Draw cast shadows on this surface as
 *   hatching instead of dimming them. For shadow-receiving surfaces like a
 *   ground plane - see the note at the call site for why it is not the default.
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
  drawnShadow = false,
  fluidReveal = false,
  revealSoftness = 0.12,
  revealNoise = 0.16,
  revealBoilSpeed = 8,
} = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ color, map });

  // --- Lighting ---
  // The light direction is authored in world space (it is a fact about the
  // scene), so the dot is taken against the world-space normal. Do NOT bring the
  // direction across with transformNormalToView: that helper expects an
  // OBJECT-space normal and applies modelNormalMatrix on the way, so handing it a
  // world vector rotates it by the model a second time. Both sides of the dot
  // then carry the same model rotation, a rotation preserves a dot product, and
  // the whole thing quietly collapses to dot(objectNormal, lightWorld) - shading
  // welded to the mesh. It still tracks the light correctly, which is what makes
  // it so easy to miss; what it stops tracking is the mesh's own rotation, so the
  // dark side rides around with the surface as it spins.
  const lightDirWorld = normalize(hatchUniforms.lightDirectionWorld);
  const lighting = dot(normalWorld, lightDirWorld).clamp(0, 1);

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

  // Only surfaces that RECEIVE a cast shadow as a drawn surface want this - in
  // practice, the ground. Left on for everything it does real damage:
  //
  //  - Bypassing the built-in multiply throws away each mesh's own
  //    self-shadowing, and hands it back as a flat multiply over the finished
  //    pixel, ambient included. Objects wash out.
  //  - The stroke and edge-noise scales are tuned against the RECEIVER's unwrap.
  //    What reads as fine hatching across a 48-unit ground plane lands on a
  //    1-unit cube as a couple of enormous blotches.
  //
  // So it is opt-in, and everything else keeps stock shadow behaviour.
  if (drawnShadow) {
    // --- The CAST shadow, drawn rather than dimmed ---
    //
    // Everything above shades the surface by its own angle to the light, which is
    // why a flat floor never hatches: its normal does not change just because
    // something is standing on it. The shadow arrives separately, as a light
    // attenuation three multiplies in AFTER colorNode, so by default it can only
    // darken the finished pixel uniformly - a flat grey patch over a drawing.
    //
    // An illustrator does not do that. A cast shadow is drawn, with the same
    // strokes as everything else.
    //
    // `receivedShadowNode` is the hook, but NOT the place to do the work: a
    // texture() fetch inside it resolves to a constant however you sample it, so
    // building the shadow there gets you a flat patch with extra steps. Plain
    // arithmetic on uv()/screenUV does vary there, which makes the failure easy to
    // miss - every knob still appears to respond, because the constant scales with
    // them.
    //
    // So the hook is used only to CAPTURE the shadow term into a var and hand back
    // 1, bypassing the built-in multiply. The actual darkening then happens in
    // `outputNode`, which runs in the ordinary fragment body where sampling works
    // normally - and the shadow gets the real sheet, boiling in lockstep with
    // every surface around it.
    //
    // One consequence worth knowing: the built-in multiply only attenuates the
    // light's own contribution, while this multiplies the finished pixel, ambient
    // included. That is closer to what ink does to paper, but it means `depth`
    // needs a different value than a stock shadow would.
    const shadowFactor = float(1).toVar();
    material.receivedShadowNode = Fn(([shadow]) => {
      // mulAssign, not assign: more than one shadow-casting light has to compound.
      shadowFactor.mulAssign(shadow);
      return float(1.0);
    });

    // Coarser than the surface hatch on purpose. A ground plane is minified hard
    // and seen at a grazing angle, so surface-scale strokes fall under a pixel and
    // the mip chain averages them straight back into the flat patch this replaces.
    const shadowStrokes = boiledHatchStrokes(
      uv().mul(hatchUniforms.hatchScale).mul(hatchUniforms.shadowScale),
    );

    // Same shape as the surface hatch above: ink darkness scaled by a strength.
    // shadowHatch crossfades between a flat patch and the drawn one.

    // How DEEP into the shadow this fragment sits: 1 in the core, easing to 0 at
    // the outer edge. This is the whole reason the renderer uses a blurred (VSM)
    // shadow map - a binary shadow is 0 or 1 and gives nothing to grade against.
    //
    // Two things come out of it, and both are what stops a cast shadow reading as
    // a rendered silhouette:
    //
    //   CONTACT - the shadow is darkest where it is deepest, which is under and
    //     right beside the object, and lightens as it runs away. Raising the field
    //     to a power holds the core while pulling the falloff in.
    //   RAGGED EDGE - a noise pushes the field around before the curve, so the
    //     boundary breaks up instead of being a clean contour. Because the noise
    //     moves the FIELD rather than the finished colour, strokes near the edge
    //     thin and drop out one by one, the way a pencil lifts.
    const depth = shadowFactor.oneMinus();

    // The noise is confined to the transition band. `depth * (1 - depth)` peaks
    // halfway through the falloff and is zero at both ends, so the core stays
    // solid and the lit side stays clean - only the edge is roughened.
    //
    // Applying the noise across the whole field instead makes the shading churn
    // over the entire shadow, which reads as the fade sliding around rather than
    // as a broken edge.
    const edgeBand = depth.mul(depth.oneMinus()).mul(4.0);

    // The boil axis is scaled DOWN so consecutive stop-motion ticks land close
    // together in the noise field. At full step each tick is uncorrelated and the
    // whole edge re-rolls, which reads as crawling; at a fraction of a step the
    // edge only shifts a little, the way a redrawn line does.
    const edgeNoise = mx_noise_float(
      vec3(uv().mul(hatchUniforms.shadowEdgeScale), time.mul(hatchUniforms.permuteSpeed).floor().mul(0.25)),
    )
      .mul(hatchUniforms.shadowEdgeBreak)
      .mul(edgeBand);

    const shadowField = smoothstep(
      hatchUniforms.shadowFadeStart,
      hatchUniforms.shadowFadeEnd,
      depth.add(edgeNoise),
    );


    // Distance along the ground, in the direction the shadow travels.
    //
    // `lightDirectionWorld` points from the surface TOWARD the light, so
    // flattening out its vertical component and negating gives the way a shadow
    // is thrown. The length guard matters: a light straight overhead flattens to
    // a zero vector, and normalising that is a NaN that would blacken the frame.
    const toLight = normalize(hatchUniforms.lightDirectionWorld);
    const flat = vec3(toLight.x, 0.0, toLight.z);
    const cast = flat.div(max(length(flat), 0.0001)).negate();

    const along = dot(positionWorld.sub(hatchUniforms.shadowAnchor), cast);

    // 1 up to `start`, easing to 0 by `start + length`.
    const directional = smoothstep(
      hatchUniforms.shadowFalloffStart.add(hatchUniforms.shadowFalloffLength),
      hatchUniforms.shadowFalloffStart,
      along,
    );

    const shadowInkAmount = mix(
      float(1.0),
      float(1.0).sub(shadowStrokes),
      hatchUniforms.shadowHatch,
    )
      .mul(shadowField)
      .mul(directional)
      .mul(hatchUniforms.shadowDepth);

    const shadowTint = mix(
      float(1.0).sub(shadowInkAmount),
      float(1.0),
      shadowFactor,
    );

    material.outputNode = vec4(output.rgb.mul(shadowTint), output.a);
  }

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
