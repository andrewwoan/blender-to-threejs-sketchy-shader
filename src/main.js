import "./style.css";
import { Pane } from "./shared/Pane.js";
import { linkOrbitControls } from "./shared/linkedOrbit.js";
import { createLightRig } from "./shared/lightRig.js";
import { createGovernor, QUALITY_LEVELS } from "./shared/governor.js";
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

/** Every pane, in order. The first one BUILT hosts the Inspector panel. */
const PANES = {
  a: {
    id: "#pane-a",
    build: ({ camera, gui }) => buildInvertedHullPane({ camera, gui }),
  },
  b: {
    id: "#pane-b",
    build: ({ camera, pane, gui }) => buildScreenSpacePane({ pane, camera, gui }),
  },
  c: {
    id: "#pane-c",
    build: ({ camera, pane, gui }) =>
      buildBlenderSketchPane({ pane, camera, gui }),
  },
  d: {
    id: "#pane-d",
    build: ({ camera, gui }) => buildObjectSpacePane({ camera, gui }),
  },
};

/**
 * Which panes to build.
 *
 * On a narrow screen, ONE - chosen by `?pane=`. Four panes means four renderers,
 * each with its own device, its own scene and its own post chain, and B and C
 * each render the scene twice on top of that. Desktop absorbs it; a phone does
 * not, and browsers cap simultaneous contexts more tightly there as well. So the
 * comparison collapses to one method at a time, with a switcher to move between
 * them.
 *
 * Decided once, at load, because the whole point is not to construct the other
 * three. Crossing the breakpoint by rotating the phone therefore does nothing
 * until a reload - which the switcher does anyway, since navigating to
 * `?pane=b` is the simplest possible teardown of a WebGPU device.
 *
 * The media query matches the CSS breakpoint, and that is deliberate: the layout
 * and the build have to agree about what "mobile" means.
 */
function selectPanes() {
  const keys = Object.keys(PANES);
  if (!window.matchMedia("(max-width: 64rem)").matches) return keys;

  const wanted = new URLSearchParams(window.location.search).get("pane");
  return [keys.includes(wanted) ? wanted : "a"];
}

/** Show the A/B/C/D switcher, and hide the panes that were never built. */
function setupMobileUI(active) {
  for (const [key, spec] of Object.entries(PANES)) {
    if (!active.includes(key)) document.querySelector(spec.id).hidden = true;
  }

  if (active.length > 1) return;

  const nav = document.getElementById("pane-switch");
  nav.hidden = false;
  nav
    .querySelector(`[data-pane="${active[0]}"]`)
    ?.setAttribute("aria-current", "page");
}

async function main() {
  const active = selectPanes();
  setupMobileUI(active);

  // Paint a notice before anything blocks.
  //
  // The crosshatch and mark sheets are drawn with the 2D canvas API on the main
  // thread - tens of thousands of paths - and nothing can be shown while that
  // runs. Two frames, not one: the first only queues the paint, and yielding
  // just once still blocks before the pixels land.
  const loading = document.getElementById("loading");
  loading.hidden = false;
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );

  // NOT a `navigator.gpu` check any more.
  //
  // `navigator.gpu` is `[SecureContext]`, so it is undefined over plain HTTP on
  // a LAN address however capable the browser is - which made this bail out on a
  // phone hitting the dev server, while reporting the browser as the problem.
  //
  // It was also unnecessary: WebGPURenderer installs its own `getFallback` and
  // quietly swaps in a WebGL2 backend when WebGPU is missing. So the only honest
  // test is whether a renderer actually comes up, and that is what the catch
  // below does. The banner now means "nothing could be initialised", not "this
  // browser lacks an API".
  if (!navigator.gpu) {
    console.info(
      "main: navigator.gpu is unavailable (needs HTTPS or localhost) - " +
        "three.js will fall back to a WebGL2 backend.",
    );
  }

  // The controls live in the three.js WebGPU Inspector's "Parameters" tab rather
  // than a standalone panel. The Inspector belongs to a RENDERER, so the first
  // pane built hosts the one panel and the rest draw into its group - the same
  // arrangement as the light gizmo. On mobile the single pane is the host.
  //
  // That is what forces the build-one-then-the-next loop: a pane's `build()`
  // runs inside its own `init()` and calls `setupGUI()` immediately, so the host
  // has to be fully initialised before the others can even be constructed.
  //
  // Initialising one at a time is also what you want regardless: every pane
  // compiles node materials on init, and four devices doing that at once on a
  // cold cache just contends.
  const panes = [];
  const built = [];
  let gui = null;

  try {
    for (const key of active) {
      const spec = PANES[key];
      const pane = new Pane({
        canvas: document.querySelector(`${spec.id} .pane__canvas`),
        inspector: panes.length === 0,
        gui,
        build: spec.build,
      });

      built.push(await pane.init());
      panes.push(pane);
      if (gui === null) gui = pane.gui;
    }
  } catch (error) {
    console.error("main: no renderer could be initialised", error);
    loading.hidden = true;
    document.getElementById("unsupported").hidden = false;
    return;
  }

  // Drag any pane; every camera follows.
  const orbit = linkOrbitControls(panes);

  // One light, one gizmo, every scene. Built after the orbit rig because the
  // gizmo has to be able to switch orbiting off while it is being dragged.
  const lightRig = createLightRig({
    panes,
    lightings: built.map((b) => b.lighting),
    syncs: built.map((b) => b.syncLight),
    orbit,
    gui,
  });

  setupShadowGUI(
    gui,
    built.map((b) => b.lighting),
  );

  // Degrade rather than die. See governor.js for why it only steps down.
  const governor = createGovernor((level) => {
    const { pixelRatio, solveHz } = QUALITY_LEVELS[level];
    for (const pane of panes) pane.setQualityScale(pixelRatio);
    for (const b of built) b.setQuality?.(solveHz);
  });

  setupPerformanceGUI(gui, governor);

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
  // The notice stays up until a frame has actually been DRAWN, not until the
  // panes are built. Node materials compile lazily on first render, and on a
  // phone that is the longest single stall in the whole startup - longer than
  // generating the sheets. Hiding the notice when init() returns handed the user
  // a blank white canvas for the duration and made it look like a hang.
  let painted = false;
  let previous = performance.now();

  panes[0].renderer.setAnimationLoop(() => {
    // Wall time BETWEEN frames, not the time spent inside one. That is what the
    // viewer experiences, and it is the only measure that catches a device the
    // OS has started throttling - the work per frame looks unchanged, the gaps
    // between them do not.
    const now = performance.now();
    const deltaMs = now - previous;
    previous = now;

    orbit.update();
    lightRig.update();
    for (const pane of panes) pane.render();

    governor.frame(deltaMs);

    if (!painted) {
      painted = true;
      loading.hidden = true;
    }
  });
}

/**
 * Read-out and manual override for the automatic quality ladder.
 *
 * `listen()` matters here: the governor changes the level on its own, and a
 * control that silently disagreed with what is actually being rendered would be
 * worse than no control at all.
 */
function setupPerformanceGUI(gui, governor) {
  const folder = gui.addFolder("Performance");

  const params = { level: governor.level };
  const options = Object.fromEntries(
    QUALITY_LEVELS.map((entry, i) => [entry.name, i]),
  );

  folder
    .add(params, "level", options)
    .name("quality")
    .listen()
    .onChange((v) => governor.setLevel(Number(v)));

  // Keep the control showing whatever the governor actually settled on.
  setInterval(() => {
    params.level = governor.level;
  }, 500);

  folder.close();
  return folder;
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
