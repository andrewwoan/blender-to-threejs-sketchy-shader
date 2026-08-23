import GUI from "lil-gui";
import "./style.css";
import { Pane } from "./shared/Pane.js";
import { linkOrbitControls } from "./shared/linkedOrbit.js";
import { buildInvertedHullPane } from "./methods/invertedHull/index.js";
import { buildScreenSpacePane } from "./methods/screenSpace/index.js";

/**
 * Two panes, two methods, one shared scene definition.
 *
 * Building the crosshatch sheet happens lazily inside the materials, so the
 * first pane to compile pays for it and the second gets the cached texture.
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

  // Sequential, not Promise.all: both panes compile node materials on init, and
  // two WebGPU devices doing that at once on a cold cache just contends.
  await paneA.init();
  await paneB.init();

  const panes = [paneA, paneB];

  // Drag either half; both cameras follow.
  const orbit = linkOrbitControls(panes);

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
    for (const pane of panes) pane.render();
  };

  loop();
}

main();
