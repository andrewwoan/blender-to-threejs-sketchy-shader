import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { createDummyScene, createLighting, syncLightDirection } from "../../shared/dummyScene.js";
import { createPaperGrade } from "../../shared/paperGrade.js";
import { createHatchedMaterial, hatchUniforms } from "./hatchedMaterial.js";
import { Outline } from "./outline.js";

/**
 * Pane A. Nothing here is the technique - it is the wiring that puts method A's
 * material on the dummy objects, hangs an inverted hull off each of them, and
 * runs the shared paper grade over the result.
 *
 * The post chain is deliberately minimal: one scene pass, then the grade. The
 * outline needed no help from post-processing at all, which is method A's whole
 * selling point.
 */
export function buildInvertedHullPane({ camera, gui }) {
  const world = createDummyScene({
    makeMaterial: (opts = {}) => createHatchedMaterial(opts),
  });
  const lighting = createLighting(world.scene);
  syncLightDirection(lighting.key, hatchUniforms.lightDirectionWorld);

  const outline = new Outline({ gui });

  // The ground is a single enormous quad. A hull around it would inflate to a
  // slab bigger than the frame and ink a border across the whole image, so it
  // opts out - exactly the case `userData.noOutline` exists for.
  world.ground.userData.noOutline = true;
  outline.apply(world.scene);

  // The ink-bleed reveal from hatchedMaterial.js, demonstrated on the sphere.
  // Two materials are built up front and swapped, rather than one being rebuilt
  // on toggle: node materials compile on first use, and doing that mid-frame
  // stutters.
  const sphere = world.meshes[2];
  const plainSphere = sphere.material;
  const bleedSphere = createHatchedMaterial({
    // A saturated colour, unlike the sphere's usual blue-grey, purely so the
    // effect is legible: the whole point is a patch of COLOUR appearing in a
    // grey drawing, and a desaturated base gives it nothing to show. Picked at
    // roughly mid luminance as well, so the grey it desaturates TO still matches
    // the sphere you were just looking at.
    color: 0xe08a4a,
    reveal: 0, // start fully grey, so the patch has something to reveal INTO
    fluidReveal: true,
  });

  const grade = createPaperGrade();

  const scenePass = pass(world.scene, camera);
  const output = grade.vignette(grade.grade(scenePass.getTextureNode()));

  const reveal = { enabled: false, radius: 0.55, orbit: true };
  const center = new THREE.Vector3();

  setupHatchGUI(gui);
  setupRevealGUI(gui, reveal, sphere, plainSphere, bleedSphere);

  return {
    scene: world.scene,
    output,
    resize: (width, height) => grade.setAspect(width, height),
    update: (delta, elapsed) => {
      world.update(delta);

      if (reveal.enabled) {
        const material = bleedSphere;
        // Walk the patch centre around the sphere's own local space so it slides
        // across the surface instead of tracking a point in the world.
        const t = reveal.orbit ? elapsed * 0.8 : 0;
        center.set(
          Math.cos(t) * 0.55,
          Math.sin(t * 0.7) * 0.4,
          Math.sin(t) * 0.55,
        );
        material.userData.uRevealCenter.value.copy(center);
        material.userData.uRevealRadius.value = reveal.radius;
      }
    },
  };
}

function setupHatchGUI(gui) {
  const folder = gui.addFolder("A - Hatching (shadow mask)");

  const params = {
    hatchScale: hatchUniforms.hatchScale.value,
    hatchStrength: hatchUniforms.hatchStrength.value,
    shadowThreshold: hatchUniforms.shadowThreshold.value,
    shadowSoftness: hatchUniforms.shadowSoftness.value,
    permuteSpeed: hatchUniforms.permuteSpeed.value,
    balanceR: hatchUniforms.channelBalanceR.value,
    balanceB: hatchUniforms.channelBalanceB.value,
    contrastR: hatchUniforms.channelContrastR.value,
  };

  const bind = (key, uniformNode, min, max, step, label) =>
    folder
      .add(params, key, min, max, step)
      .name(label)
      .onChange((v) => {
        uniformNode.value = v;
      });

  bind("hatchScale", hatchUniforms.hatchScale, 0.5, 24, 0.1, "uv tiling");
  bind("hatchStrength", hatchUniforms.hatchStrength, 0, 1, 0.01, "ink strength");
  bind("shadowThreshold", hatchUniforms.shadowThreshold, 0, 1, 0.01, "shadow start");
  bind("shadowSoftness", hatchUniforms.shadowSoftness, 0, 0.5, 0.005, "shadow softness");
  bind("permuteSpeed", hatchUniforms.permuteSpeed, 0, 24, 0.5, "boil (swaps/sec)");
  bind("balanceR", hatchUniforms.channelBalanceR, 0, 3, 0.01, "R balance");
  bind("balanceB", hatchUniforms.channelBalanceB, 0, 3, 0.01, "B balance");
  bind("contrastR", hatchUniforms.channelContrastR, 0, 3, 0.01, "R contrast");

  folder.close();
  return folder;
}

function setupRevealGUI(gui, reveal, sphere, plainMaterial, bleedMaterial) {
  const folder = gui.addFolder("A - Ink-bleed reveal (sphere)");

  folder
    .add(reveal, "enabled")
    .name("enabled")
    .onChange((v) => {
      sphere.material = v ? bleedMaterial : plainMaterial;
      if (!v) bleedMaterial.userData.uRevealRadius.value = 0;
    });
  folder.add(reveal, "radius", 0, 1.2, 0.01).name("patch radius");
  folder.add(reveal, "orbit").name("orbit the patch");
  folder
    .add({ noise: bleedMaterial.userData.uRevealNoise.value }, "noise", 0, 0.6, 0.005)
    .name("edge break-up")
    .onChange((v) => {
      bleedMaterial.userData.uRevealNoise.value = v;
    });
  folder
    .add({ boil: bleedMaterial.userData.uRevealBoilSpeed.value }, "boil", 0, 30, 1)
    .name("edge boil (steps/sec)")
    .onChange((v) => {
      bleedMaterial.userData.uRevealBoilSpeed.value = v;
    });

  folder.close();
  return folder;
}
