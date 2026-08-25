import GUI from "lil-gui";
import "./style.css";
import { Pane } from "./shared/Pane.js";
import { linkOrbitControls } from "./shared/linkedOrbit.js";
import { createLightRig } from "./shared/lightRig.js";
import { buildInvertedHullPane } from "./methods/invertedHull/index.js";
import { buildScreenSpacePane } from "./methods/screenSpace/index.js";
import { buildBlenderSketchPane } from "./methods/blenderSketch/index.js";

/**
 * Three panes, three methods, one shared scene definition.
 *
 * Building the tone sheets happens lazily inside the materials, so the first
 * pane to compile pays for it and the rest get the cached textures. A and B
 * share crosshatch.js; C builds its own six-style set from markSheets.js.
 *
 * B and C deliberately share an outline, so the only thing that differs between
 * those two panes is the hatching.
 */
async function main() {
  if (!navigator.gpu) {
    document.getElementById("unsupported").hidden = false;
    return;
  }

  const gui = new GUI({ title: "hatch & outline lab" });

  const paneA = new Pane({
    canvas: document.querySelector("#pane-a .pane__canvas"),
    build: ({ camera }) => buildInvertedHullPane({ camera, gui }),
  });

  const paneB = new Pane({
    canvas: document.querySelector("#pane-b .pane__canvas"),
    build: ({ camera, pane }) => buildScreenSpacePane({ pane, camera, gui }),
  });

  const paneC = new Pane({
    canvas: document.querySelector("#pane-c .pane__canvas"),
    build: ({ camera, pane }) => buildBlenderSketchPane({ pane, camera, gui }),
  });

  // Sequential, not Promise.all: every pane compiles node materials on init, and
  // three WebGPU devices doing that at once on a cold cache just contends.
  const builtA = await paneA.init();
  const builtB = await paneB.init();
  const builtC = await paneC.init();

  const panes = [paneA, paneB, paneC];

  // Drag any pane; every camera follows.
  const orbit = linkOrbitControls(panes);

  // One light, one gizmo, every scene. Built after the orbit rig because the
  // gizmo has to be able to switch orbiting off while it is being dragged.
  const lightRig = createLightRig({
    panes,
    lightings: [builtA.lighting, builtB.lighting, builtC.lighting],
    syncs: [builtA.syncLight, builtB.syncLight, builtC.syncLight],
    orbit,
    gui,
  });

  setupShadowGUI(gui, [builtA.lighting, builtB.lighting, builtC.lighting]);

  const resize = () => {
    for (const pane of panes) {
      const { clientWidth, clientHeight } = pane.canvas;
      pane.resize(clientWidth, clientHeight);
    }
  };

  window.addEventListener("resize", resize);
  resize();

  // Both panes drive off the same rAF so the two boils stay in step. Running two
  // independent loops lets them drift apart, and a side-by-side comparison where
  // the halves redraw on different beats is much harder to read.
  const loop = () => {
    requestAnimationFrame(loop);
    orbit.update();
    lightRig.update();
    for (const pane of panes) pane.render();
  };

  loop();
}

/**
 * How far a cast shadow fades, driven for both panes at once.
 *
 * This lives on the LIGHT rather than in either method's material, because the
 * fade is read out of the blurred shadow map - it is not something a material
 * can widen on its own. Both panes have their own light and their own renderer,
 * so the control has to write to both or the comparison drifts apart.
 */
function setupShadowGUI(gui, lightings) {
  const folder = gui.addFolder("Shadow spread (both panes)");

  const params = {
    // In shadow-map texels. See createLighting for what that is worth in world
    // units - it is the map size and frustum that decide, not this number alone.
    spread: lightings[0].key.shadow.radius,
    samples: lightings[0].key.shadow.blurSamples,
  };

  folder
    .add(params, "spread", 1, 90, 1)
    .name("fade distance")
    .onChange((v) => {
      for (const { key } of lightings) key.shadow.radius = v;
    });

  folder
    .add(params, "samples", 4, 48, 1)
    .name("fade smoothness")
    .onChange((v) => {
      // Too few taps across a wide radius and the falloff bands into rings.
      for (const { key } of lightings) key.shadow.blurSamples = v;
    });

  folder.close();
  return folder;
}

main();
