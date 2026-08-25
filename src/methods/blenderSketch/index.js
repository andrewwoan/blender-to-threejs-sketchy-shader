import { createDummyScene, createLighting } from "../../shared/dummyScene.js";
import { createPaperGrade } from "../../shared/paperGrade.js";
import {
  createOutlinePipeline,
  // C's outline is B's outline, unmodified - see the note below.
} from "../screenSpace/outlinePipeline.js";
import { setupOutlineGUI } from "../screenSpace/index.js";
import {
  createSketchMaterial,
  sketchUniforms,
  MARK_STYLES,
} from "./sketchMaterial.js";

/**
 * Pane C. The Blender sketch-shader material, with method B's screen-space
 * outline bolted straight on.
 *
 * Reusing B's outline is the honest thing to do rather than a shortcut: in the
 * Blender file the line comes from a Grease Pencil LINE ART modifier, which is a
 * whole-scene contour extraction with uniform thickness and a stop-motion Noise
 * modifier on top. That is the same family as B's edge pass and nothing like an
 * inverted hull, so pairing C's hatching with B's outline reproduces the source
 * setup. It also isolates the comparison: A vs B is two outlines AND two
 * hatchings, while B vs C is the same outline and only the hatching differs.
 *
 * Note what is NOT here compared to the other two panes:
 *
 *  - No `syncLight`. A and B shade off a hand-authored light-direction uniform
 *    that has to be pushed across whenever the gizmo moves. C reads the real
 *    lit result, so the light rig needs to tell it nothing at all.
 *  - No occluder height map, and no `drawnShadow` plumbing. Cast shadows arrive
 *    inside the lighting C is already reading, so they turn into marks on their
 *    own. That is a genuine simplification and the main practical argument for
 *    this approach.
 */
export function buildBlenderSketchPane({ pane, camera, gui }) {
  const world = createDummyScene({
    makeMaterial: (opts = {}) => createSketchMaterial(opts),
  });
  const lighting = createLighting(world.scene);

  const grade = createPaperGrade();

  const outline = createOutlinePipeline({
    scene: world.scene,
    camera,
    sizes: { width: pane.width, height: pane.height },
    grade,
  });

  // C shares B's outline CODE but not its uniforms - createOutlinePipeline builds
  // a fresh set on every call - so the line weight can differ per pane without
  // one touching the other. Set before setupOutlineGUI, which seeds its controls
  // from whatever the uniforms hold.
  //
  // Sub-pixel on purpose. `thickness` is the distance between the four sampled
  // neighbours, so it is a line WIDTH in px, and C's marks are far finer than
  // B's tone stops - B's 3px contour sits over them as a border rather than as
  // something drawn alongside them.
  outline.uniforms.thickness.value = 0.5;

  // Heavier taper than B. The line is sub-pixel to begin with, so letting the
  // ink field pull the sample stencil in this far is what stops the remaining
  // segments reading as uniform-width dashes.
  outline.uniforms.taper.value = 0.76;

  // Pencil lifts. Off by default in the shared pipeline so B keeps its unbroken
  // contour; C opts in, because a line this fine only reads as drawn if it
  // sometimes stops. Half the contour is absent at any moment.
  //
  // Short nicks rather than long lifts: at this frequency the gaps land close
  // together and the contour comes out as a broken, searching line rather than
  // as a few long strokes with clean breaks between them. Paired with a low
  // softness so each break is decisive - a soft edge at this gap length just
  // fades the whole line out instead of cutting it.
  outline.uniforms.lineBreak.value = 0.5;
  outline.uniforms.lineBreakScale.value = 30.0;
  outline.uniforms.lineBreakSoftness.value = 0.065;

  const state = { debugView: 0 };

  setupSketchGUI(gui);
  setupOutlineGUI(gui, outline, state, pane, "C - Outline (screen-space edges)");

  return {
    scene: world.scene,
    lighting,
    // The light rig calls this on every pane after moving the gizmo. C has
    // nothing to publish - see the header - but the hook has to exist.
    syncLight: () => {},
    output: outline.output,
    resize: (width, height) => {
      grade.setAspect(width, height);
      outline.setResolution(width, height);
    },
    update: (delta) => {
      world.update(delta);
    },
  };
}

function setupSketchGUI(gui) {
  const folder = gui.addFolder("C - Sketch shader (Blender port)");

  const u = sketchUniforms;
  const params = {
    // Read from the uniform rather than repeating the number, so the control
    // cannot open showing a different style than the material is using.
    style: u.style.value,
    markScale: u.markScale.value,
    markSoftness: u.markSoftness.value,
    inkStrength: u.inkStrength.value,
    toneBlack: u.toneBlack.value,
    toneWhite: u.toneWhite.value,
    bands: u.bands.value,
    bandSharpness: u.bandSharpness.value,
    shadeAmount: u.shadeAmount.value,
    flickerSpeed: u.flickerSpeed.value,
    flickerAmount: u.flickerAmount.value,
    flickerCycle: u.flickerCycle.value,
    inkColor: "#1a1410",
  };

  const bind = (key, uniformNode, min, max, step, label) =>
    folder
      .add(params, key, min, max, step)
      .name(label)
      .onChange((v) => {
        uniformNode.value = v;
      });

  // All six sheets are sampled every fragment regardless, so switching styles is
  // a uniform write - no recompile, unlike the debug-view control below.
  folder
    .add(
      params,
      "style",
      Object.fromEntries(MARK_STYLES.map((name, i) => [name, i])),
    )
    .name("mark style")
    .onChange((v) => {
      u.style.value = Number(v);
    });

  bind("markScale", u.markScale, 1, 40, 0.25, "mark scale (screen)");
  // Range runs past the default deliberately: 0.3 turned out to be the useful
  // setting, and a control pinned to its own ceiling gives you nowhere to go.
  bind("markSoftness", u.markSoftness, 0, 0.6, 0.005, "stroke softness");
  bind("inkStrength", u.inkStrength, 0, 1, 0.01, "ink amount");
  folder.addColor(params, "inkColor").name("ink colour").onChange((v) => {
    u.inkColor.value.set(v);
  });

  const toneFolder = folder.addFolder("tone (shader to rgb)");
  const bindTone = (key, uniformNode, min, max, step, label) =>
    toneFolder
      .add(params, key, min, max, step)
      .name(label)
      .onChange((v) => {
        uniformNode.value = v;
      });

  bindTone("toneBlack", u.toneBlack, 0, 2, 0.01, "black point");
  bindTone("toneWhite", u.toneWhite, 0, 4, 0.01, "white point");
  bindTone("bands", u.bands, 1, 12, 1, "bands");
  bindTone("bandSharpness", u.bandSharpness, 0, 1, 0.01, "band sharpness");
  bindTone("shadeAmount", u.shadeAmount, 0, 1, 0.01, "paper shading");

  const flickerFolder = folder.addFolder("texture flicker");
  const bindFlicker = (key, uniformNode, min, max, step, label) =>
    flickerFolder
      .add(params, key, min, max, step)
      .name(label)
      .onChange((v) => {
        uniformNode.value = v;
      });

  bindFlicker("flickerSpeed", u.flickerSpeed, 0, 24, 0.5, "boil (steps/sec)");
  bindFlicker("flickerAmount", u.flickerAmount, 0, 0.15, 0.001, "flicker amount");
  bindFlicker("flickerCycle", u.flickerCycle, 1, 24, 1, "pingpong cycle");

  folder.close();
  return folder;
}
