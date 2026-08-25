import "./style.css";
import { Pane } from "./shared/Pane.js";
import { linkOrbitControls } from "./shared/linkedOrbit.js";
import { createLightRig } from "./shared/lightRig.js";
import { buildInvertedHullPane } from "./methods/invertedHull/index.js";
import { buildScreenSpacePane } from "./methods/screenSpace/index.js";
import { buildBlenderSketchPane } from "./methods/blenderSketch/index.js";
import { buildObjectSpacePane } from "./methods/objectSpace/index.js";

/**
 * Four panes, four methods, one shared scene definition.
 *
 * Building the tone sheets happens lazily inside the materials, so the first
 * pane to compile pays for it and the rest get the cached textures. A and B
 * share crosshatch.js; C and D share the six-style set from markSheets.js.
 *
 * The panes are arranged so that each adjacent pair isolates ONE variable:
 * B and C share an outline and differ only in the hatching, C and D share the
 * hatching and differ only in the outline. A is the odd one out, and is meant
 * to be - it is the technique the other three are being measured against.
 */
async function main() {
  if (!navigator.gpu) {
    document.getElementById("unsupported").hidden = false;
    return;
  }

  // The controls live in the three.js WebGPU Inspector's "Parameters" tab
  // rather than a standalone panel. The Inspector belongs to a RENDERER, and
  // there are four of them here, so pane A hosts the one panel and the rest draw
  // into its group - the same arrangement as the light gizmo.
  //
  // That is what forces the construct-then-init interleaving below: a pane's
  // `build()` runs inside its own `init()` and calls `setupGUI()` immediately,
  // so A has to be fully initialised before the others can even be constructed.
  //
  // Initialising one at a time is also what you want regardless: every pane
  // compiles node materials on init, and four WebGPU devices doing that at once
  // on a cold cache just contends.
  const paneA = new Pane({
    canvas: document.querySelector("#pane-a .pane__canvas"),
    inspector: true,
    build: ({ camera, gui }) => buildInvertedHullPane({ camera, gui }),
  });
  const builtA = await paneA.init();

  const gui = paneA.gui;

  const paneB = new Pane({
    canvas: document.querySelector("#pane-b .pane__canvas"),
    gui,
    build: ({ camera, pane, gui }) =>
      buildScreenSpacePane({ pane, camera, gui }),
  });
  const builtB = await paneB.init();

  const paneC = new Pane({
    canvas: document.querySelector("#pane-c .pane__canvas"),
    gui,
    build: ({ camera, pane, gui }) =>
      buildBlenderSketchPane({ pane, camera, gui }),
  });
  const builtC = await paneC.init();

  const paneD = new Pane({
    canvas: document.querySelector("#pane-d .pane__canvas"),
    gui,
    build: ({ camera, gui }) => buildObjectSpacePane({ camera, gui }),
  });
  const builtD = await paneD.init();

  const panes = [paneA, paneB, paneC, paneD];

  // Drag any pane; every camera follows.
  const orbit = linkOrbitControls(panes);

  // One light, one gizmo, every scene. Built after the orbit rig because the
  // gizmo has to be able to switch orbiting off while it is being dragged.
  const lightRig = createLightRig({
    panes,
    lightings: [
      builtA.lighting,
      builtB.lighting,
      builtC.lighting,
      builtD.lighting,
    ],
    syncs: [
      builtA.syncLight,
      builtB.syncLight,
      builtC.syncLight,
      builtD.syncLight,
    ],
    orbit,
    gui,
  });

  setupShadowGUI(gui, [
    builtA.lighting,
    builtB.lighting,
    builtC.lighting,
    builtD.lighting,
  ]);

  const resize = () => {
    for (const pane of panes) {
      const { clientWidth, clientHeight } = pane.canvas;
      pane.resize(clientWidth, clientHeight);
    }
  };

  window.addEventListener("resize", resize);
  resize();

  // Every pane drives off ONE loop so the boils stay in step. Four independent
  // loops let them drift apart, and a side-by-side comparison where the panes
  // redraw on different beats is much harder to read.
  //
  // That single loop is owned by pane A's RENDERER rather than a bare
  // requestAnimationFrame. The Inspector instruments per frame and only has a
  // frame scope to attach to inside the renderer's own animation loop - drive it
  // from rAF and it warns "Unable to inspect node outside of frame scope" and
  // its node inspection goes dark. Still one loop; it just belongs to the
  // renderer hosting the panel.
  paneA.renderer.setAnimationLoop(() => {
    orbit.update();
    lightRig.update();
    for (const pane of panes) pane.render();
  });
}

/**
 * How far a cast shadow fades, driven for every pane at once.
 *
 * This lives on the LIGHT rather than in either method's material, because the
 * fade is read out of the blurred shadow map - it is not something a material
 * can widen on its own. Every pane has its own light and its own renderer, so
 * the control has to write to all of them or the comparison drifts apart.
 */
function setupShadowGUI(gui, lightings) {
  const folder = gui.addFolder("Shadow spread (all panes)");

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
