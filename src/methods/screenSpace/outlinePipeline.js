import * as THREE from "three/webgpu";
import {
  pass,
  mrt,
  screenUV,
  vec2,
  vec3,
  float,
  uniform,
  color,
  dot,
  smoothstep,
  mix,
  step,
  time,
  hash,
  normalView,
  modelPosition,
  directionToColor,
  colorToDirection,
  perspectiveDepthToViewZ,
  mx_noise_float,
} from "three/tsl";

/**
 * METHOD B - the outline as a POST-PROCESS: screen-space contour detection over
 * a depth + normal + object-id pre-pass. A rough analogue of Blender's Grease
 * Pencil Line Art with a Noise modifier on it.
 *
 * The scene is rendered twice. The first pass writes no colour at all - just
 * view-space normals and a per-object id into a multi-target buffer, plus the
 * depth it produces anyway. The edge detector then samples those buffers at four
 * neighbours around each pixel and inks wherever they disagree:
 *
 *   - a change of OBJECT ID  -> silhouettes, at any depth separation
 *   - a big DEPTH jump       -> the same, plus ground and backdrop transitions
 *   - a big NORMAL jump      -> creases and interior contours
 *
 * What this buys you over an inverted hull:
 *  - Interior contours. A torus knot passing in front of itself gets a line at
 *    the crossing, because the two surfaces differ in depth even though they are
 *    the same object. A hull structurally cannot draw this.
 *  - Uniform line width in PIXELS, everywhere, at any distance.
 *  - The line is a mask, so it can be modulated per pixel - which is what makes
 *    the taper and the running-dry transparency below possible at all.
 *
 * What it costs:
 *  - A whole extra scene pass and three buffers.
 *  - Transparent objects are excluded from the pre-pass (`transparent = false`),
 *    so anything blended writes no depth or normals there and the detector inks
 *    whatever is BEHIND it, straight through the object. The fix is to promote
 *    cutouts from alpha blending to alpha CLIPPING so they rejoin the pre-pass.
 *  - The line swims slightly under camera motion, because it is defined in
 *    screen space. Method A's does not.
 *
 * The boil here is a screen-space one: the sampling UV is displaced by noise on
 * a floor()'d clock, so the contour redraws itself a few times a second. Three
 * separate noises stack up into something that reads as a hand:
 *
 *   WOBBLE  - fine, high-frequency shimmer, a pixel or two.
 *   JERK    - occasional big lateral kicks, but only in patches where a
 *             low-frequency field spikes past a threshold. This is the "the hand
 *             slipped" bend, and it is what stops the line reading as a filter.
 *   INK     - a slow field that both FADES the line and THINS it in the same
 *             places, so faint segments are also narrow. Ink running dry does
 *             both at once; varying only opacity looks like a dissolve.
 */
export function createOutlinePipeline({ scene, camera, sizes, grade }) {
  const uniforms = {
    outlineColor: uniform(color(0x1a1410)), // dark brown ink, not pure black
    outlineAmount: uniform(1.0), // master on/off (0..1)

    // Explicit near/far for depth linearisation. The global cameraNear/cameraFar
    // nodes would resolve to the fullscreen quad's camera here, not the scene's.
    cameraNear: uniform(camera.near),
    cameraFar: uniform(camera.far),
    invResolution: uniform(new THREE.Vector2(1 / sizes.width, 1 / sizes.height)),

    thickness: uniform(3.0), // px between the sampled neighbours
    normalEdgeStrength: uniform(1.0), // weight of crease (normal) edges
    depthEdgeStrength: uniform(0.7), // weight of silhouette (depth) edges
    // Weight of the object-id silhouette: any boundary between two different
    // objects inks, however close in depth they are. 0 falls back to depth only.
    silhouetteStrength: uniform(1.0),
    edgeThreshold: uniform(0.4),
    edgeSoftness: uniform(0.2),

    wobble: uniform(2.0), // px of fine hand-drawn shimmer
    wobbleScale: uniform(3.0), // shimmer frequency
    boilSpeed: uniform(6.0), // steps/sec (stop-motion)
    opacityVariation: uniform(0.35), // 0 = solid line, 1 = fully varied
    opacityScale: uniform(18.1), // ink-noise frequency
    taper: uniform(0.55), // 0 = uniform width, 1 = full taper
    jerkAmount: uniform(7.5), // px of lateral displacement
    jerkScale: uniform(8.0), // region frequency (low = big, rare bends)
    jerkThreshold: uniform(0.15), // higher = rarer, sharper jerks
  };

  // ---- Pre-pass: view normals + object id (and the depth that comes with it)
  const prePass = pass(scene, camera);
  prePass.name = "Pre-Pass";
  // Transparent objects contribute nothing here - see the note in the header.
  prePass.transparent = false;

  // Per-object colour, hashed from the object's world origin.
  //
  // Depth alone cannot separate two surfaces standing almost in the same plane -
  // a cutout against the wall behind it, a box resting flat on the floor - so
  // the detector needs something that says "different object" outright.
  // `modelPosition` is a per-object uniform, so every fragment of one mesh
  // hashes to the same value and only boundaries BETWEEN meshes change it.
  //
  // Three channels make an accidental collision (two objects hashing alike,
  // which would silently drop the line between them) vanishingly unlikely.
  //
  // Scaled and biased before hashing: TSL's hash() starts with seed.toUint(),
  // which TRUNCATES rather than bitcasts. Raw metres would throw away every
  // difference under 1 unit - and a small scene would land every object on the
  // same id - while negative seeds are undefined as unsigned. x1000 keeps
  // millimetre separation, +4096 keeps it positive.
  const idSeed = modelPosition.mul(1000).add(4096);
  const objectId = vec3(
    hash(idSeed.dot(vec3(127.1, 311.7, 74.7))),
    hash(idSeed.dot(vec3(269.5, 183.3, 246.1))),
    hash(idSeed.dot(vec3(419.2, 371.9, 159.3))),
  );

  prePass.setMRT(
    mrt({
      output: directionToColor(normalView),
      id: objectId,
    }),
  );

  // 8-bit normals are plenty for edge detection, and the ids are only ever
  // compared for equality. Both are pure bandwidth saved.
  prePass.getTexture("output").type = THREE.UnsignedByteType;
  prePass.getTexture("id").type = THREE.UnsignedByteType;

  const depthTex = prePass.getTextureNode("depth");
  const normalTex = prePass.getTextureNode();
  const idTex = prePass.getTextureNode("id");

  // ---- Scene colour pass ----
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode();

  const edge = buildEdgeMask({ uniforms, depthTex, normalTex, idTex });

  // Grade first, then ink ON TOP. The line is ink laid on the finished drawing,
  // not a surface property that the paper multiply and contrast should touch.
  const graded = grade.grade(sceneColor);
  const inked = mix(
    graded,
    uniforms.outlineColor,
    edge.mul(uniforms.outlineAmount),
  );

  // Vignette last of all, over scene and ink alike - otherwise the line sits at
  // full strength on top of a darkened border and gives itself away as a layer.
  const output = grade.vignette(inked);

  return {
    output,
    uniforms,
    // Buffer views for the debug-view control. Which stage is empty tells you
    // where a missing line went: no ids means the pre-pass never wrote them, ids
    // but no edges means the comparison is the problem.
    debugViews: [output, vec3(edge), normalTex.rgb, idTex.rgb],
    setResolution: (width, height) => {
      uniforms.invResolution.value.set(1 / width, 1 / height);
    },
  };
}

function buildEdgeMask({ uniforms, depthTex, normalTex, idTex }) {
  const {
    invResolution,
    thickness,
    boilSpeed,
    wobble,
    wobbleScale,
    opacityScale,
    opacityVariation,
    taper,
    jerkAmount,
    jerkScale,
    jerkThreshold,
    cameraNear,
    cameraFar,
    normalEdgeStrength,
    depthEdgeStrength,
    silhouetteStrength,
    edgeThreshold,
    edgeSoftness,
  } = uniforms;

  // The stop-motion clock every hand-drawn noise below shares. Same floor() hold
  // as method A's channel permute - it is the single idea both methods' boils
  // are built on.
  const boil = time.mul(boilSpeed).floor();

  // Screen-space "ink" noise. Drives BOTH the running-dry transparency and the
  // taper, from one sample, so the line is thin exactly where it is faint.
  const inkNoise = mx_noise_float(
    vec3(screenUV.mul(opacityScale), boil.add(101.3)),
  )
    .mul(0.5)
    .add(0.5)
    .clamp(0, 1);

  // Fine hand-drawn wobble, holding per stop-motion step. Two independent noise
  // fields (offset seeds) so x and y are uncorrelated - one field used twice
  // would displace everything along the diagonal.
  const wob = vec2(
    mx_noise_float(vec3(screenUV.mul(wobbleScale), boil)),
    mx_noise_float(vec3(screenUV.mul(wobbleScale).add(31.7), boil)),
  ).mul(invResolution.mul(wobble));

  // Occasional jerk: a big lateral kick that only fires in patches where a
  // low-frequency field spikes past `jerkThreshold`. Evolves on a slower clock
  // than the shimmer, so a bend persists across a few poses instead of
  // flickering in and out.
  const jerkT = boil.mul(0.5);
  const jerkMask = smoothstep(
    jerkThreshold,
    float(1.0),
    mx_noise_float(vec3(screenUV.mul(jerkScale), jerkT.add(53.0))).abs(),
  );
  const jerkDir = vec2(
    mx_noise_float(vec3(screenUV.mul(jerkScale).add(11.0), jerkT)),
    mx_noise_float(vec3(screenUV.mul(jerkScale).add(23.0), jerkT)),
  );
  const jerk = jerkDir.mul(jerkMask).mul(invResolution.mul(jerkAmount));

  const baseUV = screenUV.add(wob).add(jerk);

  // Taper: shrink the neighbour distance where the ink fades. A narrower sample
  // stencil finds fewer disagreeing pixels, so the detected band is literally
  // thinner - the line tapers toward nothing exactly where it is vanishing.
  const taperFactor = mix(float(1.0), inkNoise, taper);
  const texel = invResolution.mul(thickness).mul(taperFactor);

  // .rgb, then normalize. Both matter:
  //
  //  - `.sample()` returns a vec4, and dot() on a vec4 silently includes ALPHA.
  //    Alpha is 1 across every pixel the pre-pass drew, so `1 - dot` becomes
  //    `-cos(angle)` - negative everywhere, strongest on flat surfaces, and it
  //    SUBTRACTS from the other two edge terms instead of adding creases. The
  //    symptom is that the crease slider does nothing, or erases silhouettes.
  //  - colorToDirection is just `c * 2 - 1`. Where the pre-pass drew nothing the
  //    buffer is 0, which decodes to (-1,-1,-1) - length 1.73, not 1 - and an
  //    un-normalised dot then overshoots into negatives at every silhouette.
  const sampleN = (uv) => colorToDirection(normalTex.sample(uv).rgb).normalize();
  const sampleD = (uv) =>
    perspectiveDepthToViewZ(depthTex.sample(uv).r, cameraNear, cameraFar);
  const sampleId = (uv) => idTex.sample(uv).rgb;

  const offL = vec2(-1, 0).mul(texel);
  const offR = vec2(1, 0).mul(texel);
  const offU = vec2(0, 1).mul(texel);
  const offD = vec2(0, -1).mul(texel);

  // Normal discontinuity - summed angular difference to the four neighbours.
  // 1 - dot() is 0 on a flat surface and grows with the crease angle.
  const nC = sampleN(baseUV);
  const nEdge = float(1)
    .sub(dot(nC, sampleN(baseUV.add(offL))))
    .add(float(1).sub(dot(nC, sampleN(baseUV.add(offR)))))
    .add(float(1).sub(dot(nC, sampleN(baseUV.add(offU)))))
    .add(float(1).sub(dot(nC, sampleN(baseUV.add(offD)))));

  // Depth discontinuity, divided by the centre depth so it is distance
  // invariant. Without that division a threshold tuned up close inks every
  // surface in the distance, because raw view-Z gaps grow with range.
  const dC = sampleD(baseUV);
  const dEdge = dC
    .sub(sampleD(baseUV.add(offL)))
    .abs()
    .add(dC.sub(sampleD(baseUV.add(offR))).abs())
    .add(dC.sub(sampleD(baseUV.add(offU))).abs())
    .add(dC.sub(sampleD(baseUV.add(offD))).abs())
    .div(dC.abs().add(0.001));

  // Object-id discontinuity - the silhouette depth can miss.
  //
  // Only inked on the NEAR side of the boundary: `step(sampleD(uv), dC)` is 1
  // where the centre sample sits in front of the neighbour (view-Z runs negative
  // away from the camera, so the nearer surface is the greater value). That
  // keeps the line on the object in FRONT, instead of drawing it twice - once
  // just inside each of the two objects, which reads as a double-struck line.
  const idC = sampleId(baseUV);
  const idEdge = (uv) =>
    step(0.02, idC.sub(sampleId(uv)).abs().length()).mul(step(sampleD(uv), dC));

  const silhouette = idEdge(baseUV.add(offL))
    .max(idEdge(baseUV.add(offR)))
    .max(idEdge(baseUV.add(offU)))
    .max(idEdge(baseUV.add(offD)));

  const edge = nEdge
    .mul(normalEdgeStrength)
    .add(dEdge.mul(depthEdgeStrength))
    .add(silhouette.mul(silhouetteStrength));

  const line = smoothstep(edgeThreshold, edgeThreshold.add(edgeSoftness), edge);

  // Running-dry transparency: the same ink noise that drove the taper.
  const opacity = mix(float(1.0), inkNoise, opacityVariation);

  return line.mul(opacity);
}
