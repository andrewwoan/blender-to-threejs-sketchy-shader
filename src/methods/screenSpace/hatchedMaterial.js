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
  smoothstep,
  transformNormalToView,
  normalView,
  positionWorld,
  normalize,
  length,
  max,
  mix,
  Fn,
  mx_noise_float,
  output,
  vec4,
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
  // How much of the CAST shadow is drawn rather than dimmed. 0 is the usual flat
  // darkened patch; 1 replaces it entirely with strokes.
  shadowHatch: uniform(0.9),
  // Where in the tone ramp a shadow sits: 0 = the middle stop (G), 1 = the
  // densest (B). Shadow is "further along the ramp" in this method...
  shadowTone: uniform(0.8),
  // ...except the ramp RUNS OUT at B. There is no stop denser than the densest
  // one, so the last of the darkening has to be a multiply.
  shadowDepth: uniform(1.0),
  // Cast-shadow stroke size, as a multiple of hatchScale. Coarse on purpose -
  // a minified, grazing-angle floor mip-averages surface-scale strokes into
  // exactly the flat patch this replaces.
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
 * @param {boolean} [opts.drawnShadow]  Draw cast shadows on this surface as
 *   hatching instead of dimming them. For shadow-receiving surfaces like a
 *   ground plane - see the note at the call site for why it is not the default.
 * @param {number}  [opts.side]  DoubleSide switches the shading to absolute
 *   incidence - see the note by `lighting`.
 */
export function createHatchedMaterial({
  color = 0xffffff,
  map = null,
  transparent = false,
  alphaTest = 0,
  drawnShadow = false,
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
    // The ramp above is driven by the surface's own angle to the light, so a flat
    // floor sits at one tone stop everywhere - nothing about it changes because
    // something is standing on it. The shadow arrives separately, as an
    // attenuation three multiplies in after colorNode, and left alone it can only
    // lay a flat grey patch over the drawing.
    //
    // `receivedShadowNode` is the hook, but not the place to do the work: a
    // texture() fetch inside it collapses to a constant however you sample it. So
    // it only CAPTURES the shadow term and hands back 1, and the darkening happens
    // in `outputNode`, in the ordinary fragment body where sampling behaves.
    //
    // In keeping with this method's idea, a shadow is not "the same drawing,
    // darker" - it is the same drawing at a DENSER STOP, so it reads the sheet's
    // G/B channels. It reuses the same twisted UV and boilOffset as the surface,
    // so the shadow re-draws on exactly the same beat.
    const shadowFactor = float(1).toVar();
    material.receivedShadowNode = Fn(([shadow]) => {
      // mulAssign, not assign: more than one shadow-casting light has to compound.
      shadowFactor.mulAssign(shadow);
      return float(1.0);
    });

    const shadowUV = twisted
      .mul(hatchUniforms.hatchScale)
      .mul(hatchUniforms.shadowScale)
      .add(boilOffset);
    const shadowTex = texture(getCrosshatchTexture(), shadowUV);
    const shadowStops = mix(shadowTex.g, shadowTex.b, hatchUniforms.shadowTone);


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
      vec3(uv().mul(hatchUniforms.shadowEdgeScale), pose.mul(0.25)),
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
      float(1.0).sub(shadowStops),
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
