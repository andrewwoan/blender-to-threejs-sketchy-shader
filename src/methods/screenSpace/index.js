import {
  createDummyScene,
  createLighting,
  syncLightDirection,
} from "../../shared/dummyScene.js";
import { createPaperGrade } from "../../shared/paperGrade.js";
import { createHatchedMaterial, hatchUniforms } from "./hatchedMaterial.js";
import { createOutlinePipeline } from "./outlinePipeline.js";

/**
 * Pane B. Same dummy objects, same lights, same paper grade as pane A - the only
 * difference is the material and the fact that the outline is a post-process
 * rather than geometry.
 *
 * Note what is NOT here: no per-mesh setup for the outline at all. Every object
 * in the scene is inked simply by being in it, which is the practical reason to
 * reach for this method on a scene with a lot of geometry in it.
 */
export function buildScreenSpacePane({ pane, camera, gui }) {
  const world = createDummyScene({
    makeMaterial: (opts = {}) => createHatchedMaterial(opts),
  });
  const lighting = createLighting(world.scene);
  syncLightDirection(lighting.key, hatchUniforms.lightDirectionWorld);

  const grade = createPaperGrade();

  const outline = createOutlinePipeline({
    scene: world.scene,
    camera,
    sizes: { width: pane.width, height: pane.height },
    grade,
  });

  const state = { debugView: 0 };

  setupHatchGUI(gui);
  setupOutlineGUI(gui, outline, state, pane);

  return {
    scene: world.scene,
    lighting,
    // The hatch shades off its own light-direction uniform rather than the real
    // light, so moving the light has to push the new direction across.
    syncLight: () => {
      syncLightDirection(lighting.key, hatchUniforms.lightDirectionWorld);
      // The directional falloff measures from here, so dragging the target
      // gizmo drags the point the shadow fades away from.
      hatchUniforms.shadowAnchor.value.copy(lighting.key.target.position);
    },
    output: outline.output,
    resize: (width, height) => {
      grade.setAspect(width, height);
      outline.setResolution(width, height);
    },
    update: (delta) => world.update(delta),
  };
}

function setupHatchGUI(gui) {
  const folder = gui.addFolder("B - Hatching (tone stops)");

  const params = {
    hatchScale: hatchUniforms.hatchScale.value,
    boilSpeed: hatchUniforms.boilSpeed.value,
    boilFrames: hatchUniforms.boilFrames.value,
    boilAmount: hatchUniforms.boilAmount.value,
    boilRotate: hatchUniforms.boilRotate.value,
    shadowHatch: hatchUniforms.shadowHatch.value,
    shadowDepth: hatchUniforms.shadowDepth.value,
    shadowScale: hatchUniforms.shadowScale.value,
    shadowFalloffStart: hatchUniforms.shadowFalloffStart.value,
    shadowFalloffLength: hatchUniforms.shadowFalloffLength.value,
    shadowFadeStart: hatchUniforms.shadowFadeStart.value,
    shadowFadeEnd: hatchUniforms.shadowFadeEnd.value,
    shadowEdgeBreak: hatchUniforms.shadowEdgeBreak.value,
    shadowEdgeScale: hatchUniforms.shadowEdgeScale.value,
    shadowTone: hatchUniforms.shadowTone.value,
  };

  const bind = (key, uniformNode, min, max, step, label) =>
    folder
      .add(params, key, min, max, step)
      .name(label)
      .onChange((v) => {
        uniformNode.value = v;
      });

  bind("hatchScale", hatchUniforms.hatchScale, 0.5, 24, 0.1, "uv tiling");
  bind("boilSpeed", hatchUniforms.boilSpeed, 0, 24, 0.5, "boil (steps/sec)");
  bind("boilFrames", hatchUniforms.boilFrames, 0, 24, 1, "pose cycle (0 = endless)");
  bind("boilAmount", hatchUniforms.boilAmount, 0, 1, 0.005, "boil uv hop");
  bind("boilRotate", hatchUniforms.boilRotate, 0, 0.5, 0.005, "boil twist");
  bind("shadowHatch", hatchUniforms.shadowHatch, 0, 1, 0.01, "cast shadow: drawn");
  bind("shadowDepth", hatchUniforms.shadowDepth, 0, 1, 0.01, "cast shadow: depth");
  bind("shadowScale", hatchUniforms.shadowScale, 0.01, 0.5, 0.005, "cast shadow: stroke size");
  bind("shadowFalloffStart", hatchUniforms.shadowFalloffStart, 0, 5, 0.05, "light falloff: start");
  bind("shadowFalloffLength", hatchUniforms.shadowFalloffLength, 0.05, 10, 0.05, "light falloff: length");
  bind("shadowFadeStart", hatchUniforms.shadowFadeStart, 0, 1, 0.005, "cast shadow: fade start");
  bind("shadowFadeEnd", hatchUniforms.shadowFadeEnd, 0.01, 1, 0.005, "cast shadow: fade end");
  bind("shadowEdgeBreak", hatchUniforms.shadowEdgeBreak, 0, 1, 0.01, "cast shadow: edge break-up");
  bind("shadowEdgeScale", hatchUniforms.shadowEdgeScale, 1, 40, 0.5, "cast shadow: edge scale");
  bind("shadowTone", hatchUniforms.shadowTone, 0, 1, 0.01, "cast shadow: stop (G-B)");

  folder.close();
  return folder;
}

function setupOutlineGUI(gui, outline, state, pane) {
  const u = outline.uniforms;
  const folder = gui.addFolder("B - Outline (screen-space edges)");

  const params = {
    amount: u.outlineAmount.value,
    color: "#1a1410",
    thickness: u.thickness.value,
    normalEdges: u.normalEdgeStrength.value,
    depthEdges: u.depthEdgeStrength.value,
    silhouette: u.silhouetteStrength.value,
    threshold: u.edgeThreshold.value,
    softness: u.edgeSoftness.value,
    wobble: u.wobble.value,
    wobbleScale: u.wobbleScale.value,
    boilSpeed: u.boilSpeed.value,
    opacityVariation: u.opacityVariation.value,
    taper: u.taper.value,
    jerkAmount: u.jerkAmount.value,
    jerkThreshold: u.jerkThreshold.value,
  };

  const bind = (key, uniformNode, min, max, step, label) =>
    folder
      .add(params, key, min, max, step)
      .name(label)
      .onChange((v) => {
        uniformNode.value = v;
      });

  bind("amount", u.outlineAmount, 0, 1, 0.01, "ink amount");
  folder.addColor(params, "color").name("ink colour").onChange((v) => {
    u.outlineColor.value.set(v);
  });
  bind("thickness", u.thickness, 0, 20, 0.5, "thickness (px)");
  bind("normalEdges", u.normalEdgeStrength, 0, 3, 0.01, "crease edges");
  bind("depthEdges", u.depthEdgeStrength, 0, 3, 0.01, "depth edges");
  bind("silhouette", u.silhouetteStrength, 0, 3, 0.01, "object-id edges");
  bind("threshold", u.edgeThreshold, 0, 2, 0.01, "edge threshold");
  bind("softness", u.edgeSoftness, 0, 2, 0.01, "edge softness");

  const hand = folder.addFolder("hand");
  const bindHand = (key, uniformNode, min, max, step, label) =>
    hand
      .add(params, key, min, max, step)
      .name(label)
      .onChange((v) => {
        uniformNode.value = v;
      });

  bindHand("boilSpeed", u.boilSpeed, 0, 24, 0.5, "boil (steps/sec)");
  bindHand("wobble", u.wobble, 0, 12, 0.1, "wobble (px)");
  bindHand("wobbleScale", u.wobbleScale, 0.5, 30, 0.1, "wobble frequency");
  bindHand("jerkAmount", u.jerkAmount, 0, 30, 0.5, "jerk (px)");
  bindHand("jerkThreshold", u.jerkThreshold, 0, 1, 0.01, "jerk rarity");
  bindHand("taper", u.taper, 0, 1, 0.01, "taper");
  bindHand("opacityVariation", u.opacityVariation, 0, 1, 0.01, "running dry");

  // Swapping the pipeline's output node recompiles it, which is why this is a
  // debug control and not something to drive per frame.
  folder
    .add(state, "debugView", {
      composite: 0,
      "edge mask": 1,
      "view normals": 2,
      "object ids": 3,
    })
    .name("debug view")
    .onChange((v) => {
      pane.pipeline.outputNode = outline.debugViews[Number(v)];
      pane.pipeline.needsUpdate = true;
    });

  folder.close();
  return folder;
}
