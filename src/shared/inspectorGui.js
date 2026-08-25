import { Inspector } from "three/addons/inspector/Inspector.js";

/**
 * The three.js WebGPU Inspector, standing in for lil-gui.
 *
 * `inspector.createParameters()` hands back a group that already implements the
 * part of lil-gui's surface this codebase uses - `add`, `addColor`, `addFolder`,
 * `close`, and `.name()` / `.onChange()` on the returned controller - so every
 * `setupGUI()` here works unchanged and simply draws into the Inspector's
 * "Parameters" tab instead of a floating panel.
 *
 * Two behaviours are worth knowing, because both LOOK like they should break and
 * do not:
 *
 *  - `add(obj, prop, {label: value})` builds its <option> elements keyed by the
 *    LABEL, but `ValueSelect.getValue()` reads back through the options map, so
 *    `onChange` still receives the mapped value exactly as lil-gui delivers it.
 *  - `addColor` hands `onChange` a NUMBER where lil-gui hands a "#rrggbb"
 *    string. Every call site here feeds it straight to `THREE.Color.set()`,
 *    which takes either, so nothing needed changing. Worth remembering if a new
 *    control ever wants to parse that value as a string.
 *
 * What genuinely is missing is `onFinishChange`, which the Inspector does not
 * implement at all - chaining it throws and takes down whatever `setupGUI()` was
 * running, along with everything constructed after it. Nothing here calls it
 * today; the shim below is there so that adding a call later is not a
 * hard-to-place crash.
 */

/** Give a controller `onFinishChange`, firing live rather than on release. */
function shimController(controller) {
  if (controller && typeof controller.onFinishChange !== "function") {
    controller.onFinishChange = function (callback) {
      this.onChange(callback);
      return this;
    };
  }
  return controller;
}

/** Apply the shim to a group and, recursively, to every folder it creates. */
function wrapGroup(group) {
  const add = group.add.bind(group);
  const addColor = group.addColor.bind(group);
  const addFolder = group.addFolder.bind(group);

  group.add = (...args) => shimController(add(...args));
  group.addColor = (...args) => shimController(addColor(...args));
  group.addFolder = (...args) => wrapGroup(addFolder(...args));

  return group;
}

/**
 * Build the Inspector to hang on a renderer.
 *
 * This has to be assigned to `renderer.inspector` BEFORE `renderer.init()`. The
 * renderer core calls `inspector.init()` exactly once, at the end of its own
 * init, and that call is what mounts the panel. Assign it afterwards and the
 * mount has already happened against the default no-op inspector, so the panel
 * never appears - with no error to explain why.
 */
export function createInspector() {
  return new Inspector();
}

/**
 * After `renderer.init()`: mount the panel somewhere it is not clipped, and
 * return a lil-gui-compatible group to draw controls into.
 */
export function createInspectorGui(renderer, title) {
  const panel = renderer.inspector.domElement;

  // The Inspector appends itself to `renderer.domElement.parentElement`, which
  // here is the `.pane` section - and that carries `overflow: hidden` to keep
  // the canvas and its label inside their column. The panel would be cut off at
  // the pane's edge, so it is re-parented to the body. Appending an element that
  // already has a parent moves it, so this is a relocation rather than a
  // duplicate.
  if (panel && panel.parentElement !== document.body) {
    document.body.appendChild(panel);
  }

  return wrapGroup(renderer.inspector.createParameters(title));
}
